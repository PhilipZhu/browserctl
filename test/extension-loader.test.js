'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const {
  extensionModulePath,
  upsertExtensionEntry,
  validateExtension,
} = require('../lib/extension-loader');

test('extension modules are constrained to the run directory', () => {
  assert.equal(
    extensionModulePath({ module: 'autorun/lib/example.js' }, '/workspace/runs'),
    path.join('/workspace/runs', 'autorun/lib/example.js'),
  );
  assert.throws(
    () => extensionModulePath({ module: '../outside.js' }, '/workspace/runs'),
    /must stay under/,
  );
});

test('extension entries upsert by id without removing unrelated plugins', () => {
  assert.deepEqual(
    upsertExtensionEntry(
      [{ id: 'other', module: 'other.js' }, { id: 'example', module: 'old.js' }],
      { id: 'example', module: 'new.js' },
    ),
    [{ id: 'other', module: 'other.js' }, { id: 'example', module: 'new.js' }],
  );
});

test('extension validation requires callable browser hooks', () => {
  assert.equal(
    validateExtension({
      id: 'valid',
      agentInstructions: 'instructions',
      browserHooks: [{ name: 'valid.hook', handler: async () => ({ ok: true }) }],
      browserLifecycle: { pageReady: async () => ({ ready: true }) },
    }, 'test').id,
    'valid',
  );
  assert.throws(
    () => validateExtension({ id: 'invalid', browserHooks: [{ name: 'missing-handler' }] }, 'test'),
    /invalid browser hook/,
  );
  assert.throws(
    () => validateExtension({ id: 'invalid-lifecycle', browserLifecycle: { unknown: async () => {} } }, 'test'),
    /invalid browser lifecycle handler/,
  );
  assert.throws(
    () => validateExtension({ id: 'invalid-turn-hook', beforeTurn: 'not-callable' }, 'test'),
    /beforeTurn must be a function/,
  );
});

test('extension validation accepts semantic capabilities and empty-final recovery', () => {
  const extension = validateExtension({
    id: 'schema-app',
    semanticCapabilities: [{
      id: 'schema.edit',
      label: 'Edit schema',
      description: 'Change a live schema tile.',
      effect: 'Mutates and verifies the live document.',
      hook: 'schema.mutate',
      targets: [{
        id: 'tiles',
        label: 'Live tiles',
        description: 'Tiles visible in the current document.',
        accepts: ['image-url'],
        operations: ['add'],
        bind: {'image-url': {image: '$url'}},
      }],
    }],
    browserHooks: [{name: 'schema.mutate', handler: async () => ({ok: true})}],
    recoverTurn: async () => null,
  }, '/workspace/schema.js');
  assert.equal(extension.semanticCapabilities[0].id, 'schema.edit');
  assert.throws(() => validateExtension({
    id: 'broken-schema',
    semanticCapabilities: [{
      id: 'broken',
      label: 'Broken',
      description: 'Broken capability.',
      effect: 'None.',
      hook: 'broken.mutate',
      targets: [{}],
    }],
  }, '/workspace/broken.js'), /invalid target/);
});

test('extension validation accepts adaptive workflows and continuation capabilities', () => {
  const extension = validateExtension({
    id: 'workflow-app',
    workflows: [{
      id: 'workflow-app.prepare',
      title: 'Prepare an item',
      objective: 'Prepare and verify without publishing.',
      steps: [{
        id: 'inspect',
        title: 'Inspect',
        instructions: 'Inspect live state.',
        completion: 'State is verified.',
      }],
    }],
    semanticCapabilities: [{
      id: 'workflow-app.start',
      label: 'Start preparation',
      description: 'Start the complete preparation series.',
      effect: 'Activates a persisted plan and continues general browser work.',
      hook: 'workflow-app.activate',
      continueAfterHook: true,
      continuationPrompt: 'Continue from live state.',
    }],
    browserHooks: [{name:'workflow-app.activate', handler:async()=>({})}],
  }, 'test');
  assert.equal(extension.workflows[0].steps[0].id, 'inspect');
  assert.equal(extension.semanticCapabilities[0].continueAfterHook, true);
  assert.throws(() => validateExtension({
    id:'broken-workflow',
    workflows:[{id:'x',title:'X',objective:'Y',steps:[]}],
  }, 'test'), /at least one step/);
});

test('extension authoring contract documents the complete restart-safe module surface', async () => {
  const guide = await fsp.readFile(path.join(__dirname, '..', 'EXTENSIONS.md'), 'utf8');
  for (const requiredText of [
    'async function createExtension({ entry, session, config, workingDirectory })',
    'Pass that same `extensions` array to both owners',
    '## Semantic capabilities',
    '## Resumable workflows',
    'continueAfterHook',
    'workflow.activate(WORKFLOW_ID',
    'workflow-state.json',
    '### `canHandleTurn(context)`',
    '### `handleTurn(context)`',
    '### `recoverTurn(context)`',
    '## Browser hooks',
    '### Bounded decisions after inspection',
    'agentDecision(prompt, options)',
    '## Browser lifecycle handlers',
    '`config` is normally `null`',
    'Never launch Chrome or call `connectOverCDP`',
    'persistence followed by generic `browserctl --open` reload',
  ]) {
    assert.match(guide, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
