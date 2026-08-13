'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentRunner, browserContextPrompt } = require('../lib/agent-runner');
const { InlineRunner, readInlineSequence } = require('../lib/inline-runner');

function fakeSession(root = '/tmp/test-session') {
  return {
    id: 'test-session',
    directory: root,
    manifest: {
      selectedAgent: 'pi',
      browser: {},
    },
    paths: {
      logs: path.join(root, 'logs'),
      drafts: path.join(root, 'drafts'),
    },
  };
}

test('all agent invocations are explicitly ephemeral and verbosity is opt-in', () => {
  const runner = new AgentRunner(fakeSession(), { update: async () => {} }, {
    workspaceRoot: '/tmp/workspace',
  });

  const pi = runner.invocation('pi', 'prompt', false);
  assert.ok(pi.args.includes('--no-session'));
  assert.ok(pi.args.includes('--no-context-files'));
  assert.ok(pi.args.includes('--no-extensions'));
  assert.ok(pi.args.includes('--extension'));
  assert.ok(pi.args.includes('--no-skills'));
  assert.ok(!pi.args.includes('--session-dir'));
  assert.equal(pi.mode, 'plain');
  assert.equal(runner.invocation('pi', 'prompt', true).mode, 'pi-jsonl');
  assert.equal(runner.invocation('pi', 'prompt', false, true).mode, 'pi-jsonl');

  const codex = runner.invocation('codex', 'prompt', false);
  assert.ok(codex.args.includes('--ephemeral'));
  assert.ok(!codex.args.includes('resume'));

  const claude = runner.invocation('claude', 'prompt', false);
  assert.ok(claude.args.includes('--no-session-persistence'));
  assert.ok(claude.args.includes('--no-chrome'));
  assert.ok(!claude.args.includes('--session-id'));
  const verboseClaude = runner.invocation('claude', 'prompt', true);
  assert.ok(verboseClaude.args.includes('stream-json'));
  assert.equal(runner.verbose, false);
});

