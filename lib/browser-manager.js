'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const { BrowserBridge } = require('./browser-bridge');
const {
  appendJsonLine,
  commandExists,
  sanitizeFilename,
  timestamp,
  uniquePath,
  writeJsonAtomic,
} = require('./utils');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

async function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function endpointResponds(port) {
  if (!Number.isInteger(Number(port))) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readActivePort(profileDirectory) {
  try {
    const content = await fsp.readFile(
      path.join(profileDirectory, 'DevToolsActivePort'),
      'utf8',
    );
    const port = Number(content.split(/\r?\n/, 1)[0]);
    return (await endpointResponds(port)) ? port : null;
  } catch {
    return null;
  }
}

async function discoverActiveBrowser(profileDirectory, manifest = {}) {
  const filePort = await readActivePort(profileDirectory);
  if (filePort) return { port: filePort, pid: null, source: 'devtools-active-port' };

  const candidatePorts = new Set();
  if (manifest.lastPort) candidatePorts.add(Number(manifest.lastPort));
  if (manifest.cdpUrl) {
    try {
      candidatePorts.add(Number(new URL(manifest.cdpUrl).port));
    } catch {
      // Ignore malformed historical metadata and continue with process discovery.
    }
  }
  for (const port of candidatePorts) {
    if (await endpointResponds(port)) {
      const pid = Number(manifest.lastPid);
      return {
        port,
        pid: Number.isInteger(pid) && pid > 1 ? pid : null,
        source: 'session-manifest',
      };
    }
  }

  try {
    const lockTarget = await fsp.readlink(path.join(profileDirectory, 'SingletonLock'));
    const pid = Number(lockTarget.match(/-(\d+)$/)?.[1]);
    if (!Number.isInteger(pid) || pid <= 1) return null;
    const commandLine = (
      await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')
    ).split('\u0000');
    const expectedProfile = `--user-data-dir=${profileDirectory}`;
    if (!commandLine.includes(expectedProfile)) return null;
    const portArgument = commandLine.find((argument) =>
      argument.startsWith('--remote-debugging-port='),
    );
    const port = Number(portArgument?.split('=', 2)[1]);
    if (await endpointResponds(port)) {
      return { port, pid, source: 'profile-singleton-process' };
    }
  } catch {
    // No live singleton means Chrome can safely start with this profile.
  }
  return null;
}

async function waitForEndpoint(port, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointResponds(port)) return;
    if (child?.exitCode !== null) {
      throw new Error(`Chrome exited before its debugging endpoint was ready (code ${child.exitCode}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Chrome debugging endpoint did not become ready on port ${port}.`);
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (path.isAbsolute(candidate)) {
      if (commandExists(candidate)) return candidate;
    } else if (commandExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'Google Chrome or Chromium was not found. Set CHROME_PATH to an executable browser path.',
  );
}

class BrowserManager {
  constructor(session, options = {}) {
    this.session = session;
    this.targetUrl = options.targetUrl;
    this.headless = Boolean(options.headless);
    this.chromePath = options.chromePath;
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.recoveredSession = Boolean(options.recoveredSession);
    this.sharedCookiesPath = options.sharedCookiesPath || null;
    this.onStateChange = options.onStateChange;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.child = null;
    this.port = null;
    this.pid = null;
    this.reusedRunningChrome = false;
    this.connectedAt = null;
    this.downloadPolicyEnforced = false;
    this.downloadCdp = null;
    this.pendingDownloads = new Map();
    this.bridge = null;
    this.eventLog = path.join(session.paths.logs, 'browser-events.jsonl');
    this.stdoutFd = null;
    this.stderrFd = null;
    this.stopping = false;
    this.attachedPages = new WeakSet();
    this.extensions = Array.isArray(options.extensions) ? options.extensions : [];
    this.workflowStore = options.workflowStore || null;
    this.browserHooks = new Map();
    for (const extension of this.extensions) {
      for (const hook of extension.browserHooks || []) {
        if (this.browserHooks.has(hook.name)) {
          throw new Error(`Duplicate browser hook: ${hook.name}`);
        }
        this.browserHooks.set(hook.name, { ...hook, extensionId: extension.id });
      }
    }
  }

  browserHookDescriptors() {
    return [...this.browserHooks.values()].map((hook) => ({
      name: hook.name,
      description: hook.description || '',
      inputHint: hook.inputHint || '',
      extensionId: hook.extensionId,
    }));
  }

  async invokeBrowserHook(name, payload = {}, runtime = {}) {
    const hook = this.browserHooks.get(String(name || ''));
    if (!hook) throw new Error(`Unknown browser extension hook: ${name || '(none)'}`);
    if (!this.browser?.isConnected() || !this.context) {
      throw new Error('The managed browser is not connected. Launch it before invoking an extension hook.');
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages().find((candidate) => !candidate.isClosed()) || null;
    }
    const startedAt = timestamp();
    try {
      const result = await hook.handler({
        browserManager: this,
        page: this.page,
        context: this.context,
        playwrightBrowser: this.browser,
        session: this.session,
        paths: this.session.paths,
        payload: payload && typeof payload === 'object' ? payload : {},
        agentDecision: typeof runtime.agentDecision === 'function'
          ? runtime.agentDecision
          : null,
        workflow: this.workflowStore,
      });
      await this.log('browser-extension-hook', {
        extensionId: hook.extensionId,
        name: hook.name,
        startedAt,
        completedAt: timestamp(),
        ok: true,
      });
      return result;
    } catch (error) {
      await this.log('browser-extension-hook', {
        extensionId: hook.extensionId,
        name: hook.name,
        startedAt,
        completedAt: timestamp(),
        ok: false,
        error: error.message,
      });
      throw error;
    }
  }

  async runExtensionLifecycle(event, details = {}) {
    const results = {};
    for (const extension of this.extensions) {
      const handler = extension.browserLifecycle?.[event];
      if (!handler) continue;
      try {
        const value = await handler({
          browserManager: this,
          page: this.page,
          context: this.context,
          playwrightBrowser: this.browser,
          session: this.session,
          paths: this.session.paths,
          targetUrl: this.targetUrl,
          workflow: this.workflowStore,
          ...details,
        });
        if (value !== undefined) results[extension.id] = value;
      } catch (error) {
        await this.log('browser-extension-lifecycle-error', {
          extensionId: extension.id,
          event,
          message: error.message,
        });
      }
    }
    return results;
  }

  async start(options = {}) {
    const startBridge = options.startBridge !== false;
    const activeBrowser = await discoverActiveBrowser(
      this.session.paths.browserProfile,
      this.session.manifest.browser,
    );
    const existingPort = activeBrowser?.port || null;
    this.reusedRunningChrome = Boolean(activeBrowser);
    this.port = existingPort || (await getFreePort());

    if (existingPort) {
      this.pid = activeBrowser.pid;
      await this.log('running-chrome-discovered', activeBrowser);
    } else {
      if (this.child) {
        if (this.child.exitCode === null) {
          this.child.kill('SIGKILL');
          await Promise.race([
            new Promise((resolve) => this.child.once('exit', resolve)),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
        }
        this.closeLogDescriptors();
        this.child = null;
      }
      await this.pruneProfileBloat('before-launch');
      await this.pruneComponentDownloads('before-launch');
      const executable = this.chromePath || findChrome();
      this.stdoutFd = fs.openSync(path.join(this.session.paths.logs, 'chrome.stdout.log'), 'a');
      this.stderrFd = fs.openSync(path.join(this.session.paths.logs, 'chrome.stderr.log'), 'a');
      const args = [
        `--remote-debugging-port=${this.port}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        `--user-data-dir=${this.session.paths.browserProfile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        // Session profiles are per-run; without these, Chrome downloads
        // gigabyte-scale on-device models and updatable components into every
        // profile and lets the HTTP cache grow without bound.
        '--disable-component-update',
        '--disable-features=OptimizationGuideModelDownloading,OptimizationHints,OptimizationTargetPrediction',
        '--disk-cache-size=104857600',
        '--new-window',
      ];
      if (this.headless) args.push('--headless=new');
      args.push('about:blank');

      this.child = spawn(executable, args, {
        cwd: this.session.directory,
        detached: false,
        stdio: ['ignore', this.stdoutFd, this.stderrFd],
        env: { ...process.env },
      });
      this.pid = this.child.pid;
      this.child.once('error', (error) => {
        void this.log('chrome-process-error', { message: error.message });
      });
      this.child.once('exit', (code, signal) => {
        void this.log('chrome-process-exit', { code, signal });
      });
      await waitForEndpoint(this.port, this.child);
    }

    const cdpUrl = `http://127.0.0.1:${this.port}`;
    this.browser = await chromium.connectOverCDP(cdpUrl);
    this.connectedAt = timestamp();
    this.browser.once('disconnected', () => {
      this.downloadPolicyEnforced = false;
      void this.log('playwright-disconnected', {});
    });
    this.context = this.browser.contexts()[0];
    if (!this.context) {
      throw new Error('Chrome exposed no default browser context over CDP.');
    }
    await this.configureDownloadBehavior();
    await this.importSharedCookies();
    this.context.setDefaultTimeout(30_000);
    this.context.on('page', (page) => this.attachPage(page));
    for (const page of this.context.pages()) this.attachPage(page);
    if (this.workflowStore) await this.workflowStore.attachBrowser(this.context);

    this.page =
      this.context.pages().find((page) => page.url() === this.targetUrl) ||
      this.context.pages().find((page) => page.url() === 'about:blank') ||
      this.context.pages()[0] ||
      (await this.context.newPage());

    try {
      if (this.page.url() !== this.targetUrl) {
        await this.page.goto(this.targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      }
    } catch (error) {
      await this.log('initial-navigation-error', {
        targetUrl: this.targetUrl,
        message: error.message,
      });
      // Chrome remains usable when a local development server starts after the launcher.
    }
    await this.page.bringToFront().catch(() => {});
    const extensionPageState = await this.runExtensionLifecycle('pageReady', { reason: 'start' });
    await this.log('playwright-connected', {
      cdpUrl,
      port: this.port,
      pid: this.pid,
      recoveredSession: this.recoveredSession,
      reusedRunningChrome: this.reusedRunningChrome,
      headless: this.headless,
      extensionPageState,
    });
    if (startBridge && !this.bridge) {
      this.bridge = new BrowserBridge(this, this.session);
      await this.bridge.start();
    }
    const state = await this.state();
    await this.notifyStateChange(state);
    return state;
  }

  async notifyStateChange(state) {
    if (this.onStateChange) await this.onStateChange(state, this.bridge);
  }

  closeLogDescriptors() {
    for (const key of ['stdoutFd', 'stderrFd']) {
      const fd = this[key];
      if (Number.isInteger(fd)) {
        try {
          fs.closeSync(fd);
        } catch {
          // The descriptor may already be closed after Chrome exits.
        }
      }
      this[key] = null;
    }
  }

  async resetDisconnectedBrowser() {
    if (this.downloadCdp) {
      await this.downloadCdp.detach().catch(() => {});
      this.downloadCdp = null;
    }
    if (this.child && this.child.exitCode === null && !(await endpointResponds(this.port))) {
      await Promise.race([
        new Promise((resolve) => this.child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      if (this.child.exitCode === null) {
        this.child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => this.child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
        if (this.child.exitCode === null) this.child.kill('SIGKILL');
      }
    }
    if (!this.child || this.child.exitCode !== null) {
      this.closeLogDescriptors();
      this.child = null;
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.downloadPolicyEnforced = false;
    this.pendingDownloads.clear();
    this.attachedPages = new WeakSet();
    this.port = null;
    this.pid = null;
    this.connectedAt = null;
    this.reusedRunningChrome = false;
  }

  async launch() {
    if (this.stopping) throw new Error('The service is shutting down and cannot launch Chrome.');

    if (this.browser?.isConnected()) {
      this.context = this.browser.contexts()[0] || this.context;
      if (!this.context) throw new Error('The connected browser has no Playwright context.');
      const pages = this.context.pages().filter((page) => !page.isClosed());
      const targetPage = pages.find((page) => page.url() === this.targetUrl);
      if (targetPage) this.page = targetPage;
      else this.page = null;
      if (!this.page) {
        this.page = await this.context.newPage();
        this.attachPage(this.page);
        try {
          await this.page.goto(this.targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
        } catch (error) {
          await this.log('gateway-navigation-error', {
            targetUrl: this.targetUrl,
            message: error.message,
          });
        }
      }
      await this.page.bringToFront().catch(() => {});
      await this.runExtensionLifecycle('pageReady', { reason: 'launch' });
      const state = await this.state();
      await this.log('browser-gateway-tab-ready', {
        activePageUrl: state.activePageUrl,
        pageCount: state.pageCount,
      });
      await this.notifyStateChange(state);
      return state;
    }

    await this.log('browser-gateway-relaunch-requested', {
      previousPort: this.port,
      previousPid: this.pid,
    });
    await this.resetDisconnectedBrowser();
    const state = await this.start({ startBridge: false });
    await this.log('browser-gateway-relaunched', {
      cdpUrl: state.cdpUrl,
      pid: state.pid,
      activePageUrl: state.activePageUrl,
      headless: state.headless,
    });
    return state;
  }

  attachPage(page) {
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    page.on('domcontentloaded', () => {
      void this.workflowStore?.render();
    });
    page.on('console', (message) => {
      void this.log('console', {
        pageUrl: page.url(),
        level: message.type(),
        text: message.text(),
      });
    });
    page.on('pageerror', (error) => {
      void this.log('page-error', { pageUrl: page.url(), message: error.message });
    });
    page.on('requestfailed', (request) => {
      void this.log('request-failed', {
        pageUrl: page.url(),
        method: request.method(),
        url: request.url(),
        failure: request.failure(),
      });
    });
    page.on('download', (download) => {
      void this.persistDownload(download, page);
    });
    page.on('close', () => {
      if (this.page === page) {
        this.page = this.context?.pages().find((candidate) => !candidate.isClosed()) || null;
      }
    });
  }

  async persistDownload(download, page) {
    const suggested = sanitizeFilename(download.suggestedFilename(), 'download');
    try {
      const failure = await download.failure();
      if (failure) throw new Error(failure);
      if (this.downloadPolicyEnforced) {
        await this.log('download-saved', {
          pageUrl: page.url(),
          sourceUrl: download.url(),
          suggestedFilename: suggested,
          method: 'service-cdp-policy-pending-finalization',
        });
        return;
      }

      const destination = await uniquePath(this.session.paths.downloads, suggested);
      await download.saveAs(destination);
      await this.log('download-saved', {
        pageUrl: page.url(),
        sourceUrl: download.url(),
        destination,
        method: 'playwright-fallback-copy',
      });
    } catch (error) {
      await this.log('download-error', {
        pageUrl: page.url(),
        sourceUrl: download.url(),
        message: error.message,
      });
    }
  }

  async log(type, details) {
    await appendJsonLine(this.eventLog, {
      timestamp: timestamp(),
      type,
      ...details,
    }).catch(() => {});
  }

  async configureDownloadBehavior() {
    try {
      this.downloadCdp = await this.browser.newBrowserCDPSession();
      this.downloadCdp.on('Browser.downloadWillBegin', (event) => {
        this.pendingDownloads.set(event.guid, {
          guid: event.guid,
          suggestedFilename: sanitizeFilename(event.suggestedFilename, 'download'),
          url: event.url,
          startedAt: timestamp(),
        });
        void this.log('download-started', {
          guid: event.guid,
          suggestedFilename: event.suggestedFilename,
          url: event.url,
        });
      });
      this.downloadCdp.on('Browser.downloadProgress', (event) => {
        if (event.state === 'completed') {
          void this.finalizeCdpDownload(event.guid, event);
        } else if (event.state === 'canceled') {
          const metadata = this.pendingDownloads.get(event.guid);
          this.pendingDownloads.delete(event.guid);
          void this.log('download-canceled', {
            guid: event.guid,
            url: metadata?.url,
            receivedBytes: event.receivedBytes,
          });
        }
      });
      await this.downloadCdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: this.session.paths.downloads,
        eventsEnabled: true,
      });
      this.downloadPolicyEnforced = true;
      await this.log('download-directory-configured', {
        destination: this.session.paths.downloads,
      });
    } catch (error) {
      this.downloadPolicyEnforced = false;
      await this.log('download-directory-configuration-error', {
        destination: this.session.paths.downloads,
        message: error.message,
      });
    }
    return this.downloadPolicyEnforced;
  }

  async finalizeCdpDownload(guid, progress) {
    const metadata = this.pendingDownloads.get(guid) || {
      guid,
      suggestedFilename: 'download',
      url: null,
      startedAt: null,
    };
    this.pendingDownloads.delete(guid);
    const source = path.join(this.session.paths.downloads, guid);
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await fsp.access(source);
          break;
        } catch (error) {
          if (error.code !== 'ENOENT' || attempt === 19) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      const destination = await uniquePath(
        this.session.paths.downloads,
        metadata.suggestedFilename,
      );
      await fsp.rename(source, destination);
      await this.log('download-finalized', {
        guid,
        sourceUrl: metadata.url,
        destination,
        totalBytes: progress.totalBytes,
        receivedBytes: progress.receivedBytes,
      });
    } catch (error) {
      await this.log('download-finalization-error', {
        guid,
        sourceUrl: metadata.url,
        source,
        message: error.message,
      });
    }
  }

  async state() {
    const connected = Boolean(this.browser?.isConnected());
    const pages = connected
      ? this.context?.pages().filter((page) => !page.isClosed()) || []
      : [];
    if (!this.page || this.page.isClosed()) this.page = pages[0] || null;
    let title = null;
    let targetId = null;
    if (this.page) {
      title = await this.page.title().catch(() => null);
      try {
        const cdp = await this.context.newCDPSession(this.page);
        const targetInfo = await cdp.send('Target.getTargetInfo');
        targetId = targetInfo.targetInfo?.targetId || null;
        await cdp.detach();
      } catch {
        targetId = null;
      }
    }
    return {
      connected,
      connectedAt: this.connectedAt,
      cdpUrl: connected && this.port ? `http://127.0.0.1:${this.port}` : null,
      port: connected ? this.port : null,
      pid: connected ? this.pid : null,
      lastKnownPort: this.port,
      lastKnownPid: this.pid,
      recovered: this.recoveredSession || this.reusedRunningChrome,
      recoveredSession: this.recoveredSession,
      reusedRunningChrome: this.reusedRunningChrome,
      headless: this.headless,
      browserVersion: connected ? this.browser?.version() || null : null,
      contextCount: connected ? this.browser?.contexts().length || 0 : 0,
      pageCount: pages.length,
      activePageIndex: this.page ? pages.indexOf(this.page) : -1,
      activePageTargetId: targetId,
      activePageUrl: this.page?.url() || null,
      activePageTitle: title,
      pages: await Promise.all(
        pages.map(async (page, index) => ({
          index,
          url: page.url(),
          title: await page.title().catch(() => null),
          active: page === this.page,
        })),
      ),
    };
  }

  async agentContext() {
    const storageStatePath = path.join(this.session.paths.saves, 'latest-storage-state.json');
    let storageStateSaved = false;
    try {
      if (!this.browser?.isConnected() || !this.context) {
        throw new Error('Browser is offline; storage state was not refreshed.');
      }
      await this.context.storageState({ path: storageStatePath });
      storageStateSaved = true;
    } catch (error) {
      await this.log('storage-state-error', { message: error.message });
    }
    const extensionContext = await this.runExtensionLifecycle('context', {
      reason: 'agent-context',
    });
    return {
      ...(await this.state()),
      sessionId: this.session.id,
      sessionPath: this.session.directory,
      targetUrl: this.targetUrl,
      browserProfilePath: this.session.paths.browserProfile,
      downloadsPath: this.session.paths.downloads,
      draftsPath: this.session.paths.drafts,
      screenshotsPath: this.session.paths.screenshots,
      savesPath: this.session.paths.saves,
      browserEventLogPath: this.eventLog,
      downloadPolicyEnforced: this.downloadPolicyEnforced,
      browserAccessMode: 'service-owned-playwright-bridge',
      browserBridgeHost: this.bridge?.host || null,
      browserBridgePort: this.bridge?.port || null,
      browserBridgeTokenPath: this.bridge?.tokenPath || null,
      browserControlCommand: path.join(path.dirname(__dirname), 'browserctl.js'),
      browserHooks: this.browserHookDescriptors(),
      storageStatePath,
      storageStateSaved,
      extensionContext,
      workflow: this.workflowStore?.snapshot() || {
        version: 1,
        available: [],
        active: null,
        pendingHumanActions: 0,
      },
      playwrightPackage: 'playwright-core',
      workingDirectory: this.workingDirectory,
    };
  }

  async screenshot(label) {
    if (!this.page || this.page.isClosed()) throw new Error('No active page is available.');
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeFilename(label || 'page')}.png`;
    const destination = await uniquePath(this.session.paths.screenshots, name);
    await this.page.screenshot({ path: destination, fullPage: true });
    await this.log('screenshot-saved', { destination, pageUrl: this.page.url() });
    return destination;
  }

  // Chrome ignores its own download-suppression switches for some payloads:
  // the on-device model fetcher repopulates OptGuideOnDeviceModel (gigabytes)
  // even with component updates and the optimization-guide features disabled.
  // Owning the profile means owning the outcome: these re-downloadable
  // component/model stores are deleted before every launch and after every
  // shutdown, so steady-state profile size stays small no matter what Chrome
  // pulls mid-session. User state (Default/, cookies, localStorage) is never
  // touched.
  // component_crx_cache is deliberately NOT pruned: it holds the packaged
  // component Chrome would otherwise re-download (~21 MB) on every launch.
  static PROFILE_BLOAT_DIRECTORIES = Object.freeze([
    'OptGuideOnDeviceModel',
    'optimization_guide_model_store',
    'Safe Browsing',
    'WasmTtsEngine',
    'OnDeviceHeadSuggestModel',
    'ActorSafetyLists',
    'BrowserMetrics',
    'Crashpad',
    'GrShaderCache',
    'ShaderCache',
    'GraphiteDawnCache',
  ]);

  // Chrome fetches on-device model/component packages through the same download
  // path browserctl redirects into the session, so they land in downloads/ as
  // bare-UUID CRX files and never leave. A real user download keeps its own
  // filename, so requiring BOTH a bare UUID name and the CRX magic number makes
  // this sweep unable to touch anything the user actually downloaded.
  static COMPONENT_DOWNLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async pruneComponentDownloads(reason) {
    const directory = this.session.paths.downloads;
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const removed = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!BrowserManager.COMPONENT_DOWNLOAD_NAME.test(entry.name)) continue;
      const target = path.join(directory, entry.name);
      let handle;
      try {
        handle = await fsp.open(target, 'r');
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
        if (bytesRead !== 4 || buffer.toString('latin1') !== 'Cr24') continue;
      } catch {
        continue;
      } finally {
        await handle?.close().catch(() => {});
      }
      await fsp.rm(target, { force: true });
      removed.push(entry.name);
    }
    if (removed.length) {
      await this.log('component-downloads-pruned', { reason, count: removed.length });
    }
    return removed;
  }

  async pruneProfileBloat(reason) {
    const removed = [];
    for (const name of BrowserManager.PROFILE_BLOAT_DIRECTORIES) {
      const target = path.join(this.session.paths.browserProfile, name);
      try {
        await fsp.access(target);
      } catch {
        continue;
      }
      await fsp.rm(target, { recursive: true, force: true });
      removed.push(name);
    }
    if (removed.length) await this.log('profile-bloat-pruned', { reason, removed });
    return removed;
  }

  // Cookies (logins) are shared across sessions through a single jar outside
  // any session directory; tabs, localStorage, and the rest of the profile stay
  // per-session. Import merges the jar into the live context at launch; export
  // rewrites the jar from the live context on every save and at shutdown.
  async importSharedCookies() {
    if (!this.sharedCookiesPath || !this.context) return { imported: 0 };
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(this.sharedCookiesPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await this.log('shared-cookies-error', { phase: 'import', message: error.message });
      }
      return { imported: 0 };
    }
    const nowSeconds = Date.now() / 1000;
    const cookies = (Array.isArray(parsed?.cookies) ? parsed.cookies : []).filter(
      (cookie) => cookie?.name && !(cookie.expires > 0 && cookie.expires < nowSeconds),
    );
    if (!cookies.length) return { imported: 0 };
    try {
      await this.context.addCookies(cookies);
    } catch (error) {
      await this.log('shared-cookies-error', { phase: 'import', message: error.message });
      return { imported: 0 };
    }
    await this.log('shared-cookies-imported', { count: cookies.length, source: this.sharedCookiesPath });
    return { imported: cookies.length };
  }

  async exportSharedCookies() {
    if (!this.sharedCookiesPath || !this.context || !this.browser?.isConnected()) {
      return { exported: 0 };
    }
    let cookies;
    try {
      cookies = (await this.context.storageState()).cookies || [];
    } catch (error) {
      await this.log('shared-cookies-error', { phase: 'export', message: error.message });
      return { exported: 0 };
    }
    await writeJsonAtomic(this.sharedCookiesPath, {
      version: 1,
      savedAt: timestamp(),
      cookies,
    });
    // The jar holds authentication cookies; keep it owner-readable only.
    await fsp.chmod(this.sharedCookiesPath, 0o600).catch(() => {});
    await this.log('shared-cookies-exported', { count: cookies.length, destination: this.sharedCookiesPath });
    return { exported: cookies.length };
  }

  async saveState(label = 'manual') {
    if (!this.context) throw new Error('The Playwright context is unavailable.');
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeFilename(label)}.json`;
    const destination = await uniquePath(this.session.paths.saves, filename);
    await this.context.storageState({ path: destination });
    const extensionState = await this.runExtensionLifecycle('beforeSave', {
      label,
      storageStatePath: destination,
    });
    await this.exportSharedCookies();
    await this.log('storage-state-saved', { destination, extensionState });
    return destination;
  }

  async open(url) {
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      this.attachPage(this.page);
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.page.bringToFront();
    await this.runExtensionLifecycle('pageReady', { reason: 'open' });
    await this.log('navigation', { url });
    return this.state();
  }

  async reload() {
    if (!this.page || this.page.isClosed()) throw new Error('No active page is available.');
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.runExtensionLifecycle('pageReady', { reason: 'reload' });
    await this.log('reload', { url: this.page.url() });
    return this.state();
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.bridge) {
      await this.bridge.stop().catch(() => {});
      this.bridge = null;
    }
    await this.runExtensionLifecycle('beforeStop', { reason: 'shutdown' });
    if (this.context) {
      await this.context
        .storageState({ path: path.join(this.session.paths.saves, 'latest-storage-state.json') })
        .catch(() => {});
      await this.exportSharedCookies();
    }
    if (this.downloadCdp) {
      await this.downloadCdp.detach().catch(() => {});
      this.downloadCdp = null;
    }
    await this.log('browser-stop', {});
    if (this.browser?.isConnected()) await this.browser.close().catch(() => {});
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => this.child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
    }
    if (this.child || !this.reusedRunningChrome) {
      await this.pruneProfileBloat('after-stop').catch(() => {});
      await this.pruneComponentDownloads('after-stop').catch(() => {});
    }
    this.closeLogDescriptors();
  }
}

module.exports = {
  BrowserManager,
  endpointResponds,
  discoverActiveBrowser,
  findChrome,
  getFreePort,
  readActivePort,
};
