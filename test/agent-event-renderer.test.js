'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assistantText,
  renderAgentEvent,
} = require('../lib/agent-event-renderer');

test('Pi verbose events render as readable progress instead of raw JSON', () => {
  assert.deepEqual(renderAgentEvent('pi', { type: 'agent_start' }), {
    text: '[pi] starting\n',
  });
  assert.deepEqual(
    renderAgentEvent('pi', {
      type: 'tool_execution_start',
      toolName: 'browserctl',
      args: { action: 'state' },
    }),
    { text: '[pi] tool browserctl action=state\n' },
  );
  assert.deepEqual(
    renderAgentEvent('pi', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Checking the page…' },
    }),
    { text: 'Checking the page…', stream: true, assistant: true },
  );
  assert.deepEqual(
    renderAgentEvent('pi', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    }),
    { text: '' },
  );
});

test('assistant final text is extracted from Pi, Codex, and Claude event shapes', () => {
  assert.equal(
    assistantText({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Pi answer' }] },
    }),
    'Pi answer',
  );
  assert.equal(
    assistantText({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', text: 'Codex answer' } },
    }),
    'Codex answer',
  );
  assert.equal(
    assistantText({ type: 'result', result: 'Claude answer' }, 'claude-jsonl'),
    'Claude answer',
  );
});