test('live browser context is intent-driven and keeps application behavior out of the base prompt', () => {
  const prompt = browserContextPrompt({
    connected: true,
    sessionId: 'test-session',
    sessionPath: '/tmp/test-session',
    workingDirectory: '/tmp/workspace',
    targetUrl: 'http://127.0.0.1/app/',
    headless: false,
    recoveredSession: true,
    reusedRunningChrome: false,
    browserVersion: 'test-browser',
    cdpUrl: 'http://127.0.0.1:9222',
    port: 9222,
    contextCount: 1,
    pageCount: 1,
    activePageIndex: 0,
    activePageTargetId: 'page',
    activePageTitle: 'Example App',
    activePageUrl: 'http://127.0.0.1/app/',
    pages: [{ index: 0, active: true, title: 'Example App', url: 'http://127.0.0.1/app/' }],
    browserProfilePath: '/tmp/test-session/browser-profile',
    downloadsPath: '/tmp/test-session/downloads',
    draftsPath: '/tmp/test-session/drafts',
    screenshotsPath: '/tmp/test-session/screenshots',
    savesPath: '/tmp/test-session/saves',
    browserEventLogPath: '/tmp/test-session/logs/browser-events.jsonl',
    storageStatePath: '/tmp/test-session/saves/latest-storage-state.json',
    storageStateSaved: true,
    browserAccessMode: 'bridge',
    browserControlCommand: './browserctl/browserctl.js',
    browserBridgeHost: '127.0.0.1',
    browserBridgePort: 9444,
    browserBridgeTokenPath: '/tmp/test-session/logs/bridge.token',
  });
  assert.match(prompt, /Translate the human's natural-language intent/);
  assert.match(prompt, /Do not ask the human to restate a request as a terminal command/);
  assert.match(prompt, /Keep useful pages open/);
  assert.doesNotMatch(prompt, /replace-news/);
});

test('formatted turns include application instructions only when supplied by an extension', () => {
  const prompt = require('../lib/agent-runner').formatTurnPrompt(
    { connected: false, sessionId: 'test', sessionPath: '/tmp/test' },
    'update the application',
    '',
    '## test-extension\n\nUnderstand this application naturally.',
  );
  assert.match(prompt, /APPLICATION EXTENSIONS/);
  assert.match(prompt, /Understand this application naturally/);
  assert.ok(prompt.indexOf('APPLICATION EXTENSIONS') < prompt.indexOf('USER REQUEST'));
});

test('an application extension can handle clear natural browser intent without agent command syntax', async () => {
  const extension = {
    id: 'example-app',
    browserHooks: [{ name: 'example.archive', handler: async () => ({ ok: true }) }],
    canHandleTurn(context) {
      return /archive/i.test(context.userPrompt) ? 'Example extension' : null;
    },
    async handleTurn(context) {
      if (!/archive/i.test(context.userPrompt)) return null;
      const result = await context.invokeBrowserHook('example.archive', { scope: 'current' });
      return { output: `Archived the current page (${result.itemCount} items).` };
    },
  };
  const invoked = [];
  const shown = [];
  const activity = [];
  const runner = new AgentRunner(fakeSession(), { update: async () => {} }, {
    workspaceRoot: '/tmp/workspace',
    extensions: [extension],
    browserContextProvider: async () => ({ connected: true, pages: [], browserHooks: [] }),
    browserHookInvoker: async (name, payload) => {
      invoked.push({ name, payload });
      return {
        itemCount: 4,
      };
    },
  });
  const output = await runner.run(
    'please archive the current page',
    (chunk) => shown.push(chunk),
    { memoryMode: 'ephemeral', onActivity: (value) => activity.push(value) },
  );
  assert.deepEqual(invoked, [{
    name: 'example.archive',
    payload: { scope: 'current' },
  }]);
  assert.match(output, /Archived the current page/);
  assert.match(shown.join(''), /4 items/);
  assert.deepEqual(activity, [{
    type: 'extension',
    extensionId: 'example-app',
    label: 'Example extension',
  }]);
});

test('the agent semantically proposes a typed capability without keyword pre-dispatch', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-semantic-test-'));
  t.after(() => fsp.rm(directory, {recursive: true, force: true}));
  const executable = path.join(directory, 'fake-pi');
  await fsp.writeFile(executable, `#!/usr/bin/env node
'use strict';
const prompt = process.argv.at(-1);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (prompt.includes('bounded evidence decision')) {
  send({type: 'message_end', message: {role: 'assistant', content: [
    {type: 'text', text: '{"choice":"evidence-based"}'},
  ]}});
  send({type: 'agent_end'});
} else if (prompt.includes('ordinary explanation')) {
  send({type: 'message_end', message: {role: 'assistant', content: [
    {type: 'text', text: 'This is an ordinary agent answer.'},
  ]}});
  send({type: 'agent_end'});
} else {
  if (!prompt.includes('Semantic application capabilities') ||
      !prompt.includes('browserctl_propose_action') ||
      !prompt.includes('make the thing people see in this edition') ||
      !process.argv.includes('--no-context-files')) process.exit(41);
  const args = {
    capability: 'example.set-asset',
    target: 'promotions',
    operation: 'upsert',
    resources: [{type: 'image-url', url: 'https://assets.example.test/summer.jpg'}],
    interpretation: 'use the supplied image as the current promotion',
    rationale: 'The request refers to what people see in this edition, and the live slot has room.',
  };
  send({type: 'tool_execution_start', toolCallId: 'proposal-1',
    toolName: 'browserctl_propose_action', args});
  send({type: 'tool_execution_end', toolCallId: 'proposal-1',
    toolName: 'browserctl_propose_action', args, isError: false,
    result: {content: [{type: 'text', text: 'recorded'}]}});
  send({type: 'agent_end'});
}
`, {mode: 0o700});
  await fsp.chmod(executable, 0o700);
  const previous = process.env.BROWSERCTL_PI_BIN;
  process.env.BROWSERCTL_PI_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTL_PI_BIN;
    else process.env.BROWSERCTL_PI_BIN = previous;
  });
  const extension = {
    id: 'example-app',
    semanticCapabilities: [{
      id: 'example.set-asset',
      label: 'Example document edit',
      description: 'Change promotional creative displayed in the current document.',
      effect: 'Mutates and verifies the current document.',
      hook: 'example.mutate',
      statePath: 'browserState.extensionContext.example-app.sections',
      targets: [{
        id: 'promotions',
        label: 'Current promotional creative',
        description: 'Creative displayed now, not material reserved for a later publication.',
        accepts: ['image-url'],
        operations: ['add', 'replace', 'upsert'],
        bind: {'image-url': {image: '$url'}},
        capacity: 2,
        whenFull: 'replace-last',
      }],
      formatResult: (result) => result.output,
    }],
  };
  const invoked = [];
  const activity = [];
  const shown = [];
  const runner = new AgentRunner(fakeSession(), { update: async () => {} }, {
    workspaceRoot: directory,
    agent: 'pi',
    extensions: [extension],
    browserContextProvider: async () => ({
      connected: true,
      pages: [],
      browserHooks: [],
      extensionContext: {
        'example-app': {sections: {promotions: {count: 0, capacity: 2}}},
      },
    }),
    browserHookInvoker: async (name, payload, runtime) => {
      invoked.push({name, payload});
      assert.equal(typeof runtime.agentDecision, 'function');
      const decision = await runtime.agentDecision(
        'Make a bounded evidence decision and return JSON.',
        {label: 'test evidence'},
      );
      assert.match(decision, /evidence-based/);
      return {output: 'Added the promotion and verified the document after a bounded decision.'};
    },
  });
  const output = await runner.run(
    'make the thing people see in this edition use https://assets.example.test/summer.jpg',
    (chunk) => shown.push(chunk),
    {memoryMode: 'ephemeral', onActivity: (value) => activity.push(value)},
  );
  assert.match(output, /Added the promotion/);
  assert.doesNotMatch(shown.join(''), /browserctlAction/);
  assert.match(shown.join(''), /I understood your request as: use the supplied image/);
  assert.match(shown.join(''), /Planned route: Example document edit → Current promotional creative/);
  assert.match(shown.join(''), /evaluating test evidence before any application mutation/i);
  assert.deepEqual(invoked, [{
    name: 'example.mutate',
    payload: {
      actionVersion: 1,
      action: 'example.set-asset',
      target: 'promotions',
      operation: 'add',
      requestedOperation: 'upsert',
      values: {image: 'https://assets.example.test/summer.jpg'},
    },
  }]);
  assert.deepEqual(activity, [
    {type: 'agent', agent: 'pi', label: 'pi'},
    {type: 'extension', extensionId: 'example-app', label: 'Example document edit'},
  ]);
  const ordinaryShown = [];
  const ordinary = await runner.run(
    'give me an ordinary explanation',
    (chunk) => ordinaryShown.push(chunk),
    {memoryMode: 'ephemeral'},
  );
  assert.match(ordinary, /ordinary agent answer/);
  assert.match(ordinaryShown.join(''), /ordinary agent answer/);
  assert.equal(invoked.length, 1);
});

