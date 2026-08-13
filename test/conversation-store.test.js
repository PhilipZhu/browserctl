'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ConversationStore } = require('../lib/conversation-store');
const { SessionStore } = require('../lib/session-store');

async function temporaryConversationStore(t) {
  const temporary = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'browserctl-conversation-test-'),
  );
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const sessions = new SessionStore(path.join(temporary, 'weekly-logs'), {
    targetUrl: 'http://127.0.0.1/example/',
  });
  const session = await sessions.create({ now: new Date(2026, 6, 27) });
  const conversations = await new ConversationStore(session).initialize();
  return { conversations, session };
}

test('stores only service-managed turn finals and owner-protects conversation files', async (t) => {
  const { conversations, session } = await temporaryConversationStore(t);
  const created = await conversations.create('Primary continuity');
  await conversations.appendTurn({
    agent: 'pi',
    user: 'Remember cobalt-orchid.',
    assistant: 'I will remember cobalt-orchid.',
    usage: { inputTokens: 12, outputTokens: 7 },
  });
  await conversations.appendTurn({
    agent: 'codex',
    user: 'What was the value?',
    assistant: 'cobalt-orchid',
  });

  const records = await conversations.records();
  assert.deepEqual(
    records.map((record) => record.type),
    ['conversation', 'turn', 'turn'],
  );
  const raw = await fsp.readFile(conversations.filePath(created.id), 'utf8');
  assert.match(raw, /cobalt-orchid/);
  assert.doesNotMatch(raw, /tool_call|reasoning|stderr|nativeSessionId/);

  const rootMode = (await fsp.stat(session.paths.conversations)).mode & 0o777;
  const indexMode = (await fsp.stat(conversations.indexPath)).mode & 0o777;
  const recordMode = (await fsp.stat(conversations.filePath(created.id))).mode & 0o777;
  assert.equal(rootMode, 0o700);
  assert.equal(indexMode, 0o600);
  assert.equal(recordMode, 0o600);

  const status = await conversations.status();
  assert.equal(status.turnCount, 2);
  assert.equal(status.lastAgent, 'codex');
  assert.equal(status.replayTurnCount, 2);
});

test('compact checkpoints supersede older replay while preserving records', async (t) => {
  const { conversations } = await temporaryConversationStore(t);
  await conversations.create();
  await conversations.appendTurn({
    agent: 'pi',
    user: 'An old verbose request that should not be replayed.',
    assistant: 'An old verbose answer that should not be replayed.',
  });
  const checkpoint = await conversations.appendCheckpoint({
    agent: 'pi',
    summary: 'Durable fact: cobalt-orchid is the stored value.',
    instructions: 'Keep the exact value.',
  });
  await conversations.appendTurn({
    agent: 'claude',
    user: 'A newer request.',
    assistant: 'A newer answer.',
  });

  const replay = await conversations.replayContext();
  assert.equal(replay.checkpointId, checkpoint.id);
  assert.equal(replay.turnCount, 1);
  assert.match(replay.text, /Durable fact: cobalt-orchid/);
  assert.match(replay.text, /A newer request/);
  assert.doesNotMatch(replay.text, /old verbose request/);
  assert.equal((await conversations.records()).length, 4);
});

test('supports new, list, latest, and explicit conversation selection', async (t) => {
  const { conversations, session } = await temporaryConversationStore(t);
  const first = await conversations.create('first');
  await conversations.appendTurn({
    agent: 'pi',
    user: 'first request',
    assistant: 'first answer',
  });
  const second = await conversations.create('second');
  assert.equal(conversations.list().length, 2);
  await conversations.resume(first.id);
  assert.equal((await conversations.status()).id, first.id);

  const reopened = await new ConversationStore(session).initialize();
  await reopened.resume('latest');
  assert.equal((await reopened.status()).id, second.id);
});

test('does not overwrite a malformed conversation index', async (t) => {
  const { conversations, session } = await temporaryConversationStore(t);
  await fsp.writeFile(conversations.indexPath, '{broken json', 'utf8');
  const reopened = new ConversationStore(session);
  await assert.rejects(() => reopened.initialize(), /invalid JSON.*left untouched/);
  assert.equal(await fsp.readFile(conversations.indexPath, 'utf8'), '{broken json');
});
