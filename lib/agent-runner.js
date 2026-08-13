'use strict';

const { spawn } = require('node:child_process');
const { createWorker, piIsolationArgs } = require('./agent-workers');
const {
  assistantText,
  renderAgentEvent,
  truncate,
} = require('./agent-event-renderer');
const { commandExists, stripAnsi } = require('./utils');
const {
  describeSemanticProposal,
  parseSemanticAction,
  prepareSemanticAction,
  semanticProposalFromToolArgs,
  semanticCapabilityPrompt,
} = require('./semantic-action');

const AGENTS = {
  pi: {
    label: 'Pi coding agent',
    binary: () => process.env.BROWSERCTL_PI_BIN || 'pi',
    installHint:
      'Install a Pi coding-agent CLI that supports --print and --no-session, then ensure `pi` is on PATH or set BROWSERCTL_PI_BIN.',
  },
  codex: {
    label: 'Codex',
    binary: () => process.env.BROWSERCTL_CODEX_BIN || 'codex',
    installHint:
      'Install the Codex CLI, then ensure `codex` is on PATH or set BROWSERCTL_CODEX_BIN.',
  },
  claude: {
    label: 'Claude Code',
    binary: () => process.env.BROWSERCTL_CLAUDE_BIN || 'claude',
    installHint:
      'Install Claude Code, then ensure `claude` is on PATH or set BROWSERCTL_CLAUDE_BIN.',
  },
};
const WORKFLOW_UPDATE_TOOL = 'browserctl_update_workflow';
const DEFAULT_RECOVERY_ATTEMPTS = 2;
const MAX_RECOVERY_ATTEMPTS = 3;

function markFailure(error, details = {}) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  normalized.browserctlFailure = {
    phase: 'agent-turn',
    sideEffects: 'uncertain',
    recoverable: true,
    ...(normalized.browserctlFailure || {}),
    ...details,
  };
  return normalized;
}

function recoveryAttempts(value) {
  if (value === undefined || value === null) return DEFAULT_RECOVERY_ATTEMPTS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RECOVERY_ATTEMPTS) {
    throw new Error(`recoveryAttempts must be an integer from 0 to ${MAX_RECOVERY_ATTEMPTS}.`);
  }
  return parsed;
}

function failureEnvelope(error, attempt) {
  const details = error?.browserctlFailure || {};
  return {
    attempt,
    at: new Date().toISOString(),
    name: String(error?.name || 'Error').slice(0, 120),
    message: stripAnsi(String(error?.message || error || 'Unknown failure')).slice(0, 2400),
    phase: String(details.phase || 'agent-turn').slice(0, 240),
    sideEffects: String(details.sideEffects || 'uncertain').slice(0, 400),
    recoverable: details.recoverable !== false,
    action: details.action && typeof details.action === 'object'
      ? details.action
      : undefined,
    toolActivity: Array.isArray(details.toolActivity)
      ? details.toolActivity.slice(0, 12).map((tool) => String(tool).slice(0, 160))
      : undefined,
  };
}

function recoveryTurnPrompt(originalRequest, failures, recoveryAttempt, maximum) {
  const envelope = {
    version: 1,
    recoveryAttempt,
    maximumRecoveryAttempts: maximum,
    originalHumanRequest: String(originalRequest || '').slice(0, 12_000),
    failures,
  };
  return `# AUTOMATIC FAILURE RECOVERY

The preceding work for the original human request failed. This is a general
browserctl recovery turn, not an instruction to blindly repeat the prior action.

Failure envelope:

\`\`\`json
${JSON.stringify(envelope, null, 2)}
\`\`\`

Use the fresh live browser, workflow, conversation, and application-extension
context supplied with this turn. Treat prior side effects as uncertain unless the
envelope proves none occurred.

1. Inspect authoritative current state and any verification, checkpoint, action,
   or workflow evidence before mutating anything.
2. Determine whether the requested effect already happened. If it did, verify it
   and explain that clearly instead of repeating it.
3. If it did not happen and a repair or retry is safe, diagnose the cause, make
   only the necessary correction through normal browser tools or a fitting typed
   capability, then verify the result.
4. If human action, authentication, missing authority, or unsafe ambiguity blocks
   progress, stop retrying and give the human a concise explanation and next step.
   Update an active workflow to waiting or failed with evidence when appropriate.
5. Return a useful user-facing outcome. Do not expose internal action JSON and do
   not ask the human to restate the original request.
`;
}

function browserContextPrompt(state) {
  if (!state?.connected) {
    const launchCommand = state?.browserControlCommand
      ? `${state.browserControlCommand} launch`
      : null;
    return `# LIVE PLAYWRIGHT CONTEXT — refreshed for this turn

The service currently has no connected browser or managed tab.

- Session id: ${state?.sessionId || 'unknown'}
- Session path: ${state?.sessionPath || 'unknown'}
- Intended application URL: ${state?.targetUrl || 'unknown'}
- Headed mode on relaunch: ${state?.headless === undefined ? 'unknown' : !state.headless}
- Last known Chrome PID: ${state?.lastKnownPid ?? 'none'}
- Last known CDP port: ${state?.lastKnownPort ?? 'none'}
- Browser control command: ${state?.browserControlCommand || 'unavailable'}
- Bridge host: ${state?.browserBridgeHost || 'unavailable'}
- Bridge port: ${state?.browserBridgePort || 'unavailable'}
- Bridge token file: ${state?.browserBridgeTokenPath || 'unavailable'}
${state?.contextInspectionError ? `- Context inspection error: ${state.contextInspectionError}` : ''}

Chrome and Playwright remain service-owned. Do not launch Chrome directly and do not call connectOverCDP.
${launchCommand ? `Request a service-owned recovery with:

\`\`\`bash
${launchCommand}
\`\`\`

After it succeeds, run \`${state.browserControlCommand} state\` and then use the normal bridge eval/run commands. The service will restore the same profile, target URL, headed state, download policy, logs, and artifact paths.` : 'The browser gateway is unavailable in this diagnostic run; explain that browser work cannot continue.'}
`;
  }

  const pageRows = state.pages
    .map(
      (page) =>
        `  - [${page.index}]${page.active ? ' ACTIVE' : ''} title=${JSON.stringify(page.title)} url=${page.url}`,
    )
    .join('\n');
  const hookRows = (state.browserHooks || [])
    .map((hook) =>
      `  - ${hook.name}: ${hook.description || 'Application-provided browser operation'}${hook.inputHint ? ` Input: ${hook.inputHint}` : ''}`,
    )
    .join('\n');
  const activeWorkflow = state.workflow?.active || null;
  const workflowBlock = activeWorkflow
    ? `Active resumable workflow (authoritative host state):

\`\`\`json
${JSON.stringify(activeWorkflow, null, 2)}
\`\`\`

This plan is guidance and progress state, not a blind click script. Inspect the live page before every action and adapt to what actually exists. Update each step when observation changes the branch. Never mark a step complete without a short verification note. ${state.workflowUpdateToolAvailable ? `Call the host-provided \`${WORKFLOW_UPDATE_TOOL}\` tool with exact \`stepId\`, \`status\`, and \`note\`; do not merely claim in prose that the tracker changed and do not use a shell command for this update.` : `Use \`${state.browserControlCommand} workflow update '<JSON>'\` with exact \`stepId\`, \`status\`, and \`note\`.`} Use waiting when human login, confirmation, or another human action is required. Use skipped when live evidence makes a conditional branch unnecessary. The human can click Retry or Prompt agent in the browser plan panel at any time.`
    : `No workflow is currently active. Available extension-declared workflow templates: ${JSON.stringify(state.workflow?.available || [])}. A workflow starts only through selected-agent semantic interpretation and host validation; do not infer activation from keyword matching.`;

  return `# LIVE PLAYWRIGHT CONTEXT — refreshed immediately before this turn