test('a workflow activation capability continues into general live-browser work', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-workflow-agent-'));
  t.after(() => fsp.rm(directory, {recursive: true, force: true}));
  const executable = path.join(directory, 'fake-pi');
  await fsp.writeFile(executable, `#!/usr/bin/env node
'use strict';
const prompt = process.argv.at(-1);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (prompt.includes('Semantic application capabilities')) {
  const args = {
    capability: 'example.prepare',
    payloadJson: '{}',
    interpretation: 'prepare the current item through its tracked application workflow',
    rationale: 'The requested outcome is the complete preparation series.',
  };
  send({type:'tool_execution_start',toolCallId:'workflow-1',toolName:'browserctl_propose_action',args});
  send({type:'tool_execution_end',toolCallId:'workflow-1',toolName:'browserctl_propose_action',args,isError:false,result:{content:[{type:'text',text:'recorded'}]}});
  send({type:'agent_end'});
} else if (prompt.includes('Active resumable workflow') && prompt.includes('Continue the active workflow now')) {
  if (prompt.includes('Semantic application capabilities')) process.exit(42);
  const update = {stepId:'inspect',status:'completed',note:'Verified the current live page.'};
  send({type:'tool_execution_start',toolCallId:'plan-1',toolName:'browserctl_update_workflow',args:update});
  send({type:'tool_execution_end',toolCallId:'plan-1',toolName:'browserctl_update_workflow',args:update,isError:false,result:{content:[{type:'text',text:'recorded'}]}});
  send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'I inspected the live page, adapted the tracked branch, and verified the current step.'}]}});
  send({type:'agent_end'});
} else process.exit(43);
`, {mode: 0o700});
  await fsp.chmod(executable, 0o700);
  const previous = process.env.BROWSERCTL_PI_BIN;
  process.env.BROWSERCTL_PI_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTL_PI_BIN;
    else process.env.BROWSERCTL_PI_BIN = previous;
  });
  let active = null;
  const extension = {
    id: 'example-app',
    workflows: [{
      id: 'example.workflow',
      title: 'Example preparation',
      objective: 'Prepare an item without publishing it.',
      steps: [{id:'inspect',title:'Inspect',instructions:'Inspect live state.',completion:'State is verified.'}],
    }],
    semanticCapabilities: [{
      id: 'example.prepare',
      label: 'Prepare through tracked workflow',
      description: 'Activate the complete preparation workflow.',
      effect: 'Persists a plan and continues with general browser inspection.',
      hook: 'example.activate',
      inputHint: '{}',
      continueAfterHook: true,
      continuationPrompt: 'Continue the active workflow now.',
    }],
    browserHooks: [{name:'example.activate',handler:async()=>({})}],
  };
  const browserState = () => ({
    connected: true,
    sessionId: 'test-session',
    sessionPath: directory,
    workingDirectory: directory,
    targetUrl: 'https://example.test/',
    headless: false,
    recoveredSession: false,
    reusedRunningChrome: false,
    browserVersion: 'test',
    cdpUrl: 'http://127.0.0.1:9222',
    port: 9222,
    contextCount: 1,
    pageCount: 1,
    activePageIndex: 0,
    activePageTargetId: 'page',
    activePageTitle: 'Example',
    activePageUrl: 'https://example.test/',
    pages: [{index:0,active:true,title:'Example',url:'https://example.test/'}],
    browserProfilePath: directory,
    downloadsPath: directory,
    draftsPath: directory,
    screenshotsPath: directory,
    savesPath: directory,
    browserEventLogPath: path.join(directory, 'events.jsonl'),
    storageStatePath: path.join(directory, 'state.json'),
    storageStateSaved: true,
    browserAccessMode: 'bridge',
    browserControlCommand: './browserctl/browserctl.js',
    browserBridgeHost: '127.0.0.1',
    browserBridgePort: 9444,
    browserBridgeTokenPath: path.join(directory, 'token'),
    browserHooks: [],
    extensionContext: {},
    workflow: {available: [{id:'example.workflow'}], active},
  });
  let invoked = 0;
  const workflowStore = {
    active: () => active,
    async update(update) {
      const step = active.steps.find((candidate) => candidate.id === update.stepId);
      Object.assign(step, update, {updatedAt:new Date().toISOString()});
      active.updatedAt = new Date(Date.now() + 5).toISOString();
      return active;
    },
  };
  const runner = new AgentRunner(fakeSession(directory), {update:async()=>{}}, {
    workspaceRoot: directory,
    agent: 'pi',
    extensions: [extension],
    workflowStore,
    browserContextProvider: async () => browserState(),
    browserHookInvoker: async () => {
      invoked += 1;
      active = {
        id: 'example.workflow', title:'Example preparation', objective:'Prepare an item.',
        status:'active', updatedAt:new Date().toISOString(), steps:[{id:'inspect',title:'Inspect',status:'in_progress',instructions:'Inspect.',completion:'Verified.',dependsOn:[],note:'',attempts:1,updatedAt:new Date().toISOString()}],
      };
      return {output:'Workflow tracker activated.'};
    },
  });
  const shown = [];
  const output = await runner.run('handle the complete preparation for me', (chunk) => shown.push(chunk), {
    memoryMode: 'ephemeral',
  });
  assert.equal(invoked, 1);
  assert.match(shown.join(''), /Workflow tracker activated/);
  assert.match(output, /adapted the tracked branch/);
});

