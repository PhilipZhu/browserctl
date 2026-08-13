'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  WorkflowStore,
  validateWorkflowTemplate,
} = require('../lib/workflow-store');

const template = {
  id: 'example.publish',
  title: 'Prepare a publication',
  objective: 'Prepare and verify a publication without releasing it.',
  steps: [
    {
      id: 'inspect',
      title: 'Inspect current state',
      instructions: 'Inspect the live application and adapt the branch.',
      completion: 'Current state is recorded with evidence.',
    },
    {
      id: 'prepare',
      title: 'Prepare the draft',
      dependsOn: ['inspect'],
      instructions: 'Prepare only values that are safe to change.',
      completion: 'The draft is visibly prepared and verified.',
    },
  ],
};

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-workflow-'));
  const saves = path.join(root, 'saves');
  await fsp.mkdir(saves);
  t.after(() => fsp.rm(root, {recursive: true, force: true}));
  const session = {id: 'test', directory: root, paths: {saves}};
  const extensions = [{id: 'example', workflows: [template]}];
  return {root, saves, session, extensions};
}

test('workflow templates validate steps and dependencies without application vocabulary', () => {
  assert.equal(validateWorkflowTemplate(template).id, 'example.publish');
  assert.throws(() => validateWorkflowTemplate({...template, steps: []}), /at least one step/);
  assert.throws(() => validateWorkflowTemplate({
    ...template,
    steps: [{...template.steps[0], dependsOn: ['missing']}],
  }), /invalid dependency missing/);
});

test('workflow progress, adaptive skips, waiting reasons, and click actions survive restart', async (t) => {
  const {session, extensions} = await fixture(t);
  const first = await new WorkflowStore(session, extensions).initialize();
  await first.activate('example.publish', {
    activationReason: 'Human wants the publication prepared.',
    metadata: {source: '/session/generated.html'},
  });
  await first.update({
    stepId: 'inspect',
    status: 'completed',
    note: 'Observed an existing eligible draft at 10:42.',
  });
  await first.update({
    stepId: 'prepare',
    status: 'waiting',
    note: 'An existing value needs human confirmation before replacement.',
  });
  const action = await first.queueAction({
    workflowId: 'example.publish',
    stepId: 'prepare',
    action: 'prompt',
    note: 'Keep the existing title but replace the summary.',
  });
  assert.match(first.promptForAction(action), /replace the summary/);

  const reopened = await new WorkflowStore(session, extensions).initialize();
  assert.equal(reopened.active().steps[0].status, 'completed');
  assert.equal(reopened.active().steps[1].status, 'waiting');
  assert.equal(reopened.active().metadata.source, '/session/generated.html');
  assert.equal(reopened.snapshot().pendingHumanActions, 1);
  assert.equal((await reopened.consumeAction()).stepId, 'prepare');
  assert.equal(reopened.snapshot().pendingHumanActions, 0);
  assert.equal((await fsp.stat(reopened.filename)).mode & 0o777, 0o600);
});

test('workflow completion requires evidence and resolves only after every branch is completed or skipped', async (t) => {
  const {session, extensions} = await fixture(t);
  const store = await new WorkflowStore(session, extensions).initialize();
  await store.activate('example.publish');
  await assert.rejects(
    () => store.update({stepId: 'inspect', status: 'completed'}),
    /verification note/,
  );
  await store.update({stepId: 'inspect', status: 'skipped', note: 'Not needed after live inspection.'});
  await store.update({stepId: 'prepare', status: 'completed', note: 'Verified the visible draft.'});
  assert.equal(store.active().status, 'completed');
});