This block is authoritative for this message. The launcher service exclusively owns Chrome and Playwright lifecycle, recovery, profile, downloads, and shutdown. You may inspect and fully manipulate the existing tab only through the service-owned bridge described below; do not launch another browser, create another Playwright connection, close the shared browser/context, alter its profile, or manage its lifecycle.

Session and process:
- Session id: ${state.sessionId}
- Session path: ${state.sessionPath}
- Working directory: ${state.workingDirectory}
- Chrome PID: ${state.pid ?? 'existing process; PID unavailable after recovery'}
- Headed: ${!state.headless} (headless=${state.headless})
- Reopened an existing saved session/profile: ${state.recoveredSession}
- Reconnected to a Chrome process that was already running: ${state.reusedRunningChrome}
- Playwright connected: ${state.connected}
- Connected at: ${state.connectedAt}
- Browser version: ${state.browserVersion}

Playwright/CDP identity:
- Package: ${state.playwrightPackage}
- CDP URL: ${state.cdpUrl}
- CDP port: ${state.port}
- Browser contexts: ${state.contextCount}
- Open pages: ${state.pageCount}
- Active page index: ${state.activePageIndex}
- Active page target id: ${state.activePageTargetId}
- Active page title: ${JSON.stringify(state.activePageTitle)}
- Active page URL: ${state.activePageUrl}
- Intended application URL: ${state.targetUrl}

Open page state:
${pageRows || '  - No open pages'}

Persistent artifacts:
- Chrome profile: ${state.browserProfilePath}
- Downloads: ${state.downloadsPath}
- Drafts: ${state.draftsPath}
- Service download policy active: ${state.downloadPolicyEnforced}
- Screenshots: ${state.screenshotsPath}
- Saves: ${state.savesPath}
- Browser event log: ${state.browserEventLogPath}
- Latest storage state: ${state.storageStatePath} (saved=${state.storageStateSaved})
- Extension-owned state: ${JSON.stringify(state.extensionContext || {})}

Service-owned access:
- Access mode: ${state.browserAccessMode}
- Browser control command: ${state.browserControlCommand}
- Bridge host: ${state.browserBridgeHost}
- Bridge port: ${state.browserBridgePort}
- Bridge token file: ${state.browserBridgeTokenPath}

The CDP values above identify the managed browser for diagnostics. Do not call connectOverCDP or create another Playwright client. Submit operations into the launcher's existing Playwright objects through the bridge:

\`\`\`bash
${state.browserControlCommand} state
${state.browserControlCommand} eval 'return { title: await page.title(), url: page.url() };'
\`\`\`

Translate the human's natural-language intent into browser work yourself. Do not ask the human to restate a request as a terminal command or to run browser-control syntax. Inspect the current page before mutating it, use semantic labels/roles and application APIs when available, and verify the visible result afterward.

Keep useful pages open so the human can observe and revisit the work. Reuse an existing matching page when possible. Close a page only when the human asks, it is stale, or retained work pages must be pruned to free space; never close the managed page, context, or browser.

${workflowBlock}

${hookRows ? `Application extensions registered for this session:\n${hookRows}\n\nA semantic capability protocol may be supplied in APPLICATION EXTENSIONS below. When it covers the requested outcome, follow that protocol and return its typed proposal instead of invoking the hook through the shell. For lower-level extension work not covered by a semantic capability, you may invoke a registered hook with:\n\n\`\`\`bash\n${state.browserControlCommand} invoke <hook-name> '<JSON-payload>'\n\`\`\`\n\nThese hooks and proposals are internal capabilities, not syntax the human must learn or type.` : 'No application-specific browser hooks are registered. Use the generic state, eval, run, open, reload, screenshot, and save operations.'}

For multiline operations, write only the JavaScript function body to a file under the session Drafts path, then run:

\`\`\`bash
${state.browserControlCommand} run /absolute/path/to/script.js
\`\`\`

Bridge code executes inside the service and receives \`page\`, \`context\`, \`playwrightBrowser\`, \`session\`, and \`paths\`. Return a JSON-serializable result. You have full page/context inspection and manipulation access. Never close the service-owned browser or context, and do not close its managed page.

The human may manipulate this same tab between turns. Query state or re-read the live page before acting; never rely only on earlier conversation state. Browser downloads are intercepted and managed by the service and remain in the Downloads path above. Store any other session-specific output under the Session path, not in a separate ad-hoc location.
`;
}

