'use strict';

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  assistantText,
  renderAgentEvent,
  textFromContent,
  truncate,
} = require('./agent-event-renderer');

const PI_SEMANTIC_EXTENSION = path.join(__dirname, 'pi-semantic-extension.ts');

function piIsolationArgs() {
  return [
    '--no-context-files',
    '--no-extensions',
    '--extension',
    PI_SEMANTIC_EXTENSION,
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
  ];
}

function emitStructuredEvent(turn, agent, event) {
  if (!turn?.verbose) return;
  const rendered = renderAgentEvent(agent, event);
  if (rendered?.text) {
    if (rendered.stream) {
      turn.onOutput(rendered.text);
      turn.streamedAssistantText = `${turn.streamedAssistantText || ''}${rendered.text}`;
      turn.assistantLineOpen = true;
    } else {
      if (turn.assistantLineOpen) {
        turn.onOutput('\n');
        turn.assistantLineOpen = false;
      }
      turn.onOutput(rendered.text);
    }
  }
  const finalText = assistantText(event);
  if (!finalText || finalText === turn.lastRenderedFinal) return;
  if (turn.assistantLineOpen) {
    if (turn.streamedAssistantText !== finalText) turn.onOutput('\n');
    turn.assistantLineOpen = false;
  }
  if (turn.streamedAssistantText !== finalText) turn.onOutput(`${finalText}\n`);
  turn.lastRenderedFinal = finalText;
  turn.streamedAssistantText = '';
}

class JsonLineWorker {
  constructor(options) {
    this.agent = options.agent;
    this.command = options.command;
    this.args = options.args;
    this.cwd = options.cwd;
    this.env = options.env;
    this.child = null;
    this.readline = null;
    this.stderr = '';
    this.requestId = 0;
    this.requests = new Map();
    this.pendingTurn = null;
    this.startedAt = null;
    this.protocol = options.protocol;
  }

  spawn() {
    if (this.child && this.child.exitCode === null) return;
    this.stderr = '';
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.startedAt = new Date().toISOString();
    this.readline = readline.createInterface({ input: this.child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderr += text;
      if (this.pendingTurn?.verbose) {
        this.pendingTurn.onOutput(`[${this.agent}:stderr] ${text}`);
      }
    });
    this.child.once('error', (error) => this.handleExit(error));
    this.child.once('close', (code, signal) => {
      this.handleExit(
        new Error(
          `${this.agent} ${this.protocol} worker exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}${this.stderr.trim() ? `: ${this.stderr.trim().slice(-600)}` : ''}`,
        ),
      );
    });
  }

  send(message) {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) {
      throw new Error(`${this.agent} ${this.protocol} worker is not writable.`);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 15_000) {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`${this.agent} ${method} request timed out.`));
      }, timeoutMs);
      timeout.unref();
      this.requests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.send(this.requestMessage(id, method, params));
      } catch (error) {
        this.requests.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  handleResponse(id, result, error) {
    const pending = this.requests.get(id);
    if (!pending) return false;
    this.requests.delete(id);
    if (error) {
      pending.reject(
        new Error(
          `${this.agent} protocol error: ${error.message || JSON.stringify(error)}`,
        ),
      );
    } else {
      pending.resolve(result);
    }
    return true;
  }

  handleExit(error) {
    for (const pending of this.requests.values()) pending.reject(error);
    this.requests.clear();
    if (this.pendingTurn) {
      this.pendingTurn.reject(error);
      this.pendingTurn = null;
    }
    this.readline?.close();
    this.readline = null;
    this.child = null;
  }

  stop(signal = 'SIGTERM') {
    if (!this.child || this.child.exitCode !== null) return;
    const child = this.child;
    child.kill(signal);
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000).unref();
  }

  status() {
    return {
      agent: this.agent,
      protocol: this.protocol,
      running: Boolean(this.child && this.child.exitCode === null),
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      activeTurn: Boolean(this.pendingTurn),
      activeToolCount: this.pendingTurn?.toolActivity?.length || 0,
      activeToolName: this.pendingTurn?.toolActivity?.at(-1)?.toolName || null,
    };
  }
}

class PiRpcWorker extends JsonLineWorker {
  constructor(options) {
    super({
      ...options,
      agent: 'pi',
      args: ['--mode', 'rpc', '--no-session', ...piIsolationArgs()],
      protocol: 'pi-rpc/no-session',
    });
    this.model = null;
  }

  requestMessage(id, method, params) {
    return { id: String(id), type: method, ...(params || {}) };
  }

  async start() {
    this.spawn();
    const state = await this.request('get_state', null);
    if (state?.data?.sessionFile) {
      throw new Error('Pi RPC unexpectedly created a persistent session file.');
    }
    this.model = state?.data?.model || null;
    return this.status();
  }

  async cycleModel() {
    const response = await this.request('cycle_model', null);
    this.model = response?.data?.model || response?.data || null;
    return this.model;
  }

  async availableModels() {
    const response = await this.request('get_available_models', null);
    return Array.isArray(response?.data?.models) ? response.data.models : [];
  }

