'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { AGENTS } = require('./agent-runner');

async function readInlineSequence(source) {
  if (!source) throw new Error('--inline requires JSON, @file, or - for stdin.');
  let raw;
  if (source === '-') {
    raw = await fsp.readFile(0, 'utf8');
  } else if (source.startsWith('@')) {
    const filename = path.resolve(source.slice(1));
    raw = await fsp.readFile(filename, 'utf8');
  } else {
    raw = source;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid inline JSON: ${error.message}`);
  }
  const document = Array.isArray(parsed) ? { steps: parsed } : parsed;
  if (!document || typeof document !== 'object' || !Array.isArray(document.steps)) {
    throw new Error('Inline JSON must be an array of steps or an object with a steps array.');
  }
  if (document.agent && !AGENTS[document.agent]) {
    throw new Error(`Unknown inline agent "${document.agent}".`);
  }
  if (document.mode && !['managed', 'ephemeral'].includes(document.mode)) {
    throw new Error('Inline mode must be managed or ephemeral.');
  }
  if (
    document.conversation !== undefined &&
    document.conversation !== null &&
    (typeof document.conversation !== 'string' || !document.conversation.trim())
  ) {
    throw new Error('Inline conversation must be a nonempty string.');
  }
  for (const [index, step] of document.steps.entries()) {
    if (typeof step === 'string') continue;
    if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
    if (step.mode && !['managed', 'ephemeral'].includes(step.mode)) {
      throw new Error(`Inline step ${index} mode must be managed or ephemeral.`);
    }
    if (step.agent && !AGENTS[step.agent]) {
      throw new Error(`Unknown inline agent "${step.agent}" at step ${index}.`);
    }
  }
  return {
    agent: document.agent || null,
    mode: document.mode || null,
    conversation: document.conversation?.trim() || null,
    verbose: document.verbose === undefined ? null : Boolean(document.verbose),
    continueOnError: Boolean(document.continueOnError),
    steps: document.steps,
  };
}

function normalizeCommand(value) {
  return String(value || '').trim().replace(/^\/+/, '').toLowerCase();
}

function booleanValue(value) {
  if (typeof value === 'string') {
    if (['on', 'true', '1'].includes(value.toLowerCase())) return true;
    if (['off', 'false', '0'].includes(value.toLowerCase())) return false;
  }
  return Boolean(value);
}

class InlineRunner {
  constructor(options) {
    this.session = options.session;
    this.browser = options.browser;
    this.agentRunner = options.agentRunner;
    this.stdout = options.stdout || process.stdout;
    this.stderr = options.stderr || process.stderr;
  }

  requireBrowser() {
    if (!this.browser) throw new Error('This inline command requires the managed browser.');
  }

  writeResult(payload) {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  async executeStep(step) {
    if (typeof step === 'string') step = { query: step };
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error('Each inline step must be a query string or an object.');
    }

    if (typeof step.query === 'string') {
      if (!step.query.trim()) throw new Error('Inline query cannot be empty.');
      const agent = step.agent || this.agentRunner.selected;
      if (!AGENTS[agent]) throw new Error(`Unknown agent "${agent}".`);
      await this.agentRunner.select(agent, { persist: false });
      const verbose = step.verbose === undefined
        ? this.agentRunner.verbose
        : booleanValue(step.verbose);
      const output = await this.agentRunner.run(
        step.query,
        (chunk) => {
          if (verbose) this.stderr.write(chunk);
        },
        {
          verbose,
          memoryMode: step.mode || this.agentRunner.memoryMode,
        },
      );
      return { kind: 'query', agent, result: output.trimEnd() };
    }

    const command = normalizeCommand(step.command);
    if (!command) throw new Error('Inline object needs either "query" or "command".');

    if (command === 'status') {
      return {
        kind: 'command',
        command,
        result: this.browser
          ? await this.browser.agentContext()
          : {
              connected: false,
              sessionId: this.session.id,
              sessionPath: this.session.directory,
            },
      };
    }
    if (command === 'agent') {
      const agent = String(step.agent || step.value || '').toLowerCase();
      if (!AGENTS[agent]) throw new Error('agent command requires pi, codex, or claude.');
      await this.agentRunner.select(agent, { persist: false });
      return { kind: 'command', command, result: { agent } };
    }
    if (command === 'model') {
      if (step.model) {
        const selected = await this.agentRunner.setPiModel(step.model);
        return { kind: 'command', command, result: { model: selected } };
      }
      return { kind: 'command', command, result: await this.agentRunner.describeModels() };
    }
    if (command === 'verbose') {
      const enabled = booleanValue(step.enabled === undefined ? step.value : step.enabled);
      this.agentRunner.setVerbose(enabled);
      return { kind: 'command', command, result: { verbose: enabled } };
    }
    if (command === 'memory') {
      const mode = String(step.mode || step.value || '').toLowerCase();
      await this.agentRunner.setMemoryMode(mode);
      return { kind: 'command', command, result: { mode } };
    }
    if (command === 'conversation') {
      const action = String(step.action || 'status').toLowerCase();
      if (action === 'status') {
        return {
          kind: 'command',
          command,
          result: await this.agentRunner.conversationStatus(),
        };
      }
      if (action === 'list') {
        return {
          kind: 'command',
          command,
          result: this.agentRunner.listConversations(),
        };
      }
      if (action === 'new') {
        return {
          kind: 'command',
          command,
          result: await this.agentRunner.newConversation(step.name || null),
        };
      }
      if (action === 'resume') {
        return {
          kind: 'command',
          command,
          result: await this.agentRunner.resumeConversation(step.id || 'latest'),
        };
      }
      throw new Error('conversation action must be status, list, new, or resume.');
    }
    if (command === 'compact') {
      return {
        kind: 'command',
        command,
        result: await this.agentRunner.compact(
          step.instructions || '',
          (chunk) => {
            if (this.agentRunner.verbose) this.stderr.write(chunk);
          },
        ),
      };
    }
    if (command === 'wait') {
      const milliseconds = Number(step.ms ?? step.milliseconds ?? 0);
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 60_000) {
        throw new Error('wait requires ms between 0 and 60000.');
      }
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      return { kind: 'command', command, result: { waitedMs: milliseconds } };
    }

    this.requireBrowser();
    if (command === 'launch') {
      return { kind: 'command', command, result: await this.browser.launch() };
    }
    if (command === 'reload') {
      return { kind: 'command', command, result: await this.browser.reload() };
    }
    if (command === 'open') {
      const url = new URL(step.url);
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('open only supports http:// and https:// URLs.');
      }
      return { kind: 'command', command, result: await this.browser.open(url.toString()) };
    }
    if (command === 'screenshot') {
      return {
        kind: 'command',
        command,
        result: { path: await this.browser.screenshot(step.name || 'inline') },
      };
    }
    if (command === 'save') {
      return {
        kind: 'command',
        command,
        result: { path: await this.browser.saveState(step.name || 'inline') },
      };
    }
    if (command === 'eval' || command === 'browser.eval') {
      if (typeof step.code !== 'string' || !step.code.trim()) {
        throw new Error('eval requires a nonempty "code" string.');
      }
      return {
        kind: 'command',
        command: 'eval',
        result: await this.browser.bridge.evaluate(step.code),
      };
    }
    if (command === 'run' || command === 'browser.run') {
      if (!step.file) throw new Error('run requires a "file" path.');
      const filename = path.resolve(step.file);
      const code = await fsp.readFile(filename, 'utf8');
      return {
        kind: 'command',
        command: 'run',
        result: await this.browser.bridge.evaluate(code),
      };
    }
    throw new Error(`Unknown inline command: ${command}`);
  }

  async run(document) {
    if (document.agent) {
      await this.agentRunner.select(document.agent, { persist: false });
    }
    if (document.verbose !== null) this.agentRunner.setVerbose(document.verbose);
    if (document.mode) await this.agentRunner.setMemoryMode(document.mode);
    let failed = false;
    for (let index = 0; index < document.steps.length; index += 1) {
      try {
        const result = await this.executeStep(document.steps[index]);
        this.writeResult({ index, ok: true, ...result });
      } catch (error) {
        failed = true;
        this.writeResult({ index, ok: false, error: error.message });
        if (!document.continueOnError) break;
      }
    }
    return { ok: !failed };
  }
}

module.exports = {
  InlineRunner,
  booleanValue,
  normalizeCommand,
  readInlineSequence,
};
