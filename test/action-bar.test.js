'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ActionBar, collectQuickActions, MAX_QUICK_ACTIONS } = require('../lib/action-bar');

const extension = (quickActions) => ({ id: 'myapp', quickActions });

const validAction = {
  id: 'publish',
  label: 'Publish the draft',
  hint: 'Prepares and verifies; nothing is released.',
  prompt: 'Prepare the current draft for publication and verify it without releasing.',
};

test('collectQuickActions normalizes and namespaces actions', () => {
  const actions = collectQuickActions([extension([validAction])]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'myapp:publish');
  assert.equal(actions[0].label, 'Publish the draft');
  assert.ok(Object.isFrozen(actions[0]));
});

test('collectQuickActions rejects missing fields, duplicates, and oversized sets', () => {
  assert.throws(() => collectQuickActions([extension([{ id: 'x', label: 'X' }])]), /prompt is required/);
  assert.throws(() => collectQuickActions([extension([{ label: 'X', prompt: 'p' }])]), /id is required/);
  assert.throws(
    () => collectQuickActions([extension([validAction, validAction])]),
    /Duplicate quick action id: myapp:publish/,
  );
  const many = Array.from({ length: MAX_QUICK_ACTIONS + 1 }, (_, index) => ({
    ...validAction,
    id: `action-${index}`,
  }));
  assert.throws(() => collectQuickActions([extension(many)]), /stays scannable/);
  assert.throws(
    () => collectQuickActions([extension([{ ...validAction, hint: 'h'.repeat(200) }])]),
    /hint must stay under/,
  );
});

test('an extension without quickActions yields an inert bar', () => {
  const bar = new ActionBar([{ id: 'myapp' }]);
  assert.equal(bar.actions.length, 0);
  assert.equal(bar.consumePrompt(), null);
});

test('queuePrompt queues labeled prompts and consumePrompt drains in order', () => {
  const bar = new ActionBar([extension([
    validAction,
    { id: 'inputs', label: 'Where inputs live', prompt: 'Explain where build inputs are configured.' },
  ])]);
  const events = [];
  bar.on('prompt-queued', (queued) => events.push(queued.actionId));
  bar.queuePrompt('myapp:publish');
  bar.queuePrompt('myapp:inputs');
  assert.deepEqual(events, ['myapp:publish', 'myapp:inputs']);
  assert.equal(bar.pendingCount, 2);
  const first = bar.consumePrompt();
  assert.match(first, /clicked the “Publish the draft” quick action/);
  assert.match(first, /Prepare the current draft for publication/);
  assert.match(bar.consumePrompt(), /Explain where build inputs are configured/);
  assert.equal(bar.consumePrompt(), null);
  assert.throws(() => bar.queuePrompt('myapp:missing'), /Unknown quick action/);
});

test('attachBrowser exposes an authenticated binding and injects the overlay', async () => {
  const bar = new ActionBar([extension([validAction])]);
  const calls = { bindings: [], initScripts: [], evaluated: [] };
  let boundHandler = null;
  const context = {
    exposeBinding: async (name, handler) => {
      calls.bindings.push(name);
      boundHandler = handler;
    },
    addInitScript: async (script) => calls.initScripts.push(script.content),
    pages: () => [{ evaluate: async (code) => calls.evaluated.push(code) }],
  };
  await bar.attachBrowser(context);
  assert.deepEqual(calls.bindings, [bar.bindingName]);
  assert.equal(calls.initScripts.length, 1);
  assert.match(calls.initScripts[0], /Publish the draft/);
  assert.equal(calls.evaluated.length, 1);

  await assert.rejects(
    () => boundHandler(null, { token: 'wrong', actionId: 'myapp:publish' }),
    /authentication failed/,
  );
  const result = await boundHandler(null, { token: bar.actionToken, actionId: 'myapp:publish' });
  assert.deepEqual(result, { queued: true, actionId: 'myapp:publish' });
  assert.equal(bar.pendingCount, 1);

  // Re-attaching the same context must not double-register the binding.
  await bar.attachBrowser(context);
  assert.equal(calls.bindings.length, 1);
});

test('attachBrowser is a no-op when no actions are registered', async () => {
  const bar = new ActionBar([]);
  const context = {
    exposeBinding: async () => assert.fail('must not bind'),
    addInitScript: async () => assert.fail('must not inject'),
    pages: () => [],
  };
  await bar.attachBrowser(context);
});
