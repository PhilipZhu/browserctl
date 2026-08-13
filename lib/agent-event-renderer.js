'use strict';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (typeof part === 'string' || typeof part === 'object'))
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function truncate(value, maximum = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function valueSummary(value, maximum = 180) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return truncate(value, maximum);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const fields = Object.entries(value)
      .slice(0, 4)
      .map(([key, item]) => {
        if (item === null || item === undefined) return `${key}=none`;
        if (typeof item === 'object') {
          return `${key}=${Array.isArray(item) ? `${item.length} items` : 'details'}`;
        }
        return `${key}=${truncate(item, 72)}`;
      });
    const suffix = Object.keys(value).length > fields.length ? ' …' : '';
    return truncate(`${fields.join(' ')}${suffix}`, maximum);
  }
  return truncate(String(value), maximum);
}

function assistantText(event, mode = null) {
  if (
    mode === 'codex-jsonl' &&
    event.type === 'item.completed' &&
    ['agent_message', 'agentMessage'].includes(event.item?.type)
  ) {
    return event.item.text || textFromContent(event.item.content);
  }
  if (
    event.method === 'item/completed' &&
    ['agent_message', 'agentMessage'].includes(event.params?.item?.type)
  ) {
    return event.params.item.text || textFromContent(event.params.item.content);
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    return textFromContent(event.message.content);
  }
  if (mode === 'claude-jsonl' && event.type === 'result') {
    return typeof event.result === 'string'
      ? event.result
      : textFromContent(event.result?.content);
  }
  if (event.type === 'assistant' && event.message?.role === 'assistant') {
    return textFromContent(event.message.content);
  }
  return '';
}

function assistantDelta(event) {
  const update = event.assistantMessageEvent || event.params?.assistantMessageEvent;
  if (!update || typeof update !== 'object') return '';
  if (update.type === 'text_delta' && typeof update.delta === 'string') return update.delta;
  return '';
}

function renderAgentEvent(agent, event) {
  const prefix = `[${agent}]`;
  const type = event.type || event.method || 'event';
  const delta = assistantDelta(event);
  if (delta) return { text: delta, stream: true, assistant: true };
  if (assistantText(event, agent === 'claude' ? 'claude-jsonl' : null)) return { text: '' };

  if (type === 'session') {
    return { text: `${prefix} session ${event.id || 'started'}\n` };
  }
  if (type === 'agent_start') return { text: `${prefix} starting\n` };
  if (type === 'agent_end') return { text: `${prefix} finished\n` };
  if (type === 'turn_start') return { text: `${prefix} thinking…\n` };
  if (type === 'turn_end') return { text: `${prefix} turn complete\n` };
  if (type === 'message_start' && event.message?.role === 'assistant') {
    return { text: `${prefix} responding…\n` };
  }
  if (type === 'tool_execution_start') {
    const suffix = valueSummary(event.args);
    return { text: `${prefix} tool ${event.toolName || 'call'}${suffix ? ` ${suffix}` : ''}\n` };
  }
  if (type === 'tool_execution_end') {
    const status = event.isError ? 'failed' : 'done';
    const detail = event.isError ? valueSummary(event.result) : '';
    return {
      text: `${prefix} ${event.toolName || 'tool'} ${status}${detail ? `: ${detail}` : ''}\n`,
    };
  }
  if (type === 'item/started') {
    const item = event.params?.item || {};
    return { text: `${prefix} ${item.type || 'work'} started\n` };
  }
  if (type === 'item/completed' && !assistantText(event)) {
    const item = event.item || event.params?.item || {};
    return { text: `${prefix} ${item.type || 'work'} complete\n` };
  }
  if (type === 'auto_retry_start') {
    return {
      text: `${prefix} retry ${event.attempt || '?'}${event.maxAttempts ? `/${event.maxAttempts}` : ''}: ${truncate(event.errorMessage || 'transient error')}\n`,
    };
  }
  if (type === 'compaction_start') return { text: `${prefix} compacting context…\n` };
  if (type === 'compaction_end') {
    return { text: `${prefix} context compaction ${event.aborted ? 'stopped' : 'complete'}\n` };
  }
  if (type === 'error' || event.error) {
    const message = event.message || event.error?.message || event.error;
    return { text: `${prefix} error: ${valueSummary(message)}\n`, error: true };
  }
  return { text: `${prefix} ${type}\n` };
}

module.exports = {
  assistantDelta,
  assistantText,
  renderAgentEvent,
  textFromContent,
  truncate,
  valueSummary,
};