function formatTurnPrompt(state, userPrompt, continuity = '', extensionInstructions = '') {
  return `${continuity ? `${continuity}\n` : ''}${browserContextPrompt(state)}
${extensionInstructions ? `\n# APPLICATION EXTENSIONS\n\n${extensionInstructions}\n` : ''}

# USER REQUEST FOR THIS TURN

${userPrompt}
`;
}

// Accepts 'id', 'provider/id', or {provider, id} and returns {provider, id}
// with provider null when unspecified (resolved later against the live worker's
// available models).
function parsePiModelPreference(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    return value.id ? { provider: value.provider || null, id: String(value.id) } : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash === -1) return { provider: null, id: text };
  const provider = text.slice(0, slash).trim();
  const id = text.slice(slash + 1).trim();
  return id ? { provider: provider || null, id } : null;
}

class AgentRunner {
  constructor(session, store, options = {}) {
    this.session = session;
    this.store = store;
    this.workspaceRoot = options.workspaceRoot;
    this.browserContextProvider = options.browserContextProvider;
    this.conversationStore = options.conversationStore || null;
    this.selected = options.agent || session.manifest.selectedAgent || 'pi';
    this.verbose = Boolean(options.verbose);
    this.memoryMode = options.memoryMode || 'managed';
    this.extensions = Array.isArray(options.extensions) ? options.extensions : [];
    this.browserHookInvoker = options.browserHookInvoker || null;
    this.workflowStore = options.workflowStore || null;
    this.recoveryAttempts = recoveryAttempts(options.recoveryAttempts);
    this.activeChild = null;
    this.worker = null;
    this.workerHydratedConversationId = null;
    this.workerFallback = null;
    // Precedence: explicit option, then the session's saved choice, then the
    // environment default, then whatever the Pi installation itself defaults to.
    this.piPreferredModel = parsePiModelPreference(
      options.piModel || session.manifest.selectedPiModel || process.env.BROWSERCTL_PI_MODEL,
    );
    this.cancelled = false;
  }

  availability() {
    return Object.fromEntries(
      Object.entries(AGENTS).map(([id, descriptor]) => [
        id,
        {
          ...descriptor,
          command: descriptor.binary(),
          available: commandExists(descriptor.binary()),
        },
      ]),
    );
  }

  async select(agent, options = {}) {
    if (!AGENTS[agent]) throw new Error(`Unknown agent: ${agent}`);
    if (agent !== this.selected) await this.stopWorker();
    this.selected = agent;
    if (options.persist !== false) {
      await this.store.update(this.session, { selectedAgent: agent });
    }
  }

  async applyPiModelPreference(worker) {
    const preference = this.piPreferredModel;
    if (!preference) return null;
    const current = worker.status().model;
    if (current?.id === preference.id &&
        (!preference.provider || current?.provider === preference.provider)) {
      return null;
    }
    let target = preference;
    if (!target.provider) {
      const available = await worker.availableModels();
      const match = available.find((model) => model.id === preference.id);
      if (!match) {
        throw new Error(
          `Pi model ${preference.id} is not available. Known models: ${available.map((model) => `${model.provider}/${model.id}`).join(', ') || '(none reported)'}.`,
        );
      }
      target = match;
    }
    const selected = await worker.setModel(target);
    this.piPreferredModel = { provider: selected.provider || target.provider, id: selected.id || target.id };
    return selected;
  }

  async setPiModel(value, options = {}) {
    const preference = parsePiModelPreference(value);
    if (!preference) throw new Error('A Pi model id (or provider/id) is required.');
    this.piPreferredModel = preference;
    let applied = null;
    if (this.worker && this.selected === 'pi') {
      applied = await this.applyPiModelPreference(this.worker);
    }
    const resolved = this.piPreferredModel;
    if (options.persist !== false) {
      await this.store.update(this.session, {
        selectedPiModel: { provider: resolved.provider || null, id: resolved.id },
      });
    }
    return applied || resolved;
  }

  // Model listing is only as general as each agent's wire protocol: Pi's RPC
  // exposes get_available_models, while the Codex and Claude protocols expose
  // no model listing, so those agents report the capability as unsupported
  // rather than guessing from configuration files.
  async describeModels(options = {}) {
    if (this.selected !== 'pi') {
      return { agent: this.selected, supported: false, current: null, preferred: null, available: [] };
    }
    let worker = this.worker?.status?.().running ? this.worker : null;
    if (!worker && options.spawn) {
      worker = await this.ensureWorker(options.onOutput || (() => {}));
    }
    if (!worker) {
      return { agent: 'pi', supported: true, current: null, preferred: this.piPreferredModel, available: [] };
    }
    return {
      agent: 'pi',
      supported: true,
      current: worker.status().model,
      preferred: this.piPreferredModel,
      available: await worker.availableModels(),
    };
  }

  setVerbose(enabled) {
    this.verbose = Boolean(enabled);
    return this.verbose;
  }

  async setMemoryMode(mode) {
    if (!['managed', 'ephemeral'].includes(mode)) {
      throw new Error('Memory mode must be managed or ephemeral.');
    }
    if (mode !== this.memoryMode) await this.stopWorker();
    this.memoryMode = mode;
    if (mode === 'managed' && this.conversationStore) {
      await this.conversationStore.ensureActive();
    }
    return this.memoryMode;
  }

  async newConversation(name = null) {
    if (!this.conversationStore) throw new Error('Conversation storage is unavailable.');
    await this.stopWorker();
    return this.conversationStore.create(name);
  }

  async resumeConversation(id = 'latest') {
    if (!this.conversationStore) throw new Error('Conversation storage is unavailable.');
    await this.stopWorker();
    return this.conversationStore.resume(id);
  }

  listConversations() {
    return this.conversationStore?.list() || [];
  }

  async conversationStatus() {
    return this.conversationStore
      ? this.conversationStore.status()
      : { active: false, unavailable: true };
  }

  async getBrowserContext() {
    if (!this.browserContextProvider) {
      return {
        connected: false,
        sessionId: this.session.id,
        sessionPath: this.session.directory,
      };
    }
    return this.browserContextProvider();
  }

  async extensionInstructions(context, extensions = this.extensions) {
    const blocks = [];
    for (const extension of extensions) {
      try {
        await extension.beforeTurn?.(context);
        const instructions = typeof extension.agentInstructions === 'function'
          ? await extension.agentInstructions(context)
          : extension.agentInstructions;
        if (String(instructions || '').trim()) {
          blocks.push(`## ${extension.id}\n\n${String(instructions).trim()}`);
        }
      } catch (error) {
        if (!context.recoveryTurn) {
          throw markFailure(error, {
            phase: 'application-context',
            sideEffects: 'none from this turn; application context preparation failed',
            action: {extensionId: extension.id},
          });
        }
        blocks.push(
          `## ${extension.id} recovery notice\n\n` +
          `Refreshing this extension's context failed: ${String(error.message || error).slice(0, 1200)}. ` +
          'Use the fresh generic browser state, inspect the live application directly, and explain if safe recovery is not possible.',
        );
      }
    }
    const capabilityInstructions = context.skipCapabilities
      ? ''
      : semanticCapabilityPrompt(extensions, context);
    if (capabilityInstructions) blocks.push(capabilityInstructions);
    return blocks.join('\n\n');
  }

  environment() {
    return {
      ...process.env,
      BROWSERCTL_SESSION_ID: this.session.id,
      BROWSERCTL_SESSION_DIR: this.session.directory,
      BROWSERCTL_RUN_DIR: this.workspaceRoot,
      BROWSERCTL_CDP_URL: this.session.manifest.browser?.cdpUrl || '',
      BROWSER_CDP_URL: this.session.manifest.browser?.cdpUrl || '',
      BROWSERCTL_BROWSER_HOST:
        this.session.manifest.browser?.bridgeHost || '127.0.0.1',
      BROWSERCTL_BROWSER_PORT:
        String(this.session.manifest.browser?.bridgePort || ''),
      BROWSERCTL_BROWSER_TOKEN_FILE:
        this.session.manifest.browser?.bridgeTokenPath || '',
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      RUST_LOG: process.env.RUST_LOG || 'error',
    };
  }

  async ensureWorker(onOutput) {
    if (
      this.worker &&
      this.worker.agent === this.selected &&
      this.worker.status().running
    ) {
      return this.worker;
    }
    await this.stopWorker();
    const descriptor = AGENTS[this.selected];
    const worker = createWorker(this.selected, {
      command: descriptor.binary(),
      cwd: this.workspaceRoot,
      env: this.environment(),
    });
    try {
      await worker.start();
      if (this.selected === 'pi' && this.piPreferredModel) {
        try {
          const applied = await this.applyPiModelPreference(worker);
          if (applied) onOutput(`Using Pi model ${applied.id} for this console.\n`);
        } catch (error) {
          onOutput(`Pi model preference was not applied (${error.message}); continuing with ${worker.status().model?.id || 'the Pi default'}.\n`);
        }
      }
      this.worker = worker;
      this.workerFallback = null;
      this.workerHydratedConversationId = null;
      return worker;
    } catch (error) {
      worker.stop();
      this.worker = null;
      this.workerFallback = {
        agent: this.selected,
        reason: error.message,
        at: new Date().toISOString(),
      };
      onOutput(
        `\u001b[33m[managed fallback] ${this.selected} live protocol unavailable; using a fresh nonpersistent process with service context replay: ${error.message}\u001b[0m\n`,
      );
      return null;
    }
  }

  async run(userPrompt, onOutput = (chunk) => process.stdout.write(chunk), options = {}) {
    if (options.autoRecover === false || options.boundedDecision) {
      return this.runOnce(userPrompt, onOutput, options);
    }
    const maximum = recoveryAttempts(
      options.recoveryAttempts === undefined
        ? this.recoveryAttempts
        : options.recoveryAttempts,
    );
    const failures = [];
    let prompt = userPrompt;
    let recoveryAttempt = 0;
    while (true) {
      try {
        const output = await this.runOnce(prompt, onOutput, {
          ...options,
          autoRecover: false,
          record: recoveryAttempt ? false : options.record,
          recoveryTurn: recoveryAttempt > 0,
          skipTurnHandlers: recoveryAttempt ? true : options.skipTurnHandlers,
          onActivity: recoveryAttempt ? null : options.onActivity,
        });
        if (recoveryAttempt) {
          onOutput(
            `Recovery completed after ${recoveryAttempt} agent-guided ` +
            `attempt${recoveryAttempt === 1 ? '' : 's'}.\n`,
          );
          const memoryMode = options.memoryMode || this.memoryMode;
          if (
            memoryMode === 'managed' &&
            options.record !== false &&
            this.conversationStore
          ) {
            try {
              await this.conversationStore.appendTurn({
                agent: this.selected,
                user: userPrompt,
                assistant: stripAnsi(output).trim(),
                usage: null,
              });
            } catch (error) {
              throw markFailure(error, {
                phase: 'conversation-recording',
                sideEffects: 'the requested browser/application effect may already be complete; do not repeat it merely because recording failed',
              });
            }
          }
        }
        return output;
      } catch (error) {
        const failure = failureEnvelope(error, failures.length + 1);
        failures.push(failure);
        if (!failure.recoverable || recoveryAttempt >= maximum) {
          if (recoveryAttempt >= maximum && maximum) {
            onOutput(
              `Automatic recovery stopped after ${maximum} agent-guided ` +
              `attempt${maximum === 1 ? '' : 's'}; the latest failure still needs attention.\n`,
            );
          }
          throw error;
        }
        recoveryAttempt += 1;
        onOutput(
          `Attempt ${failure.attempt} failed during ${failure.phase}: ${failure.message}\n` +
          `Handing the error and fresh live state to ${AGENTS[this.selected].label} ` +
          `for recovery ${recoveryAttempt}/${maximum}. It will inspect before retrying anything.\n`,
        );
        prompt = recoveryTurnPrompt(userPrompt, failures, recoveryAttempt, maximum);
      }
    }
  }

  async runOnce(userPrompt, onOutput = (chunk) => process.stdout.write(chunk), options = {}) {
    this.cancelled = false;
    const descriptor = AGENTS[this.selected];
    let liveBrowserState;
    try {
      liveBrowserState = await this.getBrowserContext();
    } catch (error) {
      if (!options.recoveryTurn) {
        throw markFailure(error, {
          phase: 'browser-context',
          sideEffects: 'none from this turn; current external state was not readable',
        });
      }
      liveBrowserState = {
        connected: false,
        sessionId: this.session.id,
        sessionPath: this.session.directory,
        contextInspectionError: String(error.message || error).slice(0, 1200),
      };
    }
    liveBrowserState.workflowUpdateToolAvailable = this.selected === 'pi';
    const workflowRevisionBefore = liveBrowserState.workflow?.active?.updatedAt || null;
    const memoryMode = options.memoryMode || this.memoryMode;
    if (!['managed', 'ephemeral'].includes(memoryMode)) {
      throw markFailure(new Error(`Unknown memory mode: ${memoryMode}`), {
        phase: 'runtime-configuration',
        sideEffects: 'none',
        recoverable: false,
      });
    }
    let continuity = '';
    let conversationId = null;
    if (memoryMode === 'managed') {
      if (!this.conversationStore) {
        throw markFailure(new Error('Managed mode requires service conversation storage.'), {
          phase: 'runtime-configuration',
          sideEffects: 'none',
          recoverable: false,
        });
      }
      await this.conversationStore.ensureActive();
      conversationId = this.conversationStore.activeId;
      if (
        !this.worker ||
        this.worker.agent !== this.selected ||
        this.workerHydratedConversationId !== conversationId
      ) {
        continuity = (await this.conversationStore.replayContext()).text;
      }
    }
    const extensionContext = {
      runner: this,
      session: this.session,
      browserState: liveBrowserState,
      userPrompt,
      memoryMode,
      invokeBrowserHook: async (name, payload) => {
        if (!this.browserHookInvoker) {
          throw new Error('The browser extension hook gateway is unavailable for this run.');
        }
        return this.browserHookInvoker(name, payload, {
          agentDecision: async (prompt, decisionOptions = {}) => {
            if (options.boundedDecision) {
              throw new Error('A bounded application decision cannot request another agent decision.');
            }
            const decisionPrompt = String(prompt || '').trim();
            if (!decisionPrompt) throw new Error('A bounded application decision requires a prompt.');
            const label = String(decisionOptions.label || 'the application evidence').trim();
            onOutput(`${descriptor.label} is evaluating ${label} before any application mutation.\n`);
            return this.run(decisionPrompt, () => {}, {
              memoryMode: 'ephemeral',
              record: false,
              extensions: false,
              verbose: false,
              boundedDecision: true,
              autoRecover: false,
            });
          },
        });
      },
      skipCapabilities: options.skipCapabilities === true,
      recoveryTurn: options.recoveryTurn === true,
    };
    const activeExtensions = options.extensions === false ? [] : this.extensions;
    const extensionInstructions = await this.extensionInstructions(
      extensionContext,
      activeExtensions,
    );
    const fullPrompt = formatTurnPrompt(
      liveBrowserState,
      userPrompt,
      continuity,
      extensionInstructions,
    );
    const verbose = options.verbose === undefined ? this.verbose : Boolean(options.verbose);
    const onActivity = typeof options.onActivity === 'function' ? options.onActivity : null;
    if (verbose) {
      onOutput(
        `[verbose:turn] agent=${this.selected} memory=${memoryMode} browser=${liveBrowserState.connected ? 'connected' : 'offline'} pages=${liveBrowserState.pageCount ?? 0}\n` +
        `[verbose:request] ${truncate(userPrompt, 320)}\n`,
      );
    }

    const finishExtensionTurn = async (extension, handled, handledLabel = null) => {
      const handledOutput = typeof handled === 'string'
        ? handled
        : String(handled?.output || '');
      if (!handledOutput.trim()) {
        throw new Error(`Extension ${extension.id} handled the turn but returned no output.`);
      }
      if (handledLabel) {
        onActivity?.({ type: 'extension', extensionId: extension.id, label: handledLabel });
      }
      onOutput(`${handledOutput.trimEnd()}\n`);
      for (const activeExtension of activeExtensions) {
        try {
          await activeExtension.afterTurn?.({
            ...extensionContext,
            output: handledOutput,
            handledByExtension: extension.id,
          });
        } catch (error) {
          throw markFailure(error, {
            phase: 'application-after-turn',
            sideEffects: 'the requested effect and user-visible output may already be complete; inspect before any retry',
            action: {extensionId: activeExtension.id},
          });
        }
      }
      if (memoryMode === 'managed') {
        if (options.record !== false) {
          await this.conversationStore.appendTurn({
            agent: `extension:${extension.id}`,
            user: userPrompt,
            assistant: stripAnsi(handledOutput).trim(),
            usage: null,
          });
        }
        await this.stopWorker();
      }
      return `${handledOutput.trimEnd()}\n`;
    };

    for (const extension of options.skipTurnHandlers ? [] : activeExtensions) {
      if (typeof extension.handleTurn !== 'function') continue;
      const classification = typeof extension.canHandleTurn === 'function'
        ? await extension.canHandleTurn(extensionContext)
        : null;
      if (classification) {
        onActivity?.({
          type: 'extension',
          extensionId: extension.id,
          label: typeof classification === 'string' ? classification : extension.id,
        });
      }
      let handled;
      try {
        handled = await extension.handleTurn(extensionContext);
      } catch (error) {
        throw markFailure(error, {
          phase: 'application-turn-handler',
          sideEffects: 'uncertain; inspect application state and its action evidence before retrying',
          action: {extensionId: extension.id},
        });
      }
      if (!handled) continue;
      if (!classification) {
        onActivity?.({ type: 'extension', extensionId: extension.id, label: extension.id });
      }
      return finishExtensionTurn(extension, handled);
    }

    const command = descriptor.binary();
    if (!commandExists(command)) {
      throw markFailure(
        new Error(`${descriptor.label} is unavailable. ${descriptor.installHint}`),
        {
          phase: 'agent-runtime',
          sideEffects: 'none',
          recoverable: false,
        },
      );
    }
    onActivity?.({ type: 'agent', agent: this.selected, label: this.selected });

    const semanticExtensions = options.skipCapabilities ? [] : activeExtensions;
    const defersAgentOutput = semanticExtensions.some((extension) =>
      extension.semanticCapabilities?.length,
    );
    const capturesWorkflowUpdates = this.selected === 'pi' &&
      Boolean(liveBrowserState.workflow?.active);
    const deferredAgentOutput = [];
    const modelOutput = defersAgentOutput || capturesWorkflowUpdates
      ? (chunk) => deferredAgentOutput.push(chunk)
      : onOutput;
    const flushDeferredAgentOutput = () => {
      for (const chunk of deferredAgentOutput.splice(0)) onOutput(chunk);
    };
    const announcedSemanticProposals = new Set();
    const announceSemanticProposal = (rawProposal) => {
      let proposal;
      let description;
      try {
        proposal = semanticProposalFromToolArgs(rawProposal);
        description = describeSemanticProposal(semanticExtensions, proposal);
      } catch {
        return;
      }
      const key = JSON.stringify(rawProposal);
      if (announcedSemanticProposals.has(key)) return;
      announcedSemanticProposals.add(key);
      const understood = description.interpretation ||
        `${description.descriptor.label}${description.target ? ` for ${description.target.label}` : ''}`;
      const route = `${description.descriptor.label}` +
        `${description.target ? ` → ${description.target.label}` : ''}`;
      onOutput(`I understood your request as: ${understood}\n`);
      onOutput(
        `Planned route: ${route}. ` +
        `${description.rationale ? `Why: ${description.rationale} ` : ''}` +
        'I’m validating it against the current application state before applying it.\n',
      );
    };

    let result;
    try {
      if (memoryMode === 'managed') {
        const worker = await this.ensureWorker(onOutput);
        if (verbose && worker) {
          onOutput(
            `[verbose:invocation] ${command} ${worker.args.join(' ')} <live-protocol-turn>\n\n`,
          );
        }
        if (worker) {
          const runWorkerTurn = async (prompt) => {
            const startedAt = Date.now();
            const heartbeat = setInterval(() => {
              const status = worker.status();
              const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
              if (status.activeToolCount) {
                onOutput(
                  `Pi is still completing ${status.activeToolName || 'a tool call'} ` +
                  `with model ${status.model?.id || 'unknown'} (${elapsed}s)…\n`,
                );
              } else {
                onOutput(
                  `Still waiting for Pi model ${status.model?.id || 'unknown'} (${elapsed}s); ` +
                  'no tool call has started, so browserctl has not applied anything.\n',
                );
              }
            }, 30_000);
            heartbeat.unref();
            try {
              return await worker.run(prompt, modelOutput, verbose, {
                onSemanticProposal: announceSemanticProposal,
              });
            } finally {
              clearInterval(heartbeat);
            }
          };
          let workerResult = await runWorkerTurn(fullPrompt);
          const inert = (value) => !stripAnsi(value.output || '').trim() &&
            !(value.semanticProposals || []).length &&
            !(value.toolActivity || []).length;
          const attemptedModels = new Set();
          const initialModel = worker.status().model;
          if (initialModel) attemptedModels.add(`${initialModel.provider}/${initialModel.id}`);
          const fallbackModels = this.selected === 'pi' && inert(workerResult)
            ? (await worker.availableModels())
              .filter((model) => !attemptedModels.has(`${model.provider}/${model.id}`))
              .sort((left, right) => {
                const score = (model) => {
                  const name = `${model.id || ''} ${model.name || ''}`.toLowerCase();
                  const sameProvider = model.provider === initialModel?.provider;
                  const isDefault = /(?:^|[-_ ])default(?:$|[-_ ])/.test(name);
                  if (sameProvider && isDefault) return 0;
                  if (sameProvider) return 1;
                  return isDefault ? 2 : 3;
                };
                return score(left) - score(right);
              })
            : [];
          for (const fallbackModel of fallbackModels.slice(0, 2)) {
            if (!inert(workerResult)) break;
            const previousModel = worker.status().model;
            const nextModel = await worker.setModel(fallbackModel);
            const nextKey = nextModel ? `${nextModel.provider}/${nextModel.id}` : null;
            if (!nextKey || attemptedModels.has(nextKey)) break;
            attemptedModels.add(nextKey);
            onOutput(
              `Pi model ${previousModel?.id || 'unknown'} completed an empty, tool-free pass. ` +
              `Trying configured model ${nextModel.id} in the same in-memory worker…\n`,
            );
            workerResult = await runWorkerTurn(
              'The preceding model produced no tool call and no user-visible response. Complete the same human request now using the live context and capability catalog already supplied. Do not ask the human to repeat it.',
            );
          }
          if (this.selected === 'pi' && !inert(workerResult) && attemptedModels.size > 1) {
            this.piPreferredModel = worker.status().model;
          }
          result = {
            ...workerResult,
            code: 0,
            cancelled: false,
          };
        } else {
          const invocation = this.invocation(
            this.selected,
            fullPrompt,
            verbose,
            defersAgentOutput || capturesWorkflowUpdates,
          );
          if (verbose) {
            onOutput(
              `[verbose:invocation] ${command} ${invocation.displayArgs.join(' ')}\n\n`,
            );
          }
          result = await this.spawnAndStream(
            command,
            invocation.args,
            invocation.stdin,
            invocation.mode,
            modelOutput,
            verbose,
            {onSemanticProposal: announceSemanticProposal},
          );
        }
      } else {
        const invocation = this.invocation(
          this.selected,
          fullPrompt,
          verbose,
          defersAgentOutput || capturesWorkflowUpdates,
        );
        if (verbose) {
          onOutput(
            `[verbose:invocation] ${command} ${invocation.displayArgs.join(' ')}\n\n`,
          );
        }
        result = await this.spawnAndStream(
          command,
          invocation.args,
          invocation.stdin,
          invocation.mode,
          modelOutput,
          verbose,
          {onSemanticProposal: announceSemanticProposal},
        );
      }
    } catch (error) {
      if (memoryMode === 'managed') await this.stopWorker();
      throw markFailure(error, {
        phase: this.cancelled ? 'cancelled' : 'agent-runtime',
        sideEffects: this.cancelled
          ? 'uncertain; cancellation may have interrupted work'
          : 'uncertain; inspect fresh browser state before retrying',
        recoverable: !this.cancelled,
      });
    }

    if (this.cancelled) {
      if (memoryMode === 'managed') await this.stopWorker();
      throw markFailure(new Error(`${descriptor.label} was cancelled.`), {
        phase: 'cancelled',
        sideEffects: 'uncertain; cancellation may have interrupted work',
        recoverable: false,
      });
    }
    if (result.cancelled) {
      throw markFailure(new Error(`${descriptor.label} was cancelled.`), {
        phase: 'cancelled',
        sideEffects: 'uncertain; cancellation may have interrupted work',
        recoverable: false,
      });
    }
    if (result.code !== 0) {
      const detail = stripAnsi(result.stderr).trim();
      const activity = Array.isArray(result.toolActivity) ? result.toolActivity : [];
      throw markFailure(
        new Error(
          `${descriptor.label} exited with code ${result.code}${detail ? `: ${detail.slice(-800)}` : '.'}`,
        ),
        {
          phase: 'agent-runtime',
          sideEffects: activity.length
            ? 'uncertain; one or more agent tools started before the process failed'
            : 'none observed; no agent tool call started',
          toolActivity: activity.map((entry) => entry.toolName || 'unknown tool'),
        },
      );
    }
    const capturedWorkflowUpdates = Array.isArray(result.workflowUpdates)
      ? result.workflowUpdates
      : [];
    if (capturedWorkflowUpdates.length && !this.workflowStore) {
      if (memoryMode === 'managed') await this.stopWorker();
      throw new Error('The agent proposed workflow progress, but the workflow store is unavailable.');
    }
    for (const update of capturedWorkflowUpdates) {
      let workflow;
      try {
        workflow = await this.workflowStore.update(update);
      } catch (error) {
        if (memoryMode === 'managed') await this.stopWorker();
        throw markFailure(
          new Error(`The agent proposed an invalid workflow update: ${error.message}`),
          {
            phase: 'workflow-update-validation',
            sideEffects: 'uncertain; inspect browser and authoritative workflow state before retrying',
          },
        );
      }
      const step = workflow.steps.find((candidate) => candidate.id === update.stepId);
      onOutput(
        `Plan updated: ${step?.title || update.stepId} → ${step?.status || update.status}` +
        `${step?.note ? ` — ${step.note}` : ''}\n`,
      );
    }
    if (options.requireWorkflowUpdate) {
      const workflowRevisionAfter = this.workflowStore?.active()?.updatedAt || null;
      if (!workflowRevisionAfter || workflowRevisionAfter === workflowRevisionBefore) {
        if (memoryMode === 'managed') await this.stopWorker();
        throw markFailure(
          new Error(
            'The agent completed workflow work without a persisted plan update. ' +
            'No final explanation was accepted; retry the active step.',
          ),
          {
            phase: 'workflow-progress-verification',
            sideEffects: 'uncertain; inspect the live page before deciding whether work must be repeated',
          },
        );
      }
    }
    const finalOutput = stripAnsi(result.output).trim();
    const capturedSemanticProposals = Array.isArray(result.semanticProposals)
      ? result.semanticProposals
      : [];
    if (capturedSemanticProposals.length > 1) {
      if (verbose) flushDeferredAgentOutput();
      if (memoryMode === 'managed') await this.stopWorker();
      throw markFailure(
        new Error(
          `The agent proposed ${capturedSemanticProposals.length} application actions in one turn; no action was applied.`,
        ),
        {
          phase: 'semantic-action-validation',
          sideEffects: 'none from semantic application hooks',
        },
      );
    }
    let semanticProposal;
    try {
      semanticProposal = capturedSemanticProposals.length === 1
        ? semanticProposalFromToolArgs(capturedSemanticProposals[0])
        : parseSemanticAction(finalOutput);
    } catch (error) {
      if (verbose) flushDeferredAgentOutput();
      if (memoryMode === 'managed') await this.stopWorker();
      throw markFailure(
        new Error(`The agent returned a malformed application action: ${error.message}`),
        {
          phase: 'semantic-action-validation',
          sideEffects: 'none from semantic application hooks',
        },
      );
    }
    if (!finalOutput && !semanticProposal) {
      if (verbose) flushDeferredAgentOutput();
      if (memoryMode === 'managed') await this.stopWorker();
      const refreshedBrowserState = await this.getBrowserContext();
      const recoveryContext = {
        ...extensionContext,
        browserState: refreshedBrowserState,
        failure: {
          type: 'empty-agent-final',
          agent: this.selected,
          stderr: stripAnsi(result.stderr || '').trim(),
          initialBrowserState: liveBrowserState,
        },
      };
      for (const extension of activeExtensions) {
        if (typeof extension.recoverTurn !== 'function') continue;
        const recovered = await extension.recoverTurn(recoveryContext);
        if (recovered) {
          return finishExtensionTurn(extension, recovered, `${extension.id} recovery`);
        }
      }
      const detail = stripAnsi(result.stderr || '').trim();
      throw markFailure(
        new Error(
          `${descriptor.label} completed without a final response` +
          `${detail ? `: ${detail.slice(-800)}` : '. No browser change was confirmed.'}` +
          `${verbose ? '' : ' Enable /verbose on for agent diagnostics.'}`,
        ),
        {
          phase: 'agent-final-verification',
          sideEffects: Array.isArray(result.toolActivity) && result.toolActivity.length
            ? 'uncertain; agent tool activity occurred without a final explanation'
            : 'none observed; no agent tool call started',
          toolActivity: (result.toolActivity || []).map((entry) => entry.toolName || 'unknown tool'),
        },
      );
    }
    if (semanticProposal) {
      if (!announcedSemanticProposals.size) announceSemanticProposal(semanticProposal);
      let semanticPlan;
      try {
        semanticPlan = await prepareSemanticAction(
          semanticExtensions,
          semanticProposal,
          extensionContext,
        );
      } catch (error) {
        if (verbose) flushDeferredAgentOutput();
        if (memoryMode === 'managed') await this.stopWorker();
        throw markFailure(
          new Error(`The agent proposed an invalid application action: ${error.message}`),
          {
            phase: 'semantic-action-validation',
            sideEffects: 'none from semantic application hooks',
          },
        );
      }
      if (verbose) {
        onOutput(
          `[semantic:action] capability=${semanticPlan.descriptor.id}` +
          `${semanticPlan.payload.target ? ` target=${semanticPlan.payload.target}` : ''}` +
          `${semanticPlan.payload.operation ? ` operation=${semanticPlan.payload.operation}` : ''}\n`,
        );
      }
      if (memoryMode === 'managed') await this.stopWorker();
      let semanticResult;
      try {
        semanticResult = await extensionContext.invokeBrowserHook(
          semanticPlan.descriptor.hook,
          semanticPlan.payload,
        );
      } catch (error) {
        throw markFailure(error, {
          phase: 'application-action',
          sideEffects: 'uncertain; the application hook started, so inspect verified state and action/checkpoint evidence before any retry',
          action: {
            extensionId: semanticPlan.extension.id,
            capability: semanticPlan.descriptor.id,
            hook: semanticPlan.descriptor.hook,
            target: semanticPlan.payload.target || null,
            operation: semanticPlan.payload.operation || null,
          },
        });
      }
      if (semanticPlan.descriptor.continueAfterHook) {
        const activationOutput = semanticResult?.output || semanticResult?.summary;
        if (String(activationOutput || '').trim()) {
          onOutput(`${String(activationOutput).trim()}\n`);
        }
        const continuationPrompt = typeof semanticPlan.descriptor.continuationPrompt === 'function'
          ? await semanticPlan.descriptor.continuationPrompt(
            semanticResult,
            semanticPlan,
            extensionContext,
          )
          : semanticPlan.descriptor.continuationPrompt ||
            'Continue the active workflow now. Inspect the live browser, update the tracker from observed state, act safely, verify each change, and stop with a clear explanation if human input is required.';
        const continuation = await this.run(continuationPrompt, onOutput, {
          memoryMode,
          record: false,
          skipCapabilities: true,
          skipTurnHandlers: true,
          requireWorkflowUpdate: true,
          verbose,
          onActivity,
        });
        if (memoryMode === 'managed') {
          await this.stopWorker();
          if (options.record !== false) {
            await this.conversationStore.appendTurn({
              agent: this.selected,
              user: userPrompt,
              assistant: stripAnsi(continuation).trim(),
              usage: null,
            });
          }
        }
        return continuation;
      }
      const semanticOutput = semanticPlan.descriptor.formatResult
        ? await semanticPlan.descriptor.formatResult(
          semanticResult,
          semanticPlan,
          extensionContext,
        )
        : semanticResult?.output || semanticResult?.summary;
      return finishExtensionTurn(
        semanticPlan.extension,
        {output: semanticOutput},
        semanticPlan.descriptor.label,
      );
    }
    flushDeferredAgentOutput();
    for (const extension of activeExtensions) {
      try {
        await extension.afterTurn?.({ ...extensionContext, output: result.output });
      } catch (error) {
        throw markFailure(error, {
          phase: 'application-after-turn',
          sideEffects: 'the requested effect and user-visible output may already be complete; inspect before any retry',
          action: {extensionId: extension.id},
        });
      }
    }
    if (memoryMode === 'managed') {
      this.workerHydratedConversationId = conversationId;
      if (options.record !== false) {
        await this.conversationStore.appendTurn({
          agent: this.selected,
          user: userPrompt,
          assistant: finalOutput,
          usage: result.usage || null,
        });
      }
    }
    return result.output;
  }

  async compact(instructions = '', onOutput = (chunk) => process.stdout.write(chunk)) {
    if (this.memoryMode !== 'managed') {
      throw new Error('Compact checkpoints require managed memory mode.');
    }
    const status = await this.conversationStatus();
    if (!status.active || status.turnCount < 1) {
      throw new Error('The active conversation has no completed turns to compact.');
    }
    const prompt = `Create a durable handoff checkpoint for this conversation.

Do not use tools and do not change files or the browser. Summarize the user's goal, decisions, completed work, current state, constraints, unresolved issues, and exact next actions. Preserve concrete paths, commands, identifiers, and important values. Return only the checkpoint summary.
${instructions ? `\nAdditional compaction instructions:\n${instructions}\n` : ''}`;
    const summary = (
      await this.run(prompt, onOutput, { memoryMode: 'managed', record: false })
    ).trim();
    if (!summary) throw new Error('The agent returned an empty compact checkpoint.');
    const checkpoint = await this.conversationStore.appendCheckpoint({
      agent: this.selected,
      summary,
      instructions: instructions || null,
    });
    await this.stopWorker();
    return checkpoint;
  }

  invocation(agent, prompt, verbose = false, structuredSemantic = false) {
    if (agent === 'pi') {
      const structured = verbose || structuredSemantic;
      const args = [
        '--mode',
        structured ? 'json' : 'text',
        '--print',
        '--no-session',
        ...piIsolationArgs(),
        prompt,
      ];
      return {
        args,
        displayArgs: [
          '--mode',
          structured ? 'json' : 'text',
          '--print',
          '--no-session',
          ...piIsolationArgs(),
          '<prompt-with-live-browser-context>',
        ],
        stdin: null,
        mode: structured ? 'pi-jsonl' : 'plain',
      };
    }

    if (agent === 'codex') {
      return {
        args: [
          'exec',
          '--json',
          '--ephemeral',
          '--skip-git-repo-check',
          '--color',
          'never',
          '-C',
          this.workspaceRoot,
          '-',
        ],
        displayArgs: [
          'exec',
          '--json',
          '--ephemeral',
          '--skip-git-repo-check',
          '--color',
          'never',
          '-C',
          this.workspaceRoot,
          '-',
        ],
        stdin: prompt,
        mode: 'codex-jsonl',
      };
    }

    const args = ['-p', '--no-session-persistence', '--no-chrome'];
    if (verbose) args.push('--verbose', '--output-format', 'stream-json');
    args.push(prompt);
    return {
      args,
      displayArgs: [
        '-p',
        '--no-session-persistence',
        '--no-chrome',
        ...(verbose ? ['--verbose', '--output-format', 'stream-json'] : []),
        '<prompt-with-live-browser-context>',
      ],
      stdin: null,
      mode: verbose ? 'claude-jsonl' : 'plain',
    };
  }

  async spawnAndStream(command, args, stdin, mode, onOutput, verbose = false, options = {}) {
    this.cancelled = false;
    const child = spawn(command, args, {
      cwd: this.workspaceRoot,
      env: this.environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.activeChild = child;

    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();

    let output = '';
    let stderr = '';
    let lineBuffer = '';

    let streamedAssistantText = '';
    let assistantLineOpen = false;
    let lastRenderedFinal = '';
    const semanticToolCalls = new Map();
    const semanticProposals = [];
    const workflowUpdates = [];
    const toolActivity = [];

    const emitRenderedEvent = (event) => {
      if (!verbose) return;
      const rendered = renderAgentEvent(this.selected, event);
      if (!rendered?.text) return;
      if (rendered.stream) {
        onOutput(rendered.text);
        streamedAssistantText += rendered.text;
        assistantLineOpen = true;
        return;
      }
      if (assistantLineOpen) {
        onOutput('\n');
        assistantLineOpen = false;
      }
      onOutput(rendered.text);
    };

    const processStructuredLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        if (verbose) onOutput(`[${this.selected}] ${truncate(line, 320)}\n`);
        else onOutput(`${line}\n`);
        return;
      }
      emitRenderedEvent(event);

      if (event.type === 'tool_execution_start' &&
          event.toolName === 'browserctl_propose_action') {
        semanticToolCalls.set(event.toolCallId, event.args);
        options.onSemanticProposal?.(event.args);
      }
      if (event.type === 'tool_execution_start') {
        toolActivity.push({toolName: event.toolName, args: event.args});
      }
      if (event.type === 'tool_execution_end' &&
          event.toolName === 'browserctl_propose_action') {
        const proposal = semanticToolCalls.get(event.toolCallId) || event.args;
        semanticToolCalls.delete(event.toolCallId);
        if (!event.isError && proposal) semanticProposals.push(proposal);
      }
      if (event.type === 'tool_execution_end' &&
          event.toolName === WORKFLOW_UPDATE_TOOL && !event.isError) {
        const update = event.args || event.result?.details?.workflowUpdate;
        if (update) workflowUpdates.push(update);
      }

      const finalText = assistantText(event, mode);

      if (finalText) {
        output = `${finalText}\n`;
        if (!verbose) onOutput(`${finalText}\n`);
        else if (finalText !== lastRenderedFinal) {
          if (assistantLineOpen) {
            if (streamedAssistantText !== finalText) onOutput('\n');
            assistantLineOpen = false;
          }
          if (streamedAssistantText !== finalText) onOutput(`${finalText}\n`);
          lastRenderedFinal = finalText;
          streamedAssistantText = '';
        }
      } else if (event.type === 'error') {
        const message = event.message || event.error?.message || JSON.stringify(event);
        stderr += `${message}\n`;
        if (!verbose) onOutput(`\u001b[31m${message}\u001b[0m\n`);
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (mode.endsWith('-jsonl')) {
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() || '';
        for (const line of lines) processStructuredLine(line);
      } else {
        output += text;
        onOutput(text);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (verbose) onOutput(`[${this.selected}:stderr] ${text}`);
    });

    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      this.activeChild = null;
    });

    if (mode.endsWith('-jsonl') && lineBuffer) processStructuredLine(lineBuffer);
    return {
      ...result,
      output,
      stderr,
      cancelled: this.cancelled,
      semanticProposals,
      workflowUpdates,
      toolActivity,
    };
  }

  cancel() {
    if (this.worker?.cancel()) {
      this.cancelled = true;
      return true;
    }
    if (!this.activeChild || this.activeChild.exitCode !== null) return false;
    this.cancelled = true;
    this.activeChild.kill('SIGINT');
    const child = this.activeChild;
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    }, 2000).unref();
    return true;
  }

  async stopWorker() {
    if (this.worker) this.worker.stop();
    this.worker = null;
    this.workerHydratedConversationId = null;
  }

  async stop() {
    await this.stopWorker();
    if (this.activeChild && this.activeChild.exitCode === null) {
      this.activeChild.kill('SIGTERM');
    }
  }

  async status() {
    return {
      selectedAgent: this.selected,
      verbose: this.verbose,
      memoryMode: this.memoryMode,
      nativeAgentPersistence: false,
      worker: this.worker?.status() || {
        agent: this.selected,
        running: false,
        protocol: null,
      },
      fallback: this.workerFallback,
      extensions: this.extensions.map((extension) => extension.id),
      conversation: await this.conversationStatus(),
    };
  }
}

module.exports = {
  AGENTS,
  AgentRunner,
  browserContextPrompt,
  formatTurnPrompt,
  parsePiModelPreference,
};
