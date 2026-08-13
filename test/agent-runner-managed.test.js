'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentRunner } = require('../lib/agent-runner');
const { ConversationStore } = require('../lib/conversation-store');
const { SessionStore } = require('../lib/session-store');

async function fixture(t, source) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-runner-test-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, 'fake-pi');
  await fsp.writeFile(executable, source, { mode: 0o700 });
  await fsp.chmod(executable, 0o700);
  const store = new SessionStore(path.join(temporary, 'weekly-logs'), {
    targetUrl: 'http://127.0.0.1/example/',
  });
  const session = await store.create({ now: new Date(2026, 6, 27) });
  const conversations = await new ConversationStore(session).initialize();
  await conversations.create();
  const previous = process.env.BROWSERCTL_PI_BIN;
  process.env.BROWSERCTL_PI_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTL_PI_BIN;
    else process.env.BROWSERCTL_PI_BIN = previous;
  });
  const runner = new AgentRunner(session, store, {
    workspaceRoot: temporary,
    agent: 'pi',
    memoryMode: 'managed',
    conversationStore: conversations,
    browserContextProvider: async () => ({
      connected: false,
      sessionId: session.id,
      sessionPath: session.directory,
      targetUrl: session.manifest.targetUrl,
    }),
  });
  t.after(() => runner.stop());
  return { conversations, runner, session };
}

test('managed mode visibly falls back without native persistence and records only the final', async (t) => {
  const { conversations, runner, session } = await fixture(t, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (args.includes('rpc')) {
  process.stderr.write('rpc intentionally unavailable\\n');
  process.exit(2);
}
if (!args.includes('--no-session')) process.exit(9);
process.stdout.write('fallback-final\\n');
`);
  const shown = [];
  const output = await runner.run('fallback request', (chunk) => shown.push(chunk));
  assert.equal(output.trim(), 'fallback-final');
  assert.match(shown.join(''), /\[managed fallback\].*fresh nonpersistent process/);
  const status = await runner.status();
  assert.equal(status.worker.running, false);
  assert.match(status.fallback.reason, /exited with code 2/);

  const records = await conversations.records();
  const turn = records.find((record) => record.type === 'turn');
  assert.equal(turn.user, 'fallback request');
  assert.equal(turn.assistant, 'fallback-final');
  assert.equal(turn.usage, null);
  assert.deepEqual(
    (await fsp.readdir(session.paths.logs)).sort(),
    ['README.md'],
  );
});

test('managed Pi safely changes configured model after a tool-free empty pass', async (t) => {
  const {conversations, runner} = await fixture(t, `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let prompts = 0;
let currentModel = 'empty-model';
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    send({type: 'response', id: request.id, success: true, data: {
      sessionFile: null, model: {provider: 'test', id: 'empty-model', name: 'empty-model'},
    }});
  } else if (request.type === 'get_available_models') {
    send({type: 'response', id: request.id, success: true, data: {models: [
      {provider: 'test', id: 'empty-model', name: 'empty-model'},
      {provider: 'test', id: 'working-default', name: 'working-default'},
      {provider: 'test', id: 'working-model', name: 'working-model'},
    ]}});
  } else if (request.type === 'set_model') {
    currentModel = request.modelId;
    send({type: 'response', id: request.id, success: true, data: {
      provider: request.provider, id: request.modelId, name: request.modelId,
    }});
  } else if (request.type === 'prompt') {
    send({type: 'response', id: request.id, success: true});
    prompts += 1;
    if (currentModel === 'empty-model') {
      send({type: 'message_end', message: {role: 'assistant', content: [
        {type: 'thinking', thinking: 'model loader status only'},
      ]}});
    } else {
      send({type: 'message_end', message: {role: 'assistant', content: [
        {type: 'text', text: 'completed after safe model failover'},
      ]}});
    }
    send({type: 'agent_end'});
  }
});
`);
  const shown = [];
  const output = await runner.run('complete this request', (chunk) => shown.push(chunk));
  assert.match(output, /completed after safe model failover/);
  assert.match(shown.join(''), /empty-model completed an empty, tool-free pass/);
  assert.match(shown.join(''), /Trying configured model working-default/);
  await runner.stopWorker();
  const secondShown = [];
  const second = await runner.run('complete another request', (chunk) => secondShown.push(chunk));
  assert.match(second, /completed after safe model failover/);
  assert.match(secondShown.join(''), /Using previously responsive Pi model working-default/);
  assert.doesNotMatch(secondShown.join(''), /empty, tool-free pass/);
  const turns = (await conversations.records()).filter((record) => record.type === 'turn');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].assistant, 'completed after safe model failover');
});

test('cancelling a managed live turn discards it and the worker', async (t) => {
  const { conversations, runner } = await fixture(t, `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    send({ type: 'response', id: request.id, success: true, data: { sessionFile: null } });
  } else if (request.type === 'prompt') {
    send({ type: 'response', id: request.id, success: true });
  } else if (request.type === 'abort') {
    send({ type: 'response', id: request.id, success: true });
    send({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    });
    send({ type: 'agent_end' });
  }
});
`);
  const running = runner.run('long request', () => {});
  const deadline = Date.now() + 2_000;
  while (!(await runner.status()).worker.activeTurn && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await runner.status()).worker.activeTurn, true);
  assert.equal(runner.cancel(), true);
  await assert.rejects(running, /was cancelled/);
  assert.equal((await conversations.records()).filter((record) => record.type === 'turn').length, 0);
  assert.equal((await runner.status()).worker.running, false);
});

test('a successful agent process with no final response fails visibly and is not recorded', async (t) => {
  const { conversations, runner } = await fixture(t, `#!/usr/bin/env node
'use strict';
if (process.argv.includes('rpc')) process.exit(2);
process.exit(0);
`);
  const activity = [];
  await assert.rejects(
    runner.run('silent request', () => {}, {
      onActivity: (value) => activity.push(value),
    }),
    /completed without a final response.*No browser change was confirmed.*Enable \/verbose on/s,
  );
  assert.equal((await conversations.records()).filter((record) => record.type === 'turn').length, 0);
  assert.equal((await runner.status()).worker.running, false);
  assert.deepEqual(activity, [{type: 'agent', agent: 'pi', label: 'pi'}]);
});