  async setModel(model) {
    if (!model?.provider || !model?.id) throw new Error('Pi model selection requires provider and id.');
    const response = await this.request('set_model', {
      provider: model.provider,
      modelId: model.id,
    });
    this.model = response?.data || model;
    return this.model;
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (this.pendingTurn?.verbose) this.pendingTurn.onOutput(`[pi] ${truncate(line, 320)}\n`);
      return;
    }
    if (
      message.type === 'response' &&
      message.id !== undefined &&
      this.handleResponse(Number(message.id), message, message.success === false ? message.error : null)
    ) {
      return;
    }
    const turn = this.pendingTurn;
    if (!turn) return;
    emitStructuredEvent(turn, 'pi', message);
    if (message.type === 'tool_execution_start') {
      turn.toolActivity.push({toolName: message.toolName, args: message.args});
    }
    if (message.type === 'tool_execution_start' &&
        message.toolName === 'browserctl_propose_action') {
      turn.semanticToolCalls.set(message.toolCallId, message.args);
      turn.onSemanticProposal?.(message.args);
    }
    if (message.type === 'tool_execution_end' &&
        message.toolName === 'browserctl_propose_action') {
      const proposal = turn.semanticToolCalls.get(message.toolCallId) || message.args;
      turn.semanticToolCalls.delete(message.toolCallId);
      if (proposal) {
        const details = message.result?.details;
        turn.semanticProposals.push({
          proposal,
          executed: details?.executed === true,
          failed: Boolean(message.isError || details?.failed),
        });
      }
    }
    if (message.type === 'tool_execution_end' &&
        message.toolName === 'browserctl_update_workflow' && !message.isError) {
      const update = message.args || message.result?.details?.workflowUpdate;
      if (update) turn.workflowUpdates.push(update);
    }
    if (message.type === 'message_end' && message.message?.role === 'assistant') {
      const text = textFromContent(message.message.content);
      if (text) turn.output = text;
    }
    if (message.type === 'agent_end') {
      this.pendingTurn = null;
      if (!turn.verbose && turn.output) turn.onOutput(`${turn.output}\n`);
      turn.resolve({
        output: turn.output ? `${turn.output}\n` : '',
        usage: null,
        semanticProposals: turn.semanticProposals,
        workflowUpdates: turn.workflowUpdates,
        toolActivity: turn.toolActivity,
      });
    }
  }

  run(prompt, onOutput, verbose, options = {}) {
    if (this.pendingTurn) throw new Error('Pi already has an active turn.');
    return new Promise((resolve, reject) => {
      this.pendingTurn = {
        output: '',
        onOutput,
        verbose,
        onSemanticProposal: options.onSemanticProposal,
        semanticToolCalls: new Map(),
        semanticProposals: [],
        workflowUpdates: [],
        toolActivity: [],
        resolve,
        reject,
      };
      void this.request('prompt', { message: prompt }).catch((error) => {
        if (!this.pendingTurn) return;
        const turn = this.pendingTurn;
        this.pendingTurn = null;
        turn.reject(error);
      });
    });
  }

  cancel() {
    if (!this.pendingTurn) return false;
    void this.request('abort', null).catch(() => this.stop('SIGINT'));
    return true;
  }

  status() {
    return {
      ...super.status(),
      model: this.model
        ? {provider: this.model.provider, id: this.model.id, name: this.model.name}
        : null,
    };
  }
}

class CodexAppServerWorker extends JsonLineWorker {
  constructor(options) {
    super({
      ...options,
      agent: 'codex',
      args: ['app-server', '--stdio'],
      protocol: 'codex-app-server/ephemeral-thread',
    });
    this.threadId = null;
    this.lastUsage = null;
  }

  requestMessage(id, method, params) {
    return { method, id, params };
  }

