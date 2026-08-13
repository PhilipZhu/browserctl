'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BrowserBridge } = require('../lib/browser-bridge');
const { sendRequest } = require('../browserctl');

test('bridge executes operations in the existing service-owned Playwright objects', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-bridge-test-'));
  const logs = path.join(root, 'logs');
  await fsp.mkdir(logs);
  const events = [];
  const page = {
    isClosed: () => false,
    title: async () => 'Managed application tab',
    url: () => 'http://127.0.0.1/app/',
  };
  const manager = {
    page,
    context: { pages: () => [page] },
    browser: { marker: 'service-browser' },
    targetUrl: 'http://127.0.0.1/app/',
    log: async (type, details) => events.push({ type, ...details }),
    agentContext: async () => ({ connected: true, serviceOwned: true }),
    launch: async () => ({ connected: true, relaunched: true }),
    invokeBrowserHook: async (name, payload) => ({ name, payload, completed: true }),
    workflowStore: {
      snapshot: () => ({active:{id:'example.workflow'}}),
      update: async (payload) => ({...payload, persisted:true}),
      setWorkflowStatus: async (payload) => ({...payload, persisted:true}),
    },
  };
  const session = {
    id: 'test-session',
    directory: root,
    paths: {
      logs,
      downloads: path.join(root, 'downloads'),
      screenshots: path.join(root, 'screenshots'),
      saves: path.join(root, 'saves'),
      drafts: path.join(root, 'drafts'),
    },
  };
  const bridge = new BrowserBridge(manager, session, { timeoutMs: 2000 });
  await bridge.start();
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });

  const state = await sendRequest({ host: bridge.host, port: bridge.port }, {
    token: bridge.token,
    action: 'state',
  });
  assert.deepEqual(state, {
    ok: true,
    result: { connected: true, serviceOwned: true },
  });

  const launched = await sendRequest({ host: bridge.host, port: bridge.port }, {
    token: bridge.token,
    action: 'launch',
  });
  assert.deepEqual(launched, {
    ok: true,
    result: { connected: true, relaunched: true },
  });

  const evaluated = await sendRequest({ host: bridge.host, port: bridge.port }, {
    token: bridge.token,
    action: 'evaluate',
    code: 'return { title: await page.title(), browser: playwrightBrowser.marker, id: session.id };',
  });
  assert.deepEqual(evaluated, {
    ok: true,
    result: {
      title: 'Managed application tab',
      browser: 'service-browser',
      id: 'test-session',
    },
  });

  const invoked = await sendRequest({ host: bridge.host, port: bridge.port }, {
    token: bridge.token,
    action: 'invoke',
    name: 'example.update',
    payload: { url: 'https://example.test/article' },
  });
  assert.deepEqual(invoked, {
    ok: true,
    result: {
      name: 'example.update',
      payload: { url: 'https://example.test/article' },
      completed: true,
    },
  });
  const workflow = await sendRequest({host:bridge.host, port:bridge.port}, {
    token: bridge.token,
    action: 'workflow',
    operation: 'update',
    payload: {stepId:'inspect', status:'completed', note:'Verified.'},
  });
  assert.deepEqual(workflow, {
    ok: true,
    result: {stepId:'inspect', status:'completed', note:'Verified.', persisted:true},
  });
  assert.ok(events.some((event) => event.type === 'browser-bridge-request'));
});

test('bridge rejects invalid tokens without executing code', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-bridge-auth-test-'));
  const logs = path.join(root, 'logs');
  await fsp.mkdir(logs);
  const manager = {
    log: async () => {},
    agentContext: async () => ({ connected: true }),
  };
  const session = {
    id: 'test-session',
    directory: root,
    paths: {
      logs,
      downloads: root,
      screenshots: root,
      saves: root,
      drafts: root,
    },
  };
  const bridge = new BrowserBridge(manager, session);
  await bridge.start();
  t.after(async () => {
    await bridge.stop().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });

  const response = await sendRequest({ host: bridge.host, port: bridge.port }, {
    token: 'wrong-token',
    action: 'evaluate',
    code: 'return 1;',
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /authentication/);
});