test('workflow prose is rejected when no plan update was actually persisted', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-workflow-no-update-'));
  t.after(() => fsp.rm(directory, {recursive:true, force:true}));
  const executable = path.join(directory, 'fake-pi');
  await fsp.writeFile(executable, `#!/usr/bin/env node
'use strict';
process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'I updated the plan.'}]}})+'\\n');
process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');
`, {mode:0o700});
  await fsp.chmod(executable, 0o700);
  const previous = process.env.BROWSERCTL_PI_BIN;
  process.env.BROWSERCTL_PI_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTL_PI_BIN;
    else process.env.BROWSERCTL_PI_BIN = previous;
  });
  const active = {
    id:'example.workflow', title:'Example', objective:'Verify.', status:'active',
    updatedAt:'2026-08-08T00:00:00.000Z', steps:[{id:'inspect',title:'Inspect',status:'in_progress'}],
  };
  const runner = new AgentRunner(fakeSession(directory), {update:async()=>{}}, {
    workspaceRoot:directory,
    agent:'pi',
    workflowStore:{active:()=>active},
    browserContextProvider:async()=>({
      connected:false,
      sessionId:'test',
      sessionPath:directory,
      workflow:{active, available:[{id:'example.workflow'}]},
    }),
  });
  await assert.rejects(() => runner.run('continue the active step', () => {}, {
    memoryMode:'ephemeral',
    skipCapabilities:true,
    requireWorkflowUpdate:true,
  }), /without a persisted plan update/);
});

