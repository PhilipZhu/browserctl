'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { BrowserManager } = require('../lib/browser-manager');

function fakeSession() {
  const root = '/tmp/browserctl-lifecycle-session';
  return {
    id: 'test-session',
    directory: root,
    manifest: { browser: {} },
    paths: {
      browserProfile: path.join(root, 'browser-profile'),
      conversations: path.join(root, 'conversations'),
      downloads: path.join(root, 'downloads'),
      drafts: path.join(root, 'drafts'),
      logs: path.join(root, 'logs'),
      saves: path.join(root, 'saves'),
      screenshots: path.join(root, 'screenshots'),
    },
  };
}

test('browser lifecycle handlers remain generic and namespace extension results', async () => {
  const calls = [];
  const manager = new BrowserManager(fakeSession(), {
    targetUrl: 'https://example.test/',
    extensions: [{
      id: 'example-app',
      browserLifecycle: {
        async pageReady(details) {
          calls.push({ event: 'pageReady', reason: details.reason, targetUrl: details.targetUrl });
          return { restored: true };
        },
        async context(details) {
          calls.push({ event: 'context', reason: details.reason });
          return { snapshot: '/tmp/example-state.json' };
        },
      },
    }],
  });

  assert.deepEqual(
    await manager.runExtensionLifecycle('pageReady', { reason: 'test' }),
    { 'example-app': { restored: true } },
  );
  assert.deepEqual(
    await manager.runExtensionLifecycle('context', { reason: 'agent-context' }),
    { 'example-app': { snapshot: '/tmp/example-state.json' } },
  );
  assert.deepEqual(calls, [
    { event: 'pageReady', reason: 'test', targetUrl: 'https://example.test/' },
    { event: 'context', reason: 'agent-context' },
  ]);
});

test('browser hooks receive an optional application-neutral bounded agent decision', async () => {
  let received = null;
  const manager = new BrowserManager(fakeSession(), {
    targetUrl: 'https://example.test/',
    extensions: [{
      id: 'example-app',
      browserHooks: [{
        name: 'example.classify',
        async handler(details) {
          received = details.agentDecision;
          return {choice: await details.agentDecision('read evidence')};
        },
      }],
    }],
  });
  manager.browser = {isConnected: () => true};
  manager.context = {pages: () => []};
  manager.page = {isClosed: () => false};
  manager.log = async () => {};
  const result = await manager.invokeBrowserHook('example.classify', {}, {
    agentDecision: async (prompt) => `chosen after ${prompt}`,
  });
  assert.equal(typeof received, 'function');
  assert.deepEqual(result, {choice: 'chosen after read evidence'});
});

test('chrome launch limits profile growth from component and model downloads', async () => {
  const source = await require('node:fs/promises').readFile(
    require('node:path').join(__dirname, '..', 'lib', 'browser-manager.js'),
    'utf8',
  );
  // Per-session profiles must not accumulate gigabyte-scale on-device models,
  // updatable components, or an unbounded HTTP cache.
  assert.match(source, /--disable-component-update/);
  assert.match(source, /--disable-features=OptimizationGuideModelDownloading/);
  assert.match(source, /--disk-cache-size=\d+/);
});

test('shared cookie jar exports from and imports into the live context', async () => {
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const jarDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-jar-'));
  const jarPath = path.join(jarDirectory, 'shared-cookies.json');
  const added = [];
  const manager = new BrowserManager(fakeSession(), { sharedCookiesPath: jarPath });
  manager.log = async () => {};
  manager.browser = { isConnected: () => true };
  manager.context = {
    addCookies: async (cookies) => added.push(...cookies),
    storageState: async () => ({
      cookies: [{ name: 'login', value: 'token', domain: '.example.test', path: '/', expires: -1 }],
    }),
  };

  const exported = await manager.exportSharedCookies();
  assert.equal(exported.exported, 1);
  const stat = await fsp.stat(jarPath);
  assert.equal(stat.mode & 0o777, 0o600);

  // Expired cookies are dropped on import; live ones reach the context.
  const jar = JSON.parse(await fsp.readFile(jarPath, 'utf8'));
  jar.cookies.push({ name: 'stale', domain: '.example.test', path: '/', expires: 1 });
  await fsp.writeFile(jarPath, JSON.stringify(jar));
  const imported = await manager.importSharedCookies();
  assert.equal(imported.imported, 1);
  assert.deepEqual(added.map((cookie) => cookie.name), ['login']);

  await fsp.rm(jarDirectory, { recursive: true, force: true });
});

test('shared cookie jar is optional and a missing jar is a quiet no-op', async () => {
  const disabled = new BrowserManager(fakeSession(), {});
  disabled.context = { addCookies: async () => { throw new Error('must not be called'); } };
  assert.deepEqual(await disabled.importSharedCookies(), { imported: 0 });
  assert.deepEqual(await disabled.exportSharedCookies(), { exported: 0 });

  const missing = new BrowserManager(fakeSession(), {
    sharedCookiesPath: '/nonexistent/shared-cookies.json',
  });
  missing.log = async () => {};
  missing.context = { addCookies: async () => { throw new Error('must not be called'); } };
  assert.deepEqual(await missing.importSharedCookies(), { imported: 0 });
});

test('profile bloat directories are pruned while user state is preserved', async () => {
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-prune-'));
  const session = fakeSession();
  session.paths.browserProfile = path.join(root, 'browser-profile');
  await fsp.mkdir(path.join(session.paths.browserProfile, 'OptGuideOnDeviceModel', '2026.1'), { recursive: true });
  await fsp.writeFile(path.join(session.paths.browserProfile, 'OptGuideOnDeviceModel', '2026.1', 'weights.bin'), 'x'.repeat(1024));
  await fsp.mkdir(path.join(session.paths.browserProfile, 'component_crx_cache'), { recursive: true });
  await fsp.mkdir(path.join(session.paths.browserProfile, 'Default'), { recursive: true });
  await fsp.writeFile(path.join(session.paths.browserProfile, 'Default', 'Cookies'), 'user-state');

  const manager = new BrowserManager(session, {});
  manager.log = async () => {};
  const removed = await manager.pruneProfileBloat('test');
  assert.deepEqual(removed.sort(), ['OptGuideOnDeviceModel', 'component_crx_cache']);
  await assert.rejects(fsp.access(path.join(session.paths.browserProfile, 'OptGuideOnDeviceModel')));
  assert.equal(
    await fsp.readFile(path.join(session.paths.browserProfile, 'Default', 'Cookies'), 'utf8'),
    'user-state',
  );
  // A second pass over the already-clean profile is a quiet no-op.
  assert.deepEqual(await manager.pruneProfileBloat('test'), []);
  await fsp.rm(root, { recursive: true, force: true });
});
