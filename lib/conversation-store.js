'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sanitizeFilename, timestamp } = require('./utils');

const INDEX_NAME = 'index.json';

function conversationId(now = new Date()) {
  const date = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
  return `conversation-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

class ConversationStore {
  constructor(session) {
    this.session = session;
    this.root = session.paths.conversations;
    this.indexPath = path.join(this.root, INDEX_NAME);
    this.index = null;
    this.activeId = null;
  }

  async initialize() {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.root, 0o700);
    try {
      this.index = JSON.parse(await fsp.readFile(this.indexPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.name === 'SyntaxError') {
          throw new Error(
            `Conversation index is invalid JSON and was left untouched: ${this.indexPath}`,
            { cause: error },
          );
        }
        throw error;
      }
      this.index = {
        version: 1,
        activeId: null,
        conversations: [],
      };
      await this.writeIndex();
    }
    this.index.conversations = Array.isArray(this.index.conversations)
      ? this.index.conversations
      : [];
    this.activeId = this.index.activeId || null;
    return this;
  }

  async writeIndex() {
    const temporary = path.join(
      this.root,
      `.${INDEX_NAME}.${process.pid}.${Date.now()}.tmp`,
    );
    await fsp.writeFile(temporary, `${JSON.stringify(this.index, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsp.rename(temporary, this.indexPath);
    await fsp.chmod(this.indexPath, 0o600);
  }

  filePath(id) {
    if (!this.index?.conversations.some((item) => item.id === id)) {
      throw new Error(`Unknown conversation: ${id}`);
    }
    return path.join(this.root, `${id}.jsonl`);
  }

  async appendRecord(id, record) {
    const filename = this.filePath(id);
    await fsp.appendFile(filename, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsp.chmod(filename, 0o600);
  }

  list() {
    return [...(this.index?.conversations || [])].sort((left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
  }

  async create(name = null) {
    const now = timestamp();
    const id = conversationId();
    const item = {
      id,
      name: name ? sanitizeFilename(name, id) : null,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      checkpointCount: 0,
      lastAgent: null,
    };
    this.index.conversations.push(item);
    this.index.activeId = id;
    this.activeId = id;
    await fsp.writeFile(
      path.join(this.root, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'conversation',
        version: 1,
        id,
        name: item.name,
        createdAt: now,
      })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await this.writeIndex();
    return item;
  }

  async ensureActive(options = {}) {
    if (!this.index) await this.initialize();
    if (options.newConversation) return this.create(options.name);
    if (this.activeId && this.index.conversations.some((item) => item.id === this.activeId)) {
      return this.status();
    }
    const latest = this.list()[0];
    if (latest) return this.resume(latest.id);
    return this.create(options.name);
  }

  async resume(idOrLatest) {
    if (!this.index) await this.initialize();
    const item = idOrLatest === 'latest'
      ? this.list()[0]
      : this.index.conversations.find((candidate) => candidate.id === idOrLatest);
    if (!item) throw new Error(`Conversation not found: ${idOrLatest}`);
    this.activeId = item.id;
    this.index.activeId = item.id;
    await this.writeIndex();
    return this.status();
  }

  async records(id = this.activeId) {
    if (!id) return [];
    const content = await fsp.readFile(this.filePath(id), 'utf8');
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`Invalid conversation JSONL at ${id}:${index + 1}`);
        }
      });
  }

  async appendTurn({ agent, user, assistant, usage = null }) {
    if (!this.activeId) await this.ensureActive();
    const now = timestamp();
    const record = {
      type: 'turn',
      id: crypto.randomUUID(),
      timestamp: now,
      agent,
      user,
      assistant,
      usage,
    };
    await this.appendRecord(this.activeId, record);
    const item = this.index.conversations.find((candidate) => candidate.id === this.activeId);
    item.updatedAt = now;
    item.turnCount += 1;
    item.lastAgent = agent;
    await this.writeIndex();
    return record;
  }

  async appendCheckpoint({ agent, summary, instructions = null }) {
    if (!this.activeId) throw new Error('No active managed conversation.');
    const records = await this.records();
    const lastTurn = [...records].reverse().find((record) => record.type === 'turn');
    const now = timestamp();
    const record = {
      type: 'checkpoint',
      id: crypto.randomUUID(),
      timestamp: now,
      agent,
      summary,
      instructions,
      throughTurnId: lastTurn?.id || null,
    };
    await this.appendRecord(this.activeId, record);
    const item = this.index.conversations.find((candidate) => candidate.id === this.activeId);
    item.updatedAt = now;
    item.checkpointCount += 1;
    item.lastAgent = agent;
    await this.writeIndex();
    return record;
  }

  async replayContext(id = this.activeId) {
    if (!id) return { text: '', recordCount: 0, turnCount: 0, estimatedTokens: 0 };
    const records = await this.records(id);
    let start = 0;
    let checkpoint = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].type === 'checkpoint') {
        checkpoint = records[index];
        start = index + 1;
        break;
      }
    }
    const turns = records.slice(start).filter((record) => record.type === 'turn');
    const parts = [
      '# SERVICE-MANAGED CONVERSATION CONTEXT',
      '',
      'This is trusted continuity reconstructed by the launcher. Native agent session persistence remains disabled. Use this background to interpret the new request, but re-check the live browser and filesystem before acting.',
    ];
    if (checkpoint) {
      parts.push(
        '',
        `## Compact checkpoint (${checkpoint.timestamp}, agent=${checkpoint.agent})`,
        '',
        checkpoint.summary,
      );
    }
    for (const turn of turns) {
      parts.push(
        '',
        `## Prior user request (${turn.timestamp})`,
        '',
        turn.user,
        '',
        `## Prior final answer (agent=${turn.agent})`,
        '',
        turn.assistant,
      );
    }
    const text = checkpoint || turns.length ? `${parts.join('\n')}\n` : '';
    return {
      text,
      recordCount: records.length,
      turnCount: turns.length,
      checkpointId: checkpoint?.id || null,
      estimatedTokens: estimateTokens(text),
    };
  }

  async status() {
    if (!this.activeId) {
      return {
        active: false,
        id: null,
        conversationCount: this.index?.conversations?.length || 0,
      };
    }
    const item = this.index.conversations.find((candidate) => candidate.id === this.activeId);
    if (!item) throw new Error(`Active conversation is missing: ${this.activeId}`);
    const replay = await this.replayContext();
    return {
      active: true,
      ...item,
      conversationCount: this.index.conversations.length,
      replayTurnCount: replay.turnCount,
      replayEstimatedTokens: replay.estimatedTokens,
      checkpointId: replay.checkpointId,
      path: this.filePath(this.activeId),
    };
  }
}

module.exports = {
  ConversationStore,
  conversationId,
  estimateTokens,
};