test('an extension can recover a successful agent process that returned no final', async (t) => {
  const previous = process.env.BROWSERCTL_PI_BIN;
  process.env.BROWSERCTL_PI_BIN = '/bin/true';
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTL_PI_BIN;
    else process.env.BROWSERCTL_PI_BIN = previous;
  });
  let contextReads = 0;
  const extension = {
    id: 'recovery-app',
    async recoverTurn(context) {
      assert.equal(context.failure.type, 'empty-agent-final');
      assert.equal(context.browserState.read, 2);
      return {output: 'Recovered from current application state.'};
    },
  };
  const runner = new AgentRunner(fakeSession(), {update: async () => {}}, {
    workspaceRoot: '/tmp',
    agent: 'pi',
    extensions: [extension],
    browserContextProvider: async () => ({connected: false, read: ++contextReads}),
  });
  const output = await runner.run('inspect the application', () => {}, {
    memoryMode: 'ephemeral',
  });
  assert.match(output, /Recovered from current application state/);
  assert.equal(contextReads, 2);
});

test('general recovery gives hook failure circumstances to the agent without blindly replaying the hook', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-general-recovery-'));
  t.after(() => fsp.rm(directory, {recursive: true, force: true}));
  const executable = path.join(directory, 'fake-pi');
  await fsp.writeFile(executable, `#!/usr/bin/env node
'use strict';
const prompt = process.argv.at(-1);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (prompt.includes('# AUTOMATIC FAILURE RECOVERY')) {
  if (!prompt.includes('original failing request') ||
      !prompt.includes('application-action') ||
      !prompt.includes('forced hook failure') ||
      !prompt.includes('side effects as uncertain')) process.exit(51);
  send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'I inspected the fresh application state. The attempted change was rolled back, so I stopped and explained the safe next step without replaying it.'}]}});
  send({type:'agent_end'});
} else {
  const args = {
    capability:'example.failing-action',
    payloadJson:'{}',
    interpretation:'perform the requested application change',
    rationale:'The declared capability fits the requested outcome.',
  };
  send({type:'tool_execution_start',toolCallId:'proposal-1',toolName:'browserctl_propose_action',args});
  send({type:'tool_execution_end',toolCallId:'proposal-1',toolName:'browserctl_propose_action',args,isError:false,result:{content:[{type:'text',text:'recorded'}]}});
  send({type:'agent_end'});
}
`, {mode: 0o700});
  await fsp.chmod(executable, 0o700);
  const previous = process.env.BROWSERCTL_PI_BIN;
  process.env.BROWSERCTL_PI_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTL_PI_BIN;
    else process.env.BROWSERCTL_PI_BIN = previous;
  });
  const extension = {
    id: 'example-app',
    semanticCapabilities: [{
      id: 'example.failing-action',
      label: 'Example guarded change',
      description: 'Make and verify one guarded application change.',
      effect: 'May mutate application state through a verified hook.',
      hook: 'example.fail',
      inputHint: '{}',
    }],
  };
  let hookCalls = 0;
  const shown = [];
  const runner = new AgentRunner(fakeSession(directory), {update: async () => {}}, {
    workspaceRoot: directory,
    agent: 'pi',
    extensions: [extension],
    recoveryAttempts: 2,
    browserContextProvider: async () => ({
      connected: false,
      sessionId: 'test-session',
      sessionPath: directory,
    }),
    browserHookInvoker: async () => {
      hookCalls += 1;
      throw new Error('forced hook failure after rollback');
    },
  });
  const output = await runner.run(
    'original failing request',
    (chunk) => shown.push(chunk),
    {memoryMode: 'ephemeral'},
  );
  assert.equal(hookCalls, 1);
  assert.match(output, /inspected the fresh application state/);
  assert.match(shown.join(''), /Attempt 1 failed during application-action/);
  assert.match(shown.join(''), /Handing the error and fresh live state/);
  assert.match(shown.join(''), /Recovery completed after 1 agent-guided attempt/);
});