  async start() {
    this.spawn();
    await this.request('initialize', {
      clientInfo: {
        name: 'browserctl_session_console',
        title: 'Browserctl Session Console',
        version: '1.3.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.send({ method: 'initialized', params: {} });
    const result = await this.request('thread/start', {
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
    }, 30_000);
    if (!result?.thread?.id || result.thread.ephemeral !== true) {
      throw new Error('Codex app-server did not create an ephemeral thread.');
    }
    this.threadId = result.thread.id;
    return this.status();
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (this.pendingTurn?.verbose) this.pendingTurn.onOutput(`[codex] ${truncate(line, 320)}\n`);
      return;
    }
    if (
      message.id !== undefined &&
      this.handleResponse(message.id, message.result, message.error)
    ) {
      return;
    }
    const turn = this.pendingTurn;
    if (!turn) return;
    emitStructuredEvent(turn, 'codex', message);
    if (
      message.method === 'item/completed' &&
      message.params?.item?.type === 'agentMessage' &&
      message.params.item.text
    ) {
      turn.output = message.params.item.text;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      this.lastUsage = message.params?.tokenUsage?.last || null;
      turn.usage = this.lastUsage;
    }
    if (message.method === 'turn/completed') {
      if (turn.turnId && message.params?.turn?.id !== turn.turnId) return;
      this.pendingTurn = null;
      const turnError = message.params?.turn?.error;
      if (turnError) {
        turn.reject(new Error(turnError.message || JSON.stringify(turnError)));
        return;
      }
      if (!turn.verbose && turn.output) turn.onOutput(`${turn.output}\n`);
      turn.resolve({
        output: turn.output ? `${turn.output}\n` : '',
        usage: turn.usage,
      });
    }
  }

  run(prompt, onOutput, verbose) {
    if (this.pendingTurn) throw new Error('Codex already has an active turn.');
    return new Promise((resolve, reject) => {
      const turn = {
        output: '',
        usage: null,
        turnId: null,
        onOutput,
        verbose,
        resolve,
        reject,
      };
      this.pendingTurn = turn;
      void this.request(
        'turn/start',
        {
          threadId: this.threadId,
          input: [{ type: 'text', text: prompt, text_elements: [] }],
        },
        30_000,
      )
        .then((result) => {
          turn.turnId = result?.turn?.id || null;
        })
        .catch((error) => {
          if (this.pendingTurn !== turn) return;
          this.pendingTurn = null;
          reject(error);
        });
    });
  }

  cancel() {
    const turn = this.pendingTurn;
    if (!turn) return false;
    if (turn.turnId) {
      void this.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: turn.turnId,
      }).catch(() => this.stop('SIGINT'));
    } else {
      this.stop('SIGINT');
    }
    return true;
  }

  status() {
    return {
      ...super.status(),
      threadEphemeral: true,
      threadIdInMemory: this.threadId,
      usage: this.lastUsage,
    };
  }
}

class ClaudeStreamWorker extends JsonLineWorker {
  constructor(options) {
    super({
      ...options,
      agent: 'claude',
      args: [
        '-p',
        '--no-session-persistence',
        '--no-chrome',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      protocol: 'claude-stream-json/no-session-persistence',
    });
    this.initialized = false;
    this.lastUsage = null;
  }

  requestMessage() {
    throw new Error('Claude streaming input does not use request/response IDs.');
  }

  async start() {
    this.spawn();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeStartWaiter = null;
        reject(new Error('Claude streaming worker did not initialize.'));
      }, 15_000);
      timeout.unref();
      this.removeStartWaiter = (error = null) => {
        clearTimeout(timeout);
        this.removeStartWaiter = null;
        if (error) reject(error);
        else resolve();
      };
    });
    return this.status();
  }

  handleExit(error) {
    this.removeStartWaiter?.(error);
    super.handleExit(error);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      if (this.pendingTurn?.verbose) this.pendingTurn.onOutput(`[claude] ${truncate(line, 320)}\n`);
      return;
    }
    if (!this.initialized && message.type === 'system' && message.subtype === 'init') {
      this.initialized = true;
      this.removeStartWaiter?.();
    }
    const turn = this.pendingTurn;
    if (!turn) return;
    emitStructuredEvent(turn, 'claude', message);
    if (message.type === 'assistant' && message.message?.role === 'assistant') {
      const text = textFromContent(message.message.content);
      if (text) turn.output = text;
    }
    if (message.type === 'result') {
      if (typeof message.result === 'string') turn.output = message.result;
      turn.usage = message.usage || {
        totalCostUsd: message.total_cost_usd ?? null,
        durationMs: message.duration_ms ?? null,
      };
      this.lastUsage = turn.usage;
      this.pendingTurn = null;
      if (message.is_error) {
        turn.reject(new Error(turn.output || 'Claude returned an error result.'));
        return;
      }
      if (!turn.verbose && turn.output) turn.onOutput(`${turn.output}\n`);
      turn.resolve({
        output: turn.output ? `${turn.output}\n` : '',
        usage: turn.usage,
      });
    }
  }

  run(prompt, onOutput, verbose) {
    if (this.pendingTurn) throw new Error('Claude already has an active turn.');
    return new Promise((resolve, reject) => {
      this.pendingTurn = {
        output: '',
        usage: null,
        onOutput,
        verbose,
        resolve,
        reject,
      };
      this.send({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
        parent_tool_use_id: null,
        session_id: '',
      });
    });
  }

  cancel() {
    if (!this.pendingTurn) return false;
    this.stop('SIGINT');
    return true;
  }

  status() {
    return {
      ...super.status(),
      transcriptPersistence: false,
      usage: this.lastUsage,
    };
  }
}

function createWorker(agent, options) {
  if (agent === 'pi') return new PiRpcWorker(options);
  if (agent === 'codex') return new CodexAppServerWorker(options);
  if (agent === 'claude') return new ClaudeStreamWorker(options);
  throw new Error(`Unknown agent worker: ${agent}`);
}

module.exports = {
  ClaudeStreamWorker,
  CodexAppServerWorker,
  JsonLineWorker,
  PiRpcWorker,
  createWorker,
  piIsolationArgs,
  textFromContent,
};
