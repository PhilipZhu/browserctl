'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { timestamp } = require('./utils');

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class BrowserBridge {
  constructor(browserManager, session, options = {}) {
    this.browserManager = browserManager;
    this.session = session;
    this.host = '127.0.0.1';
    this.port = null;
    this.tokenPath = path.join(session.paths.logs, 'browser-bridge.token');
    this.token = crypto.randomBytes(32).toString('hex');
    this.server = null;
    this.timeoutMs = options.timeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS;
    this.requestSequence = Promise.resolve();
  }

  async start() {
    await fsp.writeFile(this.tokenPath, `${this.token}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    this.server = net.createServer((socket) => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.port = this.server.address().port;
    await this.browserManager.log('browser-bridge-started', {
      host: this.host,
      port: this.port,
      tokenPath: this.tokenPath,
    });
  }

  handleSocket(socket) {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    const respond = (payload) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(payload)}\n`);
    };
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        respond({ ok: false, error: 'Browser bridge request is too large.' });
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        respond({ ok: false, error: 'Browser bridge request is not valid JSON.' });
        return;
      }
      this.requestSequence = this.requestSequence
        .catch(() => {})
        .then(() => this.dispatch(request));
      void this.requestSequence.then(respond);
    });
    socket.on('error', () => {});
  }

  async dispatch(request) {
    const requestId = crypto.randomUUID();
    const startedAt = timestamp();
    if (!request || request.token !== this.token) {
      await this.browserManager.log('browser-bridge-rejected', {
        requestId,
        reason: 'invalid-token',
      });
      return { ok: false, error: 'Browser bridge authentication failed.' };
    }

    try {
      let result;
      if (request.action === 'state') {
        result = await this.browserManager.agentContext();
      } else if (request.action === 'launch') {
        result = await this.browserManager.launch();
      } else if (request.action === 'evaluate') {
        result = await this.evaluate(request.code);
      } else if (request.action === 'screenshot') {
        result = await this.browserManager.screenshot(request.label || 'agent');
      } else if (request.action === 'save') {
        result = await this.browserManager.saveState(request.label || 'agent');
      } else if (request.action === 'reload') {
        result = await this.browserManager.reload();
      } else if (request.action === 'open') {
        result = await this.browserManager.open(request.url);
      } else if (request.action === 'semantic') {
        const handler = this.browserManager.semanticActionHandler;
        if (!handler) {
          throw new Error('No live agent console is accepting application actions.');
        }
        result = await handler(request.proposal);
      } else if (request.action === 'invoke') {
        result = await this.browserManager.invokeBrowserHook(request.name, request.payload);
      } else if (request.action === 'workflow') {
        const store = this.browserManager.workflowStore;
        if (!store) throw new Error('Workflow tracking is unavailable for this session.');
        if (request.operation === 'state') result = store.snapshot();
        else if (request.operation === 'update') result = await store.update(request.payload);
        else if (request.operation === 'status') result = await store.setWorkflowStatus(request.payload);
        else throw new Error(`Unknown workflow operation: ${request.operation || '(none)'}.`);
      } else {
        throw new Error(`Unknown browser bridge action: ${request.action}`);
      }
      // Fail here with an actionable message instead of emitting malformed JSON.
      JSON.stringify(result);
      await this.browserManager.log('browser-bridge-request', {
        requestId,
        action: request.action,
        startedAt,
        completedAt: timestamp(),
        ok: true,
      });
      return { ok: true, result };
    } catch (error) {
      await this.browserManager.log('browser-bridge-request', {
        requestId,
        action: request.action,
        startedAt,
        completedAt: timestamp(),
        ok: false,
        error: error.message,
      });
      return { ok: false, error: error.message };
    }
  }

  async evaluate(code) {
    if (typeof code !== 'string' || !code.trim()) {
      throw new Error('The browser bridge requires non-empty Playwright code.');
    }
    const manager = this.browserManager;
    if (!manager.page || manager.page.isClosed()) {
      manager.page =
        manager.context?.pages().find((candidate) => !candidate.isClosed()) ||
        (await manager.context?.newPage());
    }
    if (!manager.page) throw new Error('No managed Playwright page is available.');

    const execute = new AsyncFunction(
      'page',
      'context',
      'playwrightBrowser',
      'session',
      'paths',
      `"use strict";\n${code}`,
    );
    let timeout;
    try {
      return await Promise.race([
        execute(
          manager.page,
          manager.context,
          manager.browser,
          {
            id: this.session.id,
            path: this.session.directory,
            targetUrl: manager.targetUrl,
          },
          {
            downloads: this.session.paths.downloads,
            screenshots: this.session.paths.screenshots,
            saves: this.session.paths.saves,
            drafts: this.session.paths.drafts,
            logs: this.session.paths.logs,
          },
        ),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Browser operation exceeded ${this.timeoutMs} ms.`)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    this.port = null;
    await fsp.unlink(this.tokenPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await this.browserManager.log('browser-bridge-stopped', {});
  }
}

module.exports = {
  BrowserBridge,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
};