test('recovered managed turns record the original request instead of the internal recovery prompt', async () => {
  const records = [];
  const runner = new AgentRunner(fakeSession(), {update: async () => {}}, {
    workspaceRoot: '/tmp',
    recoveryAttempts: 2,
    conversationStore: {
      appendTurn: async (record) => records.push(record),
    },
  });
  const prompts = [];
  runner.runOnce = async (prompt, _onOutput, options) => {
    prompts.push({prompt, options});
    if (prompts.length === 1) {
      const error = new Error('temporary application verification failure');
      error.browserctlFailure = {
        phase: 'verification',
        sideEffects: 'uncertain',
        recoverable: true,
      };
      throw error;
    }
    return 'Recovered and verified the intended result.\n';
  };
  const shown = [];
  const output = await runner.run('keep this human request', (chunk) => shown.push(chunk), {
    memoryMode: 'managed',
  });
  assert.match(output, /Recovered and verified/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /AUTOMATIC FAILURE RECOVERY/);
  assert.equal(prompts[1].options.record, false);
  assert.equal(prompts[1].options.skipTurnHandlers, true);
  assert.deepEqual(records, [{
    agent: 'pi',
    user: 'keep this human request',
    assistant: 'Recovered and verified the intended result.',
    usage: null,
  }]);
});

test('after-turn failure recovers before committing one managed conversation record', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-after-turn-recovery-'));
  t.after(() => fsp.rm(directory, {recursive: true, force: true}));
  const executable = path.join(directory, 'fake-pi');
  await fsp.writeFile(executable, `#!/usr/bin/env node
'use strict';
if (process.argv.includes('rpc')) process.exit(2);
const prompt = process.argv.at(-1);
if (!prompt.includes('# AUTOMATIC FAILURE RECOVERY') ||
    !prompt.includes('application-after-turn')) process.exit(61);
process.stdout.write('I verified the requested effect was already complete and repaired the post-turn bookkeeping.\\n');
`, {mode: 0o700});
  await fsp.chmod(executable, 0o700);
  const previous = process.env.BROWSERCTL_PI_BIN;
  process.env.BROWSERCTL_PI_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTL_PI_BIN;
    else process.env.BROWSERCTL_PI_BIN = previous;
  });
  const records = [];
  let afterCalls = 0;
  const extension = {
    id: 'example-app',
    async handleTurn() {
      return {output: 'The application operation completed.'};
    },
    async afterTurn() {
      afterCalls += 1;
      if (afterCalls === 1) throw new Error('post-turn bookkeeping failed');
    },
  };
  const conversationStore = {
    activeId: 'conversation-1',
    ensureActive: async () => {},
    replayContext: async () => ({text: ''}),
    appendTurn: async (record) => records.push(record),
  };
  const runner = new AgentRunner(fakeSession(directory), {update: async () => {}}, {
    workspaceRoot: directory,
    agent: 'pi',
    extensions: [extension],
    conversationStore,
    memoryMode: 'managed',
    recoveryAttempts: 2,
    browserContextProvider: async () => ({
      connected: false,
      sessionId: 'test-session',
      sessionPath: directory,
    }),
  });
  const output = await runner.run('perform the operation', () => {}, {
    memoryMode: 'managed',
  });
  assert.match(output, /already complete/);
  assert.equal(afterCalls, 2);
  assert.equal(records.length, 1);
  assert.equal(records[0].user, 'perform the operation');
  assert.match(records[0].assistant, /already complete/);
});

