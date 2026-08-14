'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const {
  ageLabel,
  commandExists,
  sanitizeFilename,
  timestamp,
  uniquePath,
} = require('./utils');

const color = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  magenta: '\u001b[35m',
  inverse: '\u001b[7m',
};

function paint(style, text) {
  return `${style}${text}${color.reset}`;
}

function clearScreen() {
  process.stdout.write('\u001b[2J\u001b[H');
}

function terminalWidth() {
  return Math.max(50, Math.min(process.stdout.columns || 90, 120));
}

function truncate(value, width) {
  const text = String(value ?? '');
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

const SLASH_COMMANDS = [
  '/agent', '/model', '/models', '/memory', '/conversation', '/compact',
  '/verbose', '/fill', '/edit', '/status', '/plan', '/launch', '/screenshot',
  '/save', '/reload', '/open', '/help', '/quit', '/exit',
];

// Shared by Tab completion and the live typing hints: complete only a bare
// leading slash command, never free-form prompt text or command arguments.
function completeSlashCommand(line) {
  if (!/^\/[a-z]*$/i.test(line)) return [];
  const matches = SLASH_COMMANDS.filter((command) => command.startsWith(line.toLowerCase()));
  return matches.length === 1 && matches[0] === line.toLowerCase() ? [] : matches;
}

async function selectMenu(title, items, options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive menus require a TTY. Use --new, --open, or --list in scripts.');
  }
  if (!items.length) return null;

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\u001b[?1049h\u001b[?25l');

  let selected = Math.max(0, Math.min(options.initialIndex || 0, items.length - 1));
  while (items[selected]?.disabled && selected < items.length - 1) selected += 1;

  const move = (direction) => {
    let next = selected;
    for (let attempts = 0; attempts < items.length; attempts += 1) {
      next = (next + direction + items.length) % items.length;
      if (!items[next].disabled) {
        selected = next;
        break;
      }
    }
  };

  const draw = () => {
    const width = terminalWidth();
    const maxVisible = Math.max(3, Math.floor(((process.stdout.rows || 24) - 8) / 2));
    let start = Math.max(0, selected - Math.floor(maxVisible / 2));
    start = Math.min(start, Math.max(0, items.length - maxVisible));
    const visible = items.slice(start, start + maxVisible);
    process.stdout.write('\u001b[H\u001b[2J');
    process.stdout.write(`${paint(color.bold + color.cyan, 'BROWSERCTL • SESSION CONSOLE')}\n`);
    process.stdout.write(`${paint(color.bold, title)}\n`);
    process.stdout.write(`${paint(color.dim, options.hint || '↑/↓ move  •  Enter select  •  Esc go back')}\n\n`);
    for (let offset = 0; offset < visible.length; offset += 1) {
      const index = start + offset;
      const item = visible[offset];
      const active = index === selected;
      const marker = active ? paint(color.cyan, '❯') : ' ';
      const label = item.disabled
        ? paint(color.dim, item.label)
        : active
          ? paint(color.bold + color.inverse, ` ${item.label} `)
          : item.label;
      process.stdout.write(`${marker} ${truncate(label, width - 4)}\n`);
      if (item.detail) {
        process.stdout.write(`    ${paint(color.dim, truncate(item.detail, width - 5))}\n`);
      } else {
        process.stdout.write('\n');
      }
    }
    if (items.length > maxVisible) {
      process.stdout.write(
        `\n${paint(color.dim, `${selected + 1}/${items.length} • Home/End and PageUp/PageDown supported`)}\n`,
      );
    }
  };

  draw();
  return new Promise((resolve) => {
    const finish = (value) => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdout.write('\u001b[?25h\u001b[?1049l');
      resolve(value);
    };
    const onKeypress = (_character, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(null);
      if (key.name === 'escape' || key.name === 'q') return finish(null);
      if (key.name === 'up' || key.name === 'k') move(-1);
      else if (key.name === 'down' || key.name === 'j') move(1);
      else if (key.name === 'home') selected = 0;
      else if (key.name === 'end') selected = items.length - 1;
      else if (key.name === 'pageup') selected = Math.max(0, selected - 8);
      else if (key.name === 'pagedown') selected = Math.min(items.length - 1, selected + 8);
      else if (key.name === 'return' && !items[selected].disabled) {
        return finish(items[selected].value);
      } else {
        return;
      }
      while (items[selected]?.disabled && selected > 0) selected -= 1;
      draw();
    };
    process.stdin.on('keypress', onKeypress);
  });
}

async function chooseSession(store, options = {}) {
  while (true) {
    const action = await selectMenu(
      'How would you like to begin?',
      [
        {
          value: 'new',
          label: 'Create a new session',
          detail: 'Creates a collision-safe folder using today’s date.',
        },
        {
          value: 'open',
          label: 'Open a previous session',
          detail: 'Restores its Chrome profile, saved state, and browser artifacts.',
        },
        { value: 'exit', label: 'Exit', detail: 'Leave without launching Chrome.' },
      ],
      { hint: '↑/↓ move  •  Enter select  •  Esc exit' },
    );
    if (!action || action === 'exit') return null;
    if (action === 'new') return store.create(options);

    const sessions = await store.list();
    if (!sessions.length) {
      process.stdout.write(
        `${paint(color.yellow, 'No session folders exist yet. Create a new session first.')}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    const selected = await selectMenu(
      'Open a previous session — newest first',
      sessions.map((session) => ({
        value: session,
        label: `${session.id}  ${paint(color.dim, `• ${ageLabel(session.sortDate)}`)}`,
        detail: `${session.directory}${session.legacy ? '  • legacy folder; will be migrated' : ''}`,
      })),
    );
    if (selected) return store.open(selected.directory);
  }
}

async function listTemplateFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'readme.md') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

function runEditor(filename) {
  const fallback = commandExists('nano') ? 'nano' : 'vi';
  const shellCommand = 'exec ${VISUAL:-${EDITOR:-$BROWSERCTL_EDITOR_FALLBACK}} "$1"';
  return spawnSync('/bin/sh', ['-c', shellCommand, 'browserctl-editor', filename], {
    stdio: 'inherit',
    env: { ...process.env, BROWSERCTL_EDITOR_FALLBACK: fallback },
  });
}

class TerminalChat {
  constructor(options) {
    this.session = options.session;
    this.store = options.store;
    this.browser = options.browser;
    this.agentRunner = options.agentRunner;
    this.templatesDirectory = options.templatesDirectory;
    this.workflowStore = options.workflowStore || null;
    this.actionBar = options.actionBar || null;
    this.stopped = false;
    this.currentReadline = null;
  }

  requestStop() {
    this.stopped = true;
    this.currentReadline?.close();
    this.agentRunner.cancel();
  }

  renderHeader() {
    clearScreen();
    const browserLabel = this.browser
      ? `${paint(color.green, '● connected')}  CDP ${this.browser.port}  headed=${!this.browser.headless}`
      : paint(color.yellow, '○ browser disabled');
    process.stdout.write(`${paint(color.bold + color.cyan, '╭─ BROWSERCTL • LIVE AGENT CONSOLE')}\n`);
    process.stdout.write(`${paint(color.cyan, '│')} Session  ${paint(color.bold, this.session.id)}\n`);
    process.stdout.write(`${paint(color.cyan, '│')} Path     ${this.session.directory}\n`);
    process.stdout.write(`${paint(color.cyan, '│')} Browser  ${browserLabel}\n`);
    const conversation = this.agentRunner.conversationStore?.activeId || 'none';
    process.stdout.write(
      `${paint(color.cyan, '│')} Memory   ${this.agentRunner.memoryMode}  conversation=${truncate(conversation, 42)}\n`,
    );
    process.stdout.write(
      `${paint(color.cyan, '╰─')} Agent    ${paint(color.magenta, this.agentRunner.selected)}  verbose=${this.agentRunner.verbose ? 'on' : 'off'}  ${paint(color.dim, '(/help for commands)')}\n\n`,
    );
    this.renderWorkflowSummary();
  }

  renderWorkflowSummary() {
    const workflow = this.workflowStore?.active();
    if (!workflow) return;
    const resolved = workflow.steps.filter((step) =>
      ['completed', 'skipped'].includes(step.status),
    ).length;
    process.stdout.write(
      `${paint(color.bold + color.cyan, `Plan • ${workflow.title}`)}  ` +
      `${paint(color.dim, `${resolved}/${workflow.steps.length} resolved • ${workflow.status}`)}\n`,
    );
    for (const step of workflow.steps) {
      const symbol = {
        pending: '○', in_progress: '◉', waiting: '◇', completed: '✓', skipped: '—', failed: '!',
      }[step.status] || '○';
      process.stdout.write(
        `  ${symbol} ${step.title}${step.note ? ` ${paint(color.dim, `— ${truncate(step.note, 70)}`)}` : ''}\n`,
      );
    }
    process.stdout.write(`${paint(color.dim, 'Use /plan, or click Retry / Prompt agent in the browser plan panel.')}\n\n`);
  }

  async askLine() {
    const pending = await this.workflowStore?.consumeAction();
    if (pending) return this.workflowStore.promptForAction(pending);
    const quickPrompt = this.actionBar?.consumePrompt();
    if (quickPrompt) return quickPrompt;
    return new Promise((resolve) => {
      // Registered before the readline interface so it observes keys first;
      // rendering is deferred a tick so readline has applied the key to its
      // line buffer by the time suggestions are drawn.
      const promptWidth = this.agentRunner.selected.length + 3;
      const drawSuggestions = () => {
        const active = this.currentReadline;
        if (!active || !process.stdout.isTTY) return;
        if (active.cursor !== active.line.length) return;
        if (!/^\/[a-z]*$/i.test(active.line)) return;
        process.stdout.write('\u001b[K');
        const matches = completeSlashCommand(active.line);
        if (!matches.length) return;
        const room = terminalWidth() - promptWidth - active.line.length - 4;
        let hint = '';
        for (const match of matches) {
          const extended = hint ? `${hint}  ${match}` : match;
          if (extended.length > room) break;
          hint = extended;
        }
        if (!hint) return;
        process.stdout.write(`  ${paint(color.dim, hint)}\u001b[${hint.length + 2}D`);
      };
      const onSuggestKeypress = (_character, key = {}) => {
        if (key.name === 'return' || key.name === 'enter') {
          const active = this.currentReadline;
          if (process.stdout.isTTY && active &&
              active.cursor === active.line.length && active.line.startsWith('/')) {
            process.stdout.write('\u001b[K');
          }
          return;
        }
        setImmediate(drawSuggestions);
      };
      process.stdin.on('keypress', onSuggestKeypress);
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        historySize: 200,
        removeHistoryDuplicates: true,
        completer: (line) => {
          const matches = completeSlashCommand(line);
          return [matches, line];
        },
      });
      this.currentReadline = rl;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.currentReadline = null;
        process.stdin.removeListener('keypress', onSuggestKeypress);
        this.workflowStore?.removeListener('action-queued', onWorkflowAction);
        this.actionBar?.removeListener('prompt-queued', onQuickAction);
        rl.close();
        resolve(value);
      };
      let actionWakeStarted = false;
      const onWorkflowAction = () => {
        if (actionWakeStarted) return;
        actionWakeStarted = true;
        void this.workflowStore.consumeAction().then((action) =>
          finish(this.workflowStore.promptForAction(action)),
        );
      };
      const onQuickAction = () => {
        if (actionWakeStarted) return;
        actionWakeStarted = true;
        finish(this.actionBar.consumePrompt());
      };
      this.workflowStore?.once('action-queued', onWorkflowAction);
      this.actionBar?.once('prompt-queued', onQuickAction);
      if (this.workflowStore?.snapshot().pendingHumanActions) {
        queueMicrotask(onWorkflowAction);
      } else if (this.actionBar?.pendingCount) {
        queueMicrotask(onQuickAction);
      }
      rl.once('SIGINT', () => finish(null));
      rl.question(
        `${paint(color.bold + color.magenta, this.agentRunner.selected)} ${paint(color.cyan, '›')} `,
        finish,
      );
    });
  }

  async start() {
    this.renderHeader();
    while (!this.stopped) {
      const input = await this.askLine();
      if (input === null) break;
      const trimmed = input.trim();
      if (!trimmed) continue;

      let prompt = null;
      if (trimmed.startsWith('/')) {
        const result = await this.handleCommand(trimmed).catch((error) => {
          this.error(error.message);
          return null;
        });
        if (result?.quit) break;
        prompt = result?.prompt || null;
      } else {
        prompt = input;
      }
      if (!prompt) continue;

      let activityShown = false;
      const showActivity = (activity) => {
        if (activityShown) return;
        activityShown = true;
        const label = activity.type === 'extension'
          ? `${activity.label || activity.extensionId || 'Application extension'} is working`
          : `${activity.label || this.agentRunner.selected} is working`;
        process.stdout.write(
          `\n${paint(color.bold + color.green, label)} ${paint(color.dim, '• Ctrl+C cancels the active work')}\n\n`,
        );
      };
      try {
        await this.agentRunner.run(
          prompt,
          (chunk) => process.stdout.write(chunk),
          { onActivity: showActivity },
        );
      } catch (error) {
        if (!activityShown) process.stdout.write('\n');
        this.error(error.message);
      }
      process.stdout.write('\n');
    }
  }

  async handleCommand(input) {
    const firstSpace = input.indexOf(' ');
    const command = (firstSpace === -1 ? input : input.slice(0, firstSpace)).toLowerCase();
    const argument = firstSpace === -1 ? '' : input.slice(firstSpace + 1).trim();

    if (command === '/quit' || command === '/exit') return { quit: true };
    if (command === '/help') {
      this.printHelp();
      return null;
    }
    if (command === '/agent') {
      await this.chooseAgent();
      return null;
    }
    if (command === '/model') {
      if (!argument || argument.toLowerCase() === 'status') {
        const info = await this.agentRunner.describeModels();
        const current = info.current || info.preferred;
        this.success(current
          ? `Pi model: ${current.id}${current.provider ? ` (${current.provider})` : ''}`
          : 'Pi model: the Pi default (no session preference saved).');
        if (info.available.length) {
          process.stdout.write(`${paint(color.bold, 'Available')}\n`);
          for (const model of info.available) {
            process.stdout.write(`  ${model.provider}/${model.id}${model.name && model.name !== model.id ? `  ${paint(color.dim, model.name)}` : ''}\n`);
          }
        } else if (!info.current) {
          process.stdout.write(`${paint(color.dim, 'The model list is reported by the live Pi worker; run one query first to list models.')}\n`);
        }
        return null;
      }
      const selected = await this.agentRunner.setPiModel(argument);
      this.success(
        `Pi model set to ${selected.id}${selected.provider ? ` (${selected.provider})` : ''} and saved for this session.`,
      );
      return null;
    }
    if (command === '/models') {
      const info = await this.agentRunner.describeModels({
        spawn: true,
        onOutput: (chunk) => process.stdout.write(chunk),
      });
      if (!info.supported) {
        this.error(`The ${info.agent} agent's protocol does not expose a model list; /models works with Pi.`);
        return null;
      }
      if (!info.available.length) {
        this.error('Pi reported no selectable models.');
        return null;
      }
      const currentKey = info.current ? `${info.current.provider}/${info.current.id}` : null;
      const selected = await selectMenu(
        'Choose a Pi model',
        info.available.map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: `${model.id}${`${model.provider}/${model.id}` === currentKey ? '  • current' : ''}`,
          detail: model.name && model.name !== model.id ? `${model.provider} • ${model.name}` : model.provider,
        })),
        { initialIndex: Math.max(0, info.available.findIndex((model) => `${model.provider}/${model.id}` === currentKey)) },
      );
      if (!selected) return null;
      const applied = await this.agentRunner.setPiModel(selected);
      this.success(`Pi model set to ${applied.id} and saved for this session.`);
      return null;
    }
    if (command === '/memory') {
      const mode = argument.toLowerCase();
      if (!mode || mode === 'status') {
        this.success(`Memory mode is ${this.agentRunner.memoryMode}.`);
        return null;
      }
      await this.agentRunner.setMemoryMode(mode);
      this.success(
        mode === 'managed'
          ? 'Managed memory enabled; the active service conversation will resume.'
          : 'Ephemeral memory enabled; every query will use a fresh process and will not be recorded.',
      );
      return null;
    }
    if (command === '/conversation') {
      await this.handleConversation(argument);
      return null;
    }
    if (command === '/compact') {
      const checkpoint = await this.agentRunner.compact(
        argument,
        (chunk) => process.stdout.write(chunk),
      );
      this.success(`Compact checkpoint saved: ${checkpoint.id}`);
      return null;
    }
    if (command === '/verbose') {
      const normalized = argument.toLowerCase();
      if (!normalized || normalized === 'status') {
        this.success(`Verbose agent output is ${this.agentRunner.verbose ? 'on' : 'off'}.`);
        return null;
      }
      if (!['on', 'off'].includes(normalized)) {
        throw new Error('Usage: /verbose on|off|status');
      }
      this.agentRunner.setVerbose(normalized === 'on');
      this.success(
        `Verbose agent output is ${this.agentRunner.verbose ? 'on' : 'off'} for this service process.`,
      );
      return null;
    }
    if (command === '/fill') {
      return { prompt: await this.fillFromTemplate() };
    }
    if (command === '/edit') {
      return { prompt: await this.editPrompt('', 'new-prompt') };
    }
    if (command === '/status') {
      await this.printStatus();
      return null;
    }
    if (command === '/plan') {
      return {prompt: await this.handlePlan()};
    }
    if (command === '/launch') {
      this.requireBrowser();
      const state = await this.browser.launch();
      this.success(
        `Managed browser ready: ${state.activePageUrl || state.cdpUrl || '(navigation pending)'}`,
      );
      return null;
    }
    if (command === '/screenshot') {
      this.requireBrowser();
      const destination = await this.browser.screenshot(argument || 'manual');
      this.success(`Screenshot saved: ${destination}`);
      return null;
    }
    if (command === '/save') {
      this.requireBrowser();
      const destination = await this.browser.saveState(argument || 'manual');
      this.success(`Browser state saved: ${destination}`);
      return null;
    }
    if (command === '/reload') {
      this.requireBrowser();
      const state = await this.browser.reload();
      this.success(`Reloaded: ${state.activePageUrl}`);
      return null;
    }
    if (command === '/open') {
      this.requireBrowser();
      if (!argument) throw new Error('Usage: /open <http-or-https-url>');
      let url;
      try {
        url = new URL(argument);
      } catch {
        throw new Error(`Invalid URL: ${argument}`);
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Only http:// and https:// URLs are supported.');
      }
      const state = await this.browser.open(url.toString());
      this.success(`Opened: ${state.activePageUrl}`);
      return null;
    }
    throw new Error(`Unknown command: ${command}. Use /help to see available commands.`);
  }

  requireBrowser() {
    if (!this.browser) throw new Error('The browser is disabled for this run.');
  }

  async chooseAgent() {
    const availability = this.agentRunner.availability();
    const selected = await selectMenu(
      'Choose a coding agent',
      Object.entries(availability).map(([id, details]) => ({
        value: id,
        label: `${details.label}${id === this.agentRunner.selected ? '  • current' : ''}`,
        detail: details.available
          ? `${details.command} is available`
          : `${details.command} is not installed; selection is allowed but prompts will fail clearly`,
      })),
      { initialIndex: Object.keys(availability).indexOf(this.agentRunner.selected) },
    );
    if (!selected) return;
    await this.agentRunner.select(selected);
    this.success(
      `Active agent: ${availability[selected].label}; the previous worker was killed and managed context is preserved.`,
    );
  }

  async handleConversation(argument) {
    const firstSpace = argument.indexOf(' ');
    const action = (
      firstSpace === -1 ? argument : argument.slice(0, firstSpace)
    ).toLowerCase() || 'status';
    const value = firstSpace === -1 ? '' : argument.slice(firstSpace + 1).trim();
    if (action === 'status') {
      process.stdout.write(
        `${JSON.stringify(await this.agentRunner.conversationStatus(), null, 2)}\n`,
      );
      return;
    }
    if (action === 'list') {
      const conversations = this.agentRunner.listConversations();
      process.stdout.write(
        `${JSON.stringify(
          conversations.map((item) => ({
            ...item,
            active: item.id === this.agentRunner.conversationStore?.activeId,
          })),
          null,
          2,
        )}\n`,
      );
      return;
    }
    if (action === 'new') {
      const created = await this.agentRunner.newConversation(value || null);
      this.success(`New managed conversation: ${created.id}`);
      return;
    }
    if (action === 'resume') {
      let selected = value;
      if (!selected) {
        const conversations = this.agentRunner.listConversations();
        selected = await selectMenu(
          'Resume a service-managed conversation',
          conversations.map((item) => ({
            value: item.id,
            label: `${item.name || item.id}${item.id === this.agentRunner.conversationStore?.activeId ? ' • active' : ''}`,
            detail: `${item.turnCount} turns • updated ${ageLabel(item.updatedAt)} • ${item.id}`,
          })),
        );
        if (!selected) return;
      }
      const resumed = await this.agentRunner.resumeConversation(selected);
      this.success(`Resumed managed conversation: ${resumed.id}`);
      return;
    }
    throw new Error(
      'Usage: /conversation status|list|new [name]|resume [id|latest]',
    );
  }

  async fillFromTemplate() {
    const files = await listTemplateFiles(this.templatesDirectory);
    if (!files.length) {
      throw new Error(`No prompt templates found in ${this.templatesDirectory}`);
    }
    const selected = await selectMenu(
      'Select a prompt template',
      files.map((filename) => ({
        value: filename,
        label: path.basename(filename),
        detail: path.relative(this.templatesDirectory, filename),
      })),
    );
    if (!selected) return null;
    const content = await fsp.readFile(selected, 'utf8');
    return this.editPrompt(content, path.basename(selected, path.extname(selected)));
  }

  async handlePlan() {
    const workflow = this.workflowStore?.active();
    if (!workflow) {
      this.success('No workflow is active. Describe the outcome you want in natural language.');
      return null;
    }
    const selected = await selectMenu(
      `Plan • ${workflow.title}`,
      workflow.steps.map((step) => ({
        value: step.id,
        label: `${{pending:'○',in_progress:'◉',waiting:'◇',completed:'✓',skipped:'—',failed:'!'}[step.status] || '○'} ${step.title}`,
        detail: step.note || `${step.status} • ${step.completion}`,
      })),
      {hint: 'Choose a step to retry or discuss • Esc returns'},
    );
    if (!selected) return null;
    const step = workflow.steps.find((candidate) => candidate.id === selected);
    const action = await selectMenu(
      step.title,
      [
        {value: 'retry', label: 'Retry this step', detail: 'The agent will inspect current state before acting.'},
        {value: 'prompt', label: 'Tell the agent what to change', detail: 'Edit a natural-language correction before sending.'},
      ],
    );
    if (!action) return null;
    if (action === 'retry') {
      return this.workflowStore.promptForAction({
        workflowId: workflow.id,
        stepId: step.id,
        action: 'retry',
      });
    }
    const initial = `For the active workflow “${workflow.title}”, revisit step “${step.title}”.\n\nWhat I want changed:\n`;
    const note = await this.editPrompt(initial, `workflow-${step.id}`);
    if (!note) return null;
    return `For the active workflow “${workflow.title}”, revisit step “${step.title}”. The human's correction is:\n\n${note}\n\nInspect the live browser and current plan, navigate as needed, make only the requested correction, verify it, and update the workflow tracker with evidence.`;
  }

  async editPrompt(initialContent, label) {
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sanitizeFilename(label)}.md`;
    const filename = await uniquePath(this.session.paths.drafts, base);
    await fsp.writeFile(filename, initialContent, 'utf8');
    while (true) {
      const result = runEditor(filename);
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Editor exited with status ${result.status}. Draft kept at ${filename}`);
      }
      const content = await fsp.readFile(filename, 'utf8');
      if (!content.trim()) {
        this.error(`The draft is empty. It remains at ${filename}`);
      }
      const choice = await selectMenu(
        `Prompt draft: ${path.basename(filename)}`,
        [
          {
            value: 'send',
            label: 'Send edited prompt',
            detail: `${content.trim().length} characters`,
            disabled: !content.trim(),
          },
          { value: 'edit', label: 'Edit again', detail: filename },
          { value: 'cancel', label: 'Cancel', detail: 'Keep the draft without sending.' },
        ],
      );
      if (choice === 'send') return content.trim();
      if (choice !== 'edit') return null;
    }
  }

  async printStatus() {
    const browserState = this.browser ? await this.browser.agentContext() : { connected: false };
    const availability = this.agentRunner.availability();
    const agentState = await this.agentRunner.status();
    process.stdout.write(
      `${paint(color.bold, 'Session status')}\n${JSON.stringify(
        {
          session: {
            id: this.session.id,
            path: this.session.directory,
            selectedAgent: this.agentRunner.selected,
            verbose: this.agentRunner.verbose,
            memoryMode: this.agentRunner.memoryMode,
            nativeAgentPersistence: false,
          },
          browser: browserState,
          agentRuntime: agentState,
          agents: Object.fromEntries(
            Object.entries(availability).map(([id, item]) => [
              id,
              { available: item.available, command: item.command },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );
  }

  printHelp() {
    process.stdout.write(`${paint(color.bold, 'Commands')}\n`);
    process.stdout.write(`  ${paint(color.cyan, '/agent')}              switch Pi, Codex, or Claude\n`);
    process.stdout.write(`  ${paint(color.cyan, '/model [id]')}         show or set the Pi model (saved per session)\n`);
    process.stdout.write(`  ${paint(color.cyan, '/models')}             pick the Pi model from a selection menu\n`);
    process.stdout.write(`  ${paint(color.cyan, '/memory <mode>')}      managed or ephemeral agent continuity\n`);
    process.stdout.write(`  ${paint(color.cyan, '/conversation ...')}  status, list, new, or resume service context\n`);
    process.stdout.write(`  ${paint(color.cyan, '/compact [notes]')}    save a durable compact replay checkpoint\n`);
    process.stdout.write(`  ${paint(color.cyan, '/verbose on|off')}     stream or hide prefills, events, and tools\n`);
    process.stdout.write(`  ${paint(color.cyan, '/fill')}               select, edit, and send a template\n`);
    process.stdout.write(`  ${paint(color.cyan, '/edit')}               compose a multiline prompt in $EDITOR\n`);
    process.stdout.write(`  ${paint(color.cyan, '/status')}             show fresh browser and agent state\n`);
    process.stdout.write(`  ${paint(color.cyan, '/plan')}               select a workflow step to retry or correct\n`);
    process.stdout.write(`  ${paint(color.cyan, '/launch')}             relaunch Chrome or recreate the managed tab\n`);
    process.stdout.write(`  ${paint(color.cyan, '/screenshot [name]')}  capture the active tab\n`);
    process.stdout.write(`  ${paint(color.cyan, '/save [name]')}        save browser storage state\n`);
    process.stdout.write(`  ${paint(color.cyan, '/open <url>')}         navigate the managed tab\n`);
    process.stdout.write(`  ${paint(color.cyan, '/reload')}             reload the managed tab\n`);
    process.stdout.write(`  ${paint(color.cyan, '/quit')}               save state, close Chrome, and exit\n`);
    process.stdout.write(
      `${paint(color.dim, 'Native agent persistence is always off. Managed memory stores successful prompts/finals only.')}\n`,
    );
  }

  success(message) {
    process.stdout.write(`${paint(color.green, '✓')} ${message}\n`);
  }

  error(message) {
    process.stdout.write(`${paint(color.red, 'Error:')} ${message}\n`);
  }
}

module.exports = {
  SLASH_COMMANDS,
  TerminalChat,
  completeSlashCommand,
  chooseSession,
  clearScreen,
  listTemplateFiles,
  paint,
  selectMenu,
};
