'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ClaudeStreamWorker,
  CodexAppServerWorker,
  PiRpcWorker,
} = require('../lib/agent-workers');

const FAKE_AGENT = `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
let remembered = null;
let turn = 0;
const answer = (prompt) => {
  const match = String(prompt).match(/remember[: ]+([a-z]+-[a-z]+)/i);
  if (match) {
    remembered = match[1];
    return 'stored ' + remembered;
  }
  if (/recall|value/i.test(String(prompt))) return remembered || 'none';
  return 'ok';
};

if (args.includes('--mode') && args.includes('rpc')) {
  if (!args.includes('--no-session')) process.exit(51);
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.type === 'get_state') {
      send({ type: 'response', id: request.id, success: true, data: { sessionFile: null } });
    } else if (request.type === 'prompt') {
      send({ type: 'response', id: request.id, success: true });
      if (String(request.message).includes('proposal-only')) {
        const proposal = {
          capability: 'example.edit', target: 'ads', operation: 'upsert', resources: [],
        };
        send({type: 'tool_execution_start', toolCallId: 'semantic-1',
          toolName: 'browserctl_propose_action', args: proposal});
        send({type: 'tool_execution_end', toolCallId: 'semantic-1',
          toolName: 'browserctl_propose_action', args: proposal, isError: false});
        send({ type: 'agent_end' });
        return;
      }
      const text = answer(request.message);
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
      send({ type: 'agent_end' });
    } else if (request.type === 'abort') {
      send({ type: 'response', id: request.id, success: true });
      send({ type: 'agent_end' });
    }
  });
} else if (args[0] === 'app-server') {
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      send({ id: request.id, result: { userAgent: 'fake-codex' } });
    } else if (request.method === 'thread/start') {
      send({
        id: request.id,
        result: { thread: { id: 'ephemeral-test-thread', ephemeral: request.params.ephemeral === true } },
      });
    } else if (request.method === 'turn/start') {
      const id = 'turn-' + (++turn);
      const text = answer(request.params.input[0].text);
      send({ id: request.id, result: { turn: { id } } });
      setImmediate(() => {
        send({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
        send({
          method: 'thread/tokenUsage/updated',
          params: { tokenUsage: { last: { inputTokens: 11, outputTokens: 3 } } },
        });
        send({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
      });
    } else if (request.method === 'turn/interrupt') {
      send({ id: request.id, result: {} });
    }
  });
} else {
  if (!args.includes('--no-session-persistence') || !args.includes('--no-chrome') ||
      !args.includes('stream-json')) process.exit(52);
  send({ type: 'system', subtype: 'init', session_id: 'memory-only-test' });
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    const prompt = request.message.content[0].text;
    const text = answer(prompt);
    send({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      usage: { input_tokens: 9, output_tokens: 2 },
    });
  });
}
`;

async function fakeExecutable(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-worker-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'fake-agent');
  await fsp.writeFile(executable, FAKE_AGENT, { mode: 0o700 });
  await fsp.chmod(executable, 0o700);
  return { directory, executable };
}

async function exerciseWorker(t, Worker, agent) {
  const { directory, executable } = await fakeExecutable(t);
  const worker = new Worker({
    command: executable,
    cwd: directory,
    env: { ...process.env },
  });
  t.after(() => worker.stop());
  await worker.start();
  const firstPid = worker.status().pid;
  const quietOutput = [];
  const first = await worker.run(
    'Please remember cobalt-orchid.',
    (chunk) => quietOutput.push(chunk),
    false,
  );
  const second = await worker.run(
    'Recall the value.',
    (chunk) => quietOutput.push(chunk),
    false,
  );
  assert.match(first.output, /stored cobalt-orchid/);
  assert.equal(second.output.trim(), 'cobalt-orchid');
  assert.equal(worker.status().pid, firstPid);
  assert.equal(worker.status().agent, agent);
  assert.equal(worker.status().running, true);
  assert.match(quietOutput.join(''), /cobalt-orchid/);
  return worker;
}

test('Pi RPC worker keeps RAM continuity with native sessions disabled', async (t) => {
  const worker = await exerciseWorker(t, PiRpcWorker, 'pi');
  assert.equal(worker.status().protocol, 'pi-rpc/no-session');
});

test('Pi RPC worker preserves a successful semantic tool-only turn without final text', async (t) => {
  const {directory, executable} = await fakeExecutable(t);
  const worker = new PiRpcWorker({command: executable, cwd: directory, env: {...process.env}});
  t.after(() => worker.stop());
  await worker.start();
  const announced = [];
  const result = await worker.run('proposal-only', () => {}, false, {
    onSemanticProposal: (proposal) => announced.push(proposal),
  });
  assert.equal(result.output, '');
  assert.deepEqual(result.semanticProposals, [{
    proposal: {capability: 'example.edit', target: 'ads', operation: 'upsert', resources: []},
    executed: false,
    failed: false,
  }]);
  assert.deepEqual(announced, result.semanticProposals.map((entry) => entry.proposal));
});

test('Codex app-server worker uses one ephemeral in-memory thread', async (t) => {
  const worker = await exerciseWorker(t, CodexAppServerWorker, 'codex');
  assert.equal(worker.status().threadEphemeral, true);
  assert.equal(worker.status().threadIdInMemory, 'ephemeral-test-thread');
  assert.deepEqual(worker.status().usage, { inputTokens: 11, outputTokens: 3 });
});

test('Claude stream worker keeps continuity with transcript persistence disabled', async (t) => {
  const worker = await exerciseWorker(t, ClaudeStreamWorker, 'claude');
  assert.equal(worker.status().transcriptPersistence, false);
  assert.deepEqual(worker.status().usage, { input_tokens: 9, output_tokens: 2 });
});

test('Pi RPC worker marks bridge-executed semantic actions as executed', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'browserctl-worker-executed-'));
  t.after(() => fsp.rm(directory, {recursive: true, force: true}));
  const executable = path.join(directory, 'fake-pi');
  await fsp.writeFile(executable, `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const rl = readline.createInterface({input: process.stdin});
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'get_state') {
    send({id: message.id, type: 'response', command: 'get_state', success: true, data: {}});
    return;
  }
  if (message.type === 'prompt') {
    const args = {capability: 'example.edit', target: 'ads', operation: 'add', resources: []};
    send({type: 'tool_execution_start', toolCallId: 'act-1', toolName: 'browserctl_propose_action', args});
    send({type: 'tool_execution_end', toolCallId: 'act-1', toolName: 'browserctl_propose_action',
      args, isError: false, result: {details: {proposal: args, executed: true, output: 'verified'}}});
    send({type: 'agent_end'});
    send({id: message.id, type: 'response', command: 'prompt', success: true, data: {}});
  }
});
`, {mode: 0o700});
  const worker = new PiRpcWorker({command: executable, cwd: directory, env: process.env});
  t.after(() => worker.stop());
  await worker.start();
  const result = await worker.run('do the thing', () => {}, false, {});
  assert.deepEqual(result.semanticProposals, [{
    proposal: {capability: 'example.edit', target: 'ads', operation: 'add', resources: []},
    executed: true,
    failed: false,
  }]);
});