test('general recovery is bounded and never retries a non-recoverable cancellation', async () => {
  const bounded = new AgentRunner(fakeSession(), {update: async () => {}}, {
    workspaceRoot: '/tmp',
    memoryMode: 'ephemeral',
    recoveryAttempts: 2,
  });
  let boundedCalls = 0;
  bounded.runOnce = async () => {
    boundedCalls += 1;
    throw new Error(`failure ${boundedCalls}`);
  };
  const boundedShown = [];
  await assert.rejects(
    bounded.run('try bounded recovery', (chunk) => boundedShown.push(chunk), {
      memoryMode: 'ephemeral',
    }),
    /failure 3/,
  );
  assert.equal(boundedCalls, 3);
  assert.match(boundedShown.join(''), /recovery 1\/2/);
  assert.match(boundedShown.join(''), /recovery 2\/2/);
  assert.match(boundedShown.join(''), /Automatic recovery stopped after 2/);

  const cancelled = new AgentRunner(fakeSession(), {update: async () => {}}, {
    workspaceRoot: '/tmp',
    memoryMode: 'ephemeral',
    recoveryAttempts: 2,
  });
  let cancelledCalls = 0;
  cancelled.runOnce = async () => {
    cancelledCalls += 1;
    const error = new Error('work was cancelled');
    error.browserctlFailure = {
      phase: 'cancelled',
      sideEffects: 'uncertain',
      recoverable: false,
    };
    throw error;
  };
  const cancelledShown = [];
  await assert.rejects(
    cancelled.run('cancel this', (chunk) => cancelledShown.push(chunk), {
      memoryMode: 'ephemeral',
    }),
    /cancelled/,
  );
  assert.equal(cancelledCalls, 1);
  assert.doesNotMatch(cancelledShown.join(''), /Handing the error/);
});

test('inline documents parse from JSON, @file, and reject malformed shapes', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-inline-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'sequence.json');
  await fsp.writeFile(
    filename,
    JSON.stringify({ agent: 'codex', verbose: true, steps: [{ command: 'status' }] }),
  );

  const direct = await readInlineSequence('["hello",{"command":"status"}]');
  assert.equal(direct.steps.length, 2);
  const fromFile = await readInlineSequence(`@${filename}`);
  assert.equal(fromFile.agent, 'codex');
  assert.equal(fromFile.verbose, true);
  await assert.rejects(() => readInlineSequence('{"query":"missing steps"}'), /steps array/);
  await assert.rejects(
    () => readInlineSequence('{"steps":[{"query":"x","mode":"mystery"}]}'),
    /step 0 mode/,
  );
  await assert.rejects(
    () => readInlineSequence('{"conversation":42,"steps":[]}'),
    /conversation must be a nonempty string/,
  );
});

