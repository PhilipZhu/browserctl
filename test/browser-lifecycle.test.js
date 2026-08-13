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
