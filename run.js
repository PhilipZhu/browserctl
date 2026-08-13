#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { BrowserManager } = require('./lib/browser-manager');
const { AgentRunner, AGENTS } = require('./lib/agent-runner');
const { ConversationStore } = require('./lib/conversation-store');
const { InlineRunner, readInlineSequence } = require('./lib/inline-runner');
const { extensionEntries, loadExtensions } = require('./lib/extension-loader');
const { SessionStore } = require('./lib/session-store');
const { TerminalChat, chooseSession, paint } = require('./lib/terminal-ui');
const {WorkflowStore} = require('./lib/workflow-store');
const { ageLabel } = require('./lib/utils');

const VERSION = '2.0.0';
const DEFAULT_URL = 'about:blank';
const BROWSERCTL_DIRECTORY = __dirname;

function resolveRunDirectory(environment = process.env, cwd = process.cwd()) {
  const configured = environment.BROWSERCTL_RUN_DIR;
  const npmInvocation = environment.npm_lifecycle_event && environment.INIT_CWD;
  return path.resolve(configured || npmInvocation || cwd);
}

const RUN_DIRECTORY = resolveRunDirectory();
const DEFAULT_SESSIONS_DIRECTORY = path.join(RUN_DIRECTORY, 'weekly-logs');
const DEFAULT_TEMPLATES_DIRECTORY = path.join(RUN_DIRECTORY, 'templates');