test('inline execution preserves JSONL stdout and keeps agent details on stderr', async () => {
  const selected = [];
  const outputs = [];
  const errors = [];
  const agentRunner = {
    selected: 'pi',
    verbose: false,
    select: async function (agent, options) {
      selected.push({ agent, options });
      this.selected = agent;
    },
    setVerbose: function (enabled) {
      this.verbose = enabled;
    },
    run: async (_query, onOutput, options) => {
      onOutput('verbose event\n');
      assert.equal(options.verbose, true);
      return 'final answer\n';
    },
  };
  const runner = new InlineRunner({
    session: fakeSession(),
    browser: null,
    agentRunner,
    stdout: { write: (chunk) => outputs.push(chunk) },
    stderr: { write: (chunk) => errors.push(chunk) },
  });
  const result = await runner.run({
    agent: 'codex',
    verbose: true,
    continueOnError: false,
    steps: ['question', { command: 'status' }],
  });

  assert.equal(result.ok, true);
  assert.ok(selected.every((entry) => entry.options.persist === false));
  assert.equal(errors.join(''), 'verbose event\n');
  const lines = outputs.map((line) => JSON.parse(line));
  assert.equal(lines[0].result, 'final answer');
  assert.equal(lines[1].result.connected, false);
});

test('pi model preferences parse, resolve, apply, and persist', async () => {
  const { parsePiModelPreference } = require('../lib/agent-runner');
  assert.deepEqual(parsePiModelPreference('alpha-large'), { provider: null, id: 'alpha-large' });
  assert.deepEqual(parsePiModelPreference('alpha/alpha-large'), { provider: 'alpha', id: 'alpha-large' });
  assert.deepEqual(parsePiModelPreference({ provider: 'alpha', id: 'x' }), { provider: 'alpha', id: 'x' });
  assert.equal(parsePiModelPreference(''), null);
  assert.equal(parsePiModelPreference('alpha/'), null);

  const updates = [];
  const runner = new AgentRunner(fakeSession(), { update: async (session, patch) => updates.push(patch) }, {
    workspaceRoot: '/tmp/workspace',
  });
  const setCalls = [];
  runner.worker = {
    status: () => ({ model: { provider: 'alpha', id: 'alpha-small', name: 'alpha-small' } }),
    availableModels: async () => [
      { provider: 'alpha', id: 'alpha-small', name: 'alpha-small' },
      { provider: 'alpha', id: 'alpha-large', name: 'alpha-large' },
    ],
    setModel: async (model) => { setCalls.push(model); return model; },
  };

  // Bare id resolves its provider against the live worker and persists.
  const selected = await runner.setPiModel('alpha-large');
  assert.deepEqual(selected, { provider: 'alpha', id: 'alpha-large', name: 'alpha-large' });
  assert.deepEqual(setCalls, [{ provider: 'alpha', id: 'alpha-large', name: 'alpha-large' }]);
  assert.deepEqual(updates, [{ selectedPiModel: { provider: 'alpha', id: 'alpha-large' } }]);

  // Unknown ids are rejected with the available list, and nothing is persisted.
  await assert.rejects(() => runner.setPiModel('missing-model'), /not available/);
  assert.equal(updates.length, 1);
});

test('pi model preference precedence is option, then manifest, then environment', () => {
  const store = { update: async () => {} };
  const manifestSession = fakeSession();
  manifestSession.manifest.selectedPiModel = { provider: 'alpha', id: 'from-manifest' };

  process.env.BROWSERCTL_PI_MODEL = 'from-environment';
  try {
    const fromOption = new AgentRunner(manifestSession, store, { workspaceRoot: '/tmp/w', piModel: 'alpha/from-option' });
    assert.deepEqual(fromOption.piPreferredModel, { provider: 'alpha', id: 'from-option' });
    const fromManifest = new AgentRunner(manifestSession, store, { workspaceRoot: '/tmp/w' });
    assert.deepEqual(fromManifest.piPreferredModel, { provider: 'alpha', id: 'from-manifest' });
    const fromEnvironment = new AgentRunner(fakeSession(), store, { workspaceRoot: '/tmp/w' });
    assert.deepEqual(fromEnvironment.piPreferredModel, { provider: null, id: 'from-environment' });
  } finally {
    delete process.env.BROWSERCTL_PI_MODEL;
  }
});
