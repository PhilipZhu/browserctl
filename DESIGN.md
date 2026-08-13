# Browser Control Design

`browserctl/` is a reusable browser-agent runtime. Its core contract is lifecycle
ownership and application neutrality.

## Invariants

- One `BrowserManager` owns Chrome, the persistent profile, Playwright CDP
  connection, managed page, downloads, bridge, and shutdown.
- Agents and extensions use that existing manager; they never start an independent
  browser or call `connectOverCDP`.
- The authenticated bridge listens on loopback and stores its owner-only token in
  the selected session.
- Session leases prevent concurrent profile mutation.
- Useful tabs remain visible and available for human collaboration.
- Native provider session persistence is disabled. Managed continuity is small,
  service-owned prompt/final replay only.
- The base prompt interprets natural language but contains no application-specific
  actions or assumptions.

## Package boundary

The package contains launchers, runtime modules, tests, npm metadata, and its
locked Playwright dependency. It does not contain mutable profiles or application
artifacts. Those resolve from the invocation directory under `weekly-logs/`.

`run.js` owns CLI/session selection. `browserctl.js` is only a client of an active
service. `lib/browser-manager.js` owns browser lifecycle. `lib/agent-runner.js`
owns fresh context and agent execution. `lib/extension-loader.js` is the only
application-extension boundary. `lib/workflow-store.js` owns application-neutral
workflow validation, persistence, plan rendering, and queued human retry/correction
actions.

## Extension contract

Extensions are declared in `session.json` and must resolve beneath the mutable run
directory. A loaded extension has a stable ID and may expose:

```js
{
  id,
  agentInstructions,
  semanticCapabilities,
  workflows,
  beforeTurn,
  afterTurn,
  handleTurn,
  browserHooks: [{ name, description, inputHint, handler }],
  browserLifecycle: {
    pageReady,
    beforeSave,
    context,
    beforeStop,
  },
}
```

The browser lifecycle receives the existing manager, page, context, browser,
session paths, and target URL. Errors are logged with extension identity and do not
inject domain handling into the core manager. `context` results are namespaced by
extension ID in the fresh agent context.

For ordinary human language, extensions declare semantic capabilities with
meanings, effects, typed inputs, and current-state paths. The selected agent decides
the boundary in one normal turn. Pi calls a browserctl-owned, non-mutating proposal
tool; other agents may return a `browserctlAction` envelope. Browserctl captures Pi
tool activity independently of final prose, shows its interpretation, validates at
most one proposal, and invokes its hook without scanning the prompt for keywords.
`handleTurn` remains only as a low-level protocol escape hatch. Named browser hooks
are generic execution capabilities; their semantics remain owned by the extension.

An extension may pair a semantic activation capability with a declarative workflow.
`continueAfterHook` tells the host to execute the activation hook, refresh live
context, and continue through ordinary agent browser work instead of treating
activation as the completed outcome. Workflow steps are evidence-bearing state,
not deterministic selectors. The generic host knows statuses and dependencies but
never learns the application's site, values, or branch meanings.

Workflow state is atomically stored under the selected session. A closed-shadow
browser panel renders the active plan; its per-process authenticated binding can
queue a selected step for retry or attach a human correction. The terminal consumes
that queued action as the next ordinary natural-language turn. A remote page cannot
directly update plan state or invoke agent work without the panel's private token.
Pi workflow progress is a typed non-mutating tool event captured independently of
assistant prose. The host validates/persists each update and withholds the final
until a required continuation has genuinely changed the plan revision.

## Recovery

The core recovers Chrome profiles, target tabs, cookies/local storage, downloads,
storage snapshots, and session metadata. Application-specific live page state is
not guessed by the core. An extension that understands the page can restore and
checkpoint it through lifecycle handlers.

If Chrome or the managed tab disappears while the console remains active,
`/launch` or `browserctl.js launch` reconnects/relaunches through the same manager
and reruns `pageReady` handlers.

Agent-turn failure recovery is also core-owned and application-neutral. The public
`AgentRunner.run()` wraps one-turn execution with at most two recovery turns by
default (hard maximum three). It reports each failed phase, preserves the original
human request, captures a bounded error envelope, and rebuilds live browser,
workflow, conversation, and extension context before asking the same selected
agent to diagnose the failure.

Recovery is agent-directed, not automatic command replay. A started application
hook, browser tool, failed workflow verification, or unknown side effect is marked
uncertain. The recovery prompt requires authoritative inspection and action-ledger,
checkpoint, or workflow evidence before mutation. The agent may verify an already
completed effect, repair and retry safely, or return a clear human dependency.
Failed deterministic `handleTurn` code is bypassed on the recovery turn so it
cannot rerun before the agent sees the error; semantic capabilities remain
available for a deliberate agent-selected repair.

Cancellation, unavailable agents, invalid runtime prerequisites, and bounded
post-inspection decisions do not recurse into recovery. Failed/internal prompts are
not conversation turns. If recovery succeeds in managed mode, the store records
the original human request and recovered final once.

## Verification

The deterministic suite covers session migration and leases, bridge authentication,
generic hook dispatch, extension path/contract validation, lifecycle neutrality,
fresh browser context, provider workers, readable events, inline execution,
conversation storage, and generic workflows. Application packages run their own
extension tests in their own repositories; browserctl's public suite is standalone.