async function ensureRunDirectoryLayout() {
  await fsp.mkdir(DEFAULT_TEMPLATES_DIRECTORY, { recursive: true });
  await fsp.writeFile(
    path.join(DEFAULT_TEMPLATES_DIRECTORY, 'README.md'),
    '# Prompt Templates\n\nAdd editable prompt files here. The session console discovers this folder relative to the directory from which it is run.\n',
    { encoding: 'utf8', flag: 'wx' },
  ).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

function usage() {
  return `Browser Control session console ${VERSION}

Usage:
  ./run.js
  ./run.js --new [--agent pi|codex|claude]
  ./run.js --open <session-id-or-path|latest>
  ./run.js --open <session> --inline <JSON|@file|->
  ./run.js --list

Options:
  --new                 Create a collision-safe session for today.
  --open <id-or-path>   Recover a previous session; use latest for the newest one.
  --list                List sessions newest first without launching Chrome.
  --agent <name>        Initial coding agent (default: saved selection or pi).
  --verbose             Stream prefills and all structured agent/tool events.
  --memory <mode>       Agent continuity mode: managed or ephemeral.
  --inline <source>     Run a JSON sequence; source is JSON, @file, or stdin (-).
  --url <url>           Override the application URL.
  --chrome <path>       Override the Chrome executable.
  --headless            Run Chrome headless (default is headed; intended for diagnostics).
  --no-browser          Skip Chrome (diagnostics/tests only).
  --help                Show this help.
  --version             Show the version.

Environment:
  BROWSERCTL_RUN_DIR
  CHROME_PATH
  BROWSERCTL_PI_BIN
  BROWSERCTL_CODEX_BIN
  BROWSERCTL_CLAUDE_BIN
  VISUAL or EDITOR
`;
}

function parseArguments(argv) {
  const options = {
    newSession: false,
    open: null,
    list: false,
    agent: null,
    targetUrl: DEFAULT_URL,
    targetUrlExplicit: false,
    chromePath: null,
    headless: false,
    noBrowser: false,
    verbose: false,
    inlineSource: null,
    memoryMode: null,
    help: false,
    version: false,
  };
  const requireValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--new') options.newSession = true;
    else if (argument === '--open') {
      options.open = requireValue(index, argument);
      index += 1;
    } else if (argument === '--list') options.list = true;
    else if (argument === '--agent') {
      options.agent = requireValue(index, argument).toLowerCase();
      index += 1;
    } else if (argument === '--url') {
      options.targetUrl = requireValue(index, argument);
      options.targetUrlExplicit = true;
      index += 1;
    } else if (argument === '--chrome') {
      options.chromePath = requireValue(index, argument);
      index += 1;
    } else if (argument === '--headless') options.headless = true;
    else if (argument === '--no-browser') options.noBrowser = true;
    else if (argument === '--verbose') options.verbose = true;
    else if (argument === '--memory') {
      options.memoryMode = requireValue(index, argument).toLowerCase();
      index += 1;
    }
    else if (argument === '--inline') {
      options.inlineSource = requireValue(index, argument);
      index += 1;
    }
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  const sessionModes = [options.newSession, Boolean(options.open), options.list].filter(Boolean);
  if (sessionModes.length > 1) {
    throw new Error('Use only one of --new, --open, or --list.');
  }
  if (options.agent && !AGENTS[options.agent]) {
    throw new Error(`Unknown agent "${options.agent}". Choose pi, codex, or claude.`);
  }
  if (options.memoryMode && !['managed', 'ephemeral'].includes(options.memoryMode)) {
    throw new Error('--memory must be managed or ephemeral.');
  }
  if (options.inlineSource && !options.newSession && !options.open) {
    throw new Error('--inline requires --new or --open so scripts select a session explicitly.');
  }
  if (options.inlineSource && options.list) {
    throw new Error('--inline cannot be combined with --list.');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(options.targetUrl);
  } catch {
    throw new Error(`Invalid --url value: ${options.targetUrl}`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) && parsedUrl.href !== 'about:blank') {
    throw new Error('--url must use http://, https://, or about:blank.');
  }
  options.targetUrl = parsedUrl.toString();
  return options;
}

async function printSessions(store) {
  const sessions = await store.list();
  if (!sessions.length) {
    process.stdout.write(`No session folders in ${store.rootDirectory}\n`);
    return;
  }
  process.stdout.write('Sessions (newest first)\n');
  for (const session of sessions) {
    process.stdout.write(
      `${session.id.padEnd(16)} ${ageLabel(session.sortDate).padEnd(12)} ${session.directory}${session.legacy ? ' [legacy]' : ''}\n`,
    );
  }
}

async function openSession(store, idOrPath) {
  if (idOrPath !== 'latest') return store.open(idOrPath);
  const latest = (await store.list())[0];
  if (!latest) throw new Error('No saved session exists to open. Create one with --new first.');
  return store.open(latest.id);
}

function resolveSessionTargetUrl(options, session) {
  return options.targetUrlExplicit
    ? options.targetUrl
    : session.manifest.targetUrl || options.targetUrl;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  await ensureRunDirectoryLayout();
  const inlineDocument = options.inlineSource
    ? await readInlineSequence(options.inlineSource)
    : null;
  const lifecycleOutput = inlineDocument ? process.stderr : process.stdout;

  const store = new SessionStore(DEFAULT_SESSIONS_DIRECTORY, {
    targetUrl: options.targetUrl,
  });
  if (options.list) {
    await printSessions(store);
    return;
  }

  let session;
  if (options.newSession) {
    session = await store.create({
      targetUrl: options.targetUrl,
      agent: options.agent || 'pi',
    });
  } else if (options.open) {
    session = await openSession(store, options.open);
  } else {
    session = await chooseSession(store, {
      targetUrl: options.targetUrl,
      agent: options.agent || 'pi',
    });
  }
  if (!session) return;
  const targetUrl = resolveSessionTargetUrl(options, session);
  const extensions = await loadExtensions(extensionEntries(session.manifest), {
    workingDirectory: RUN_DIRECTORY,
    session,
  });
  const workflowStore = await new WorkflowStore(session, extensions).initialize();

  let browser = null;
  let conversationStore = null;
  let runner = null;
  let chat = null;
  let signalReceived = null;
  let lease = null;

  try {
    lease = await store.acquireLease(session);
    const inlineStepManaged = inlineDocument?.steps.some((step) => {
      if (!step || typeof step !== 'object') return false;
      if (step.mode === 'managed') return true;
      const command = String(step.command || '').replace(/^\/+/, '').toLowerCase();
      return command === 'compact' ||
        (command === 'memory' && String(step.mode || step.value || '').toLowerCase() === 'managed');
    });
    const inlineUsesConversationCommands = inlineDocument?.steps.some((step) => {
      if (!step || typeof step !== 'object') return false;
      return String(step.command || '').replace(/^\/+/, '').toLowerCase() === 'conversation';
    });
    const memoryMode =
      inlineDocument?.mode ||
      options.memoryMode ||
      (inlineDocument ? 'ephemeral' : 'managed');
    const needsManagedConversation = memoryMode === 'managed' || inlineStepManaged;
    const needsConversationStore =
      !inlineDocument || needsManagedConversation || inlineUsesConversationCommands;
    if (needsConversationStore) {
      conversationStore = await new ConversationStore(session).initialize();
      if (inlineDocument) {
        if (needsManagedConversation && !inlineDocument.conversation) {
          throw new Error(
            'Managed inline mode requires conversation: "new", "latest", or an existing conversation id.',
          );
        }
        if (inlineDocument.conversation === 'new') {
          await conversationStore.create();
        } else if (inlineDocument.conversation) {
          await conversationStore.resume(inlineDocument.conversation);
        }
      } else if (memoryMode === 'managed' && session.openedExisting) {
        const latest = conversationStore.list()[0];
        if (latest) await conversationStore.resume(latest.id);
        else await conversationStore.create();
      } else if (memoryMode === 'managed') {
        await conversationStore.create();
      }
    }
    if (!options.noBrowser) {
      lifecycleOutput.write(`Launching service-managed ${options.headless ? 'headless' : 'headed'} Chrome…\n`);
      browser = new BrowserManager(session, {
        targetUrl,
        headless: options.headless,
        chromePath: options.chromePath,
        workingDirectory: RUN_DIRECTORY,
        recoveredSession: session.openedExisting,
        extensions,
        workflowStore,
        onStateChange: async (state, bridge) => {
          await store.update(session, {
            targetUrl,
            browser: {
              cdpUrl: state.cdpUrl,
              lastPid: state.pid,
              lastPort: state.port || state.lastKnownPort,
              lastUrl: state.activePageUrl,
              recovered: state.recovered,
              recoveredSession: state.recoveredSession,
              reusedRunningChrome: state.reusedRunningChrome,
              headless: state.headless,
              connectedAt: state.connectedAt,
              bridgeHost: bridge?.host || null,
              bridgePort: bridge?.port || null,
              bridgeTokenPath: bridge?.tokenPath || null,
              stoppedAt: null,
            },
          });
        },
      });
      const browserState = await browser.start();
      lifecycleOutput.write(
        `Chrome ready: ${browserState.cdpUrl} • page ${browserState.activePageUrl || '(navigation pending)'}\n`,
      );
    }

    runner = new AgentRunner(session, store, {
      workspaceRoot: RUN_DIRECTORY,
      agent: options.agent || session.manifest.selectedAgent || 'pi',
      browserContextProvider: async () => {
        if (browser) return browser.agentContext();
        return {
          connected: false,
          sessionId: session.id,
          sessionPath: session.directory,
        };
      },
      conversationStore,
      memoryMode,
      verbose: options.verbose,
      browserHookInvoker: browser
        ? (name, payload, runtime) => browser.invokeBrowserHook(name, payload, runtime)
        : null,
      extensions,
      workflowStore,
    });
    if (options.agent && options.agent !== session.manifest.selectedAgent) {
      await runner.select(options.agent);
    }

    const onSignal = (signal) => {
      signalReceived = signal;
      if (runner.cancel()) {
        lifecycleOutput.write(`\nAgent cancellation requested.\n`);
      } else if (chat) {
        chat.requestStop();
      }
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      if (inlineDocument) {
        const inlineRunner = new InlineRunner({
          session,
          browser,
          agentRunner: runner,
        });
        const result = await inlineRunner.run(inlineDocument);
        if (!result.ok) process.exitCode = 1;
      } else {
        chat = new TerminalChat({
          session,
          store,
          browser,
          agentRunner: runner,
          templatesDirectory: DEFAULT_TEMPLATES_DIRECTORY,
          workflowStore,
        });
        await chat.start();
      }
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  } finally {
    if (lease) {
      lifecycleOutput.write('\nSaving session and stopping service-managed browser…\n');
      if (runner) await runner.stop().catch(() => {});
      if (browser) {
        const finalState = await browser.state().catch(() => null);
        await browser.stop();
        await store
          .update(session, {
            browser: {
              cdpUrl: null,
              lastPid: null,
              lastPort: finalState?.port || browser.port,
              lastUrl: finalState?.activePageUrl || null,
              recovered: false,
              bridgeHost: null,
              bridgePort: null,
              bridgeTokenPath: null,
              stoppedAt: new Date().toISOString(),
            },
          })
          .catch(() => {});
      }
      await store.releaseLease(lease).catch(() => {});
      lifecycleOutput.write(`Session saved: ${session.directory}\n`);
    }
  }

  if (signalReceived === 'SIGTERM') process.exitCode = 143;
}

// Bridge `evaluate` runs model-authored Playwright code. That code can start a
// promise without awaiting it; when such a floating promise later rejects, Node
// would otherwise treat it as fatal and kill the whole session service. Log it
// loudly and keep the service, browser, and session alive instead.
function registerServiceGuards(output = process.stderr) {
  const onUnhandledRejection = (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    output.write(`\u001b[33mUnhandled async error (service continues):\u001b[0m ${message}\n`);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  return () => process.removeListener('unhandledRejection', onUnhandledRejection);
}

if (require.main === module) {
  registerServiceGuards();
  main().catch((error) => {
    process.stderr.write(`\u001b[31mError:\u001b[0m ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SESSIONS_DIRECTORY,
  DEFAULT_TEMPLATES_DIRECTORY,
  DEFAULT_URL,
  BROWSERCTL_DIRECTORY,
  RUN_DIRECTORY,
  VERSION,
  ensureRunDirectoryLayout,
  main,
  openSession,
  parseArguments,
  printSessions,
  registerServiceGuards,
  resolveRunDirectory,
  resolveSessionTargetUrl,
  usage,
};
