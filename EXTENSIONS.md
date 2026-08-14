# Browserctl Extension Modules

This is the implementation contract for adding task-specific behavior to the
application-neutral browserctl host.

## 30-second checklist

1. Put the module under the mutable run directory, not inside `browserctl/`.
2. Export `createExtension()`.
3. Return a stable `id` and only the callbacks you need.
4. Declare `semanticCapabilities` with meanings, effects, state, and typed inputs;
   let the selected agent decide intent from context.
5. For a multi-step adaptive series, declare a `workflows` template and pair its
   activation capability with `continueAfterHook`.
6. Persist the module entry in the session's `session.json`.
7. Pass the same loaded extension array to `BrowserManager` and `AgentRunner`.
8. Store restart-required settings in the manifest entry or session artifacts.
9. Test natural intent, browser mutation, workflow adaptation, verification,
   rollback, and reopen.

Keep private/application-specific implementations under ignored `local/plugins/`
or in their own repositories. This guide uses only the neutral `myapp` example.
For a complete runnable version, see
[`examples/page-label/`](examples/page-label/README.md).

## Copyable minimal module

Create `myapp/lib/myapp-extension.js` under the run directory:

```js
'use strict';

const ID = 'myapp';
const SET_LABEL_HOOK = 'myapp.set-label';

async function createExtension({ entry, session, config, workingDirectory }) {
  // config is supplied by an application launcher such as autorun.
  // It is null when generic browserctl later reopens the saved session.
  const storageKey = entry?.options?.storageKey || 'myapp.pageLabel';

  return {
    id: ID,

    agentInstructions(turn) {
      const state = turn.browserState?.extensionContext?.[ID];
      return `Architecture: the managed page is live; its durable label is stored in localStorage.
Current label: ${state?.label || '(none)'}.
Interpret the requested outcome from meaning and context, not exact words.`;
    },

    semanticCapabilities: [{
      id: 'myapp.set-page-label',
      label: 'Set the durable page label',
      description: 'Give the current managed application page a durable human-readable label.',
      effect: 'Updates localStorage in the live page and saves browser state.',
      hook: SET_LABEL_HOOK,
      statePath: 'browserState.extensionContext.myapp',
      inputHint: '{"label":"nonempty human-readable text"}',
      preparePayload(payload) {
        const label = String(payload.label || '').trim();
        if (!label) throw new Error('label is required.');
        return {label};
      },
      formatResult(result) {
        return `Saved the page label as “${result.label}”.`;
      },
    }],

    workflows: [{
      id: 'myapp.review-workflow',
      title: 'Review the current document',
      objective: 'Inspect, prepare, and verify the document without publishing it.',
      steps: [{
        id: 'inspect',
        title: 'Inspect current state',
        instructions: 'Inspect the live page and record which branch applies.',
        completion: 'Current state is verified with a concise evidence note.',
      }],
    }],

    browserHooks: [
      {
        name: SET_LABEL_HOOK,
        description: 'Save a human-readable label for the current application page.',
        inputHint: '{"label":"short text"}',
        async handler({ browserManager, page, payload }) {
          if (!page || page.isClosed()) throw new Error('The managed page is unavailable.');
          const label = String(payload.label || '').trim();
          if (!label) throw new Error('label is required.');
          await page.evaluate(
            ({ key, value }) => localStorage.setItem(key, value),
            { key: storageKey, value: label },
          );
          await browserManager.saveState('myapp-label');
          return { label };
        },
      },
    ],

    browserLifecycle: {
      async context({ page }) {
        if (!page || page.isClosed()) return { available: false, label: null };
        const label = await page.evaluate(
          (key) => localStorage.getItem(key),
          storageKey,
        ).catch(() => null);
        return { available: true, label };
      },
    },
  };
}

module.exports = { createExtension };
```

The factory may also be the module's direct export or `default` export, but the
named CommonJS `createExtension` export above is the recommended format.

## Register the module

The preferred owner is the application launcher. Persist the entry before launch:

```js
const {
  loadExtensions,
  upsertExtensionEntry,
} = require('./browserctl/lib/extension-loader');
const { WorkflowStore } = require('./browserctl/lib/workflow-store');

const entry = {
  id: 'myapp',
  module: 'myapp/lib/myapp-extension.js',
  options: {
    storageKey: 'myapp.pageLabel',
  },
};

const entries = upsertExtensionEntry(session.manifest.extensions, entry);
await store.update(session, { extensions: entries });

const extensions = await loadExtensions(entries, {
  workingDirectory: RUN_DIRECTORY,
  session,
  config: applicationConfig,
});
const workflowStore = await new WorkflowStore(session, extensions).initialize();
```

Pass that same `extensions` array to both owners:

```js
const browser = new BrowserManager(session, {
  workingDirectory: RUN_DIRECTORY,
  extensions,
  workflowStore,
});

const runner = new AgentRunner(session, store, {
  workspaceRoot: RUN_DIRECTORY,
  extensions,
  browserContextProvider: () => browser.agentContext(),
  browserHookInvoker: (name, payload, runtime) =>
    browser.invokeBrowserHook(name, payload, runtime),
});
```

Pass `workflowStore` to `TerminalChat` too when the launcher uses the interactive
console. The generic browser panel is attached by `BrowserManager`.

The resulting manifest shape is:

```json
{
  "extensions": [
    {
      "id": "myapp",
      "module": "myapp/lib/myapp-extension.js",
      "options": {
        "storageKey": "myapp.pageLabel"
      }
    }
  ]
}
```

`module` is resolved relative to the run directory and must remain inside it.
Duplicate loaded extension IDs and duplicate browser-hook names are rejected.
Keep the manifest `id` equal to the extension object's returned `id`.

Do not edit a session manifest while that session service is running. Let the
application launcher update it through `SessionStore`.

## Factory contract

Browserctl calls:

```js
await createExtension({ entry, session, config, workingDirectory });
```

| Field | Meaning |
| --- | --- |
| `entry` | The manifest string/object used to load this module, including persisted `options`. |
| `session` | The active session object, manifest, directory, and standard paths. |
| `config` | Application launcher configuration, or `null` on generic browserctl reopen. |
| `workingDirectory` | Absolute mutable run-directory path used to resolve modules and agent work. |

Factory/import/validation errors are startup errors. The service does not silently
skip an invalid extension.

Anything needed after restart must not live only in a closure derived from
`config`. Persist it in `entry.options` or under the session directory. On a later
`browserctl --open`, the module receives the persisted `entry`, `session`, and
`workingDirectory`, but `config` is normally `null`.

## Returned extension object

Only `id` is required. Every other field is optional.

```js
{
  id,
  agentInstructions,
  semanticCapabilities,
  workflows,
  quickActions,
  beforeTurn,
  canHandleTurn,
  handleTurn,
  recoverTurn,
  afterTurn,
  browserHooks,
  browserLifecycle,
}
```

## Quick actions

`quickActions` feeds a small collapsed “✦ Quick actions” bar rendered at the
bottom-left of every page in the managed browser (the workflow plan panel keeps
the bottom-right). It exists for one purpose: reminding a returning human of the
few main actions that are integral to the whole task but easy to forget between
sessions. It is a memory aid, not a command reference — the agent console remains
the primary interface, and every hint doubles as an example of what the human can
simply type there.

```js
quickActions: [
  {
    id: 'publish',                       // stable, unique within the module
    label: 'Publish the draft',          // short button text (≤48 chars)
    hint: 'Prepares and verifies; nothing is released.',   // one line (≤140 chars)
    prompt: 'Prepare the current draft for publication and verify it without releasing.',
  },
],
```

Clicking an entry queues its `prompt` to the live console agent over the same
authenticated binding the workflow panel uses; the console picks it up as the
next turn, prefixed with which action the human clicked. A prompt that needs
specifics should instruct the agent to ask for them (“Ask me for the image
URLs, then…”) rather than embed placeholders.

Design contract — hold this line in future work:

- Register only actions the human may not remember but needs for the end-to-end
  task. Anything discoverable in the moment, or rarely needed, stays out.
- One-line hints in plain language; no jargon, no nested menus, at most
  8 actions total across all loaded modules (enforced).
- Ids are namespaced as `<extensionId>:<id>`; duplicates and oversized text fail
  loudly at console start, never silently.
- The bar renders nothing when no module registers actions.

## Dispatch order

Every turn follows one application-neutral sequence:

1. capture fresh browser and extension state;
2. run `beforeTurn`, collect module instructions, and build the semantic capability
   catalog with current state;
3. optionally try an explicitly authored `handleTurn` callback;
4. invoke the selected agent with the generated catalog;
5. capture Pi's browserctl proposal-tool event independently of final text (or
   parse another agent's exact `browserctlAction` final), show the interpreted
   route, validate at most one proposal, and execute its hook;
6. for `continueAfterHook`, refresh context and continue through ordinary browser
   tools with semantic re-activation disabled; and
7. if the agent returns neither a proposal nor a final, let `recoverTurn` verify refreshed state before
   surfacing the empty-final error.

Browserctl never scans the human prompt for operation words or target aliases.
The selected agent decides the boundary from meaning, architecture, effects,
conversation, and live state. Browserctl only validates a proposed capability and
dispatches its declared hook.

## Semantic capabilities

Use these for application outcomes with a safe typed execution path. A capability
describes what it means and what it changes; it does not enumerate phrases.

```js
semanticCapabilities: [
  {
    id: 'myapp.document-mutation',
    label: 'My app document edit',
    description: 'Change promotional creative displayed in the current document.',
    effect: 'Mutates, rebuilds, verifies, and saves the live document.',
    hook: 'myapp.mutate-document',
    statePath: 'browserState.extensionContext.myapp.sections',
    targets: [
      {
        id: 'promotions',
        label: 'Live promotional creative',
        description: 'Creative visible now, not material reserved for a future document.',
        accepts: ['image-url'],
        operations: ['add', 'replace', 'upsert'],
        bind: {
          'image-url': { imageUrl: '$url' },
        },
        capacity: 2,
        whenFull: 'replace-last',
      },
    ],
    formatResult(result) {
      return result.output;
    },
  },
],
```

The agent sees that schema plus the current state at `statePath`. Whenever Pi
decides that a capability expresses the next needed outcome, it calls the
host-provided `browserctl_propose_action` tool with the fields below plus short
`interpretation` and `rationale` strings. The tool sends the proposal to
browserctl over the authenticated loopback bridge; browserctl validates it,
runs the registered hook, and the verified result (or the exact error) returns
as the tool result, so the agent can keep working — several actions in one
turn, or a corrected attempt after an error — until the request is fully
addressed. Module authors do not register or execute the tool. Consecutive
identical proposals are refused as loops, and a generous per-request action
backstop stops runaways loudly.

Other supported agents return the equivalent JSON envelope as their final
response; browserctl executes it and hands the verified result back in a
continuation turn, chaining until the agent stops proposing actions. A
completed request is then audited once against what verifiably ran, and any
unaddressed remainder is reported and given one follow-up turn.

The Pi tool call envelope:

```json
{
  "browserctlAction": {
    "capability": "myapp.document-mutation",
    "target": "promotions",
    "operation": "upsert",
    "resources": [
      {"type": "image-url", "url": "https://example.test/summer.jpg"}
    ]
  }
}
```

Browserctl validates the capability, target, allowed operation, resource count,
HTTP(S) URL, inferred URL type, binding, position, and current capacity. The hook
then receives:

```json
{
  "actionVersion": 1,
  "action": "myapp.document-mutation",
  "target": "promotions",
  "operation": "add",
  "requestedOperation": "upsert",
  "values": {
    "imageUrl": "https://example.test/summer.jpg"
  }
}
```

`operation` is resolved against current capacity. `requestedOperation` preserves
the agent's semantic interpretation, so a hook can explain that an upsert became a
last-item replacement because the section was full. A positive numeric `position`
or `"last"` resolves to replacement.

Current generic resource types are `url` and `image-url`; image type comes from a
normal image filename extension. A target must explicitly accept and bind a type.
Use `operations` to limit what the hook can safely execute. Set `resourceMode:
"many"` for one-or-more resources; `list` and `remove` are resource-free. A normal
agent final falls through untouched. A malformed, unknown, or unsupported proposal
fails visibly before the hook runs.

For capabilities whose input is not target-plus-URL, omit `targets`, provide a
short JSON `inputHint`, and implement `preparePayload(payload, turnContext)`. It
must validate and return the exact object sent to the hook. This is appropriate for
structured references to a live card or a read-only history query. Keep language
interpretation in the agent; `preparePayload` validates data and current state, not
phrases. Pi encodes this typed object in the proposal tool's `payloadJson` string;
browserctl parses it before calling `preparePayload`.

The target's hook remains responsible for payload validation, fresh inspection,
authorization, mutation, rebuild, verification, checkpoint, and rollback. Its
`formatResult` must produce a nonempty human-readable final; an empty result fails
the turn. The raw proposal is withheld from normal console output; the human sees
the agent's interpretation, the capability/target labels declared by the module,
and the verified hook result.

## Resumable workflows

Use `workflows` for a coherent series whose route must adapt after inspecting the
real application. Do not encode selectors or phrase matching in browserctl, and do
not treat steps as a blind macro.

```js
const WORKFLOW_ID = 'myapp.prepare-draft';

workflows: [{
  id: WORKFLOW_ID,
  title: 'Prepare the current draft',
  objective: 'Prepare and verify the draft without publishing it.',
  steps: [
    {
      id: 'inspect',
      title: 'Inspect current state',
      instructions: 'Read the live page and decide which safe branch applies.',
      completion: 'Observed state and selected branch are recorded with evidence.',
    },
    {
      id: 'prepare',
      title: 'Prepare the draft',
      dependsOn: ['inspect'],
      instructions: 'Change only values authorized by the application procedure.',
      completion: 'The visible draft is prepared and verified.',
    },
  ],
}],

semanticCapabilities: [{
  id: 'myapp.start-preparation',
  label: 'Prepare through the tracked workflow',
  description: 'Start or resume the complete draft-preparation series.',
  effect: 'Persists a plan and then continues with general live-browser work.',
  hook: 'myapp.activate-preparation',
  inputHint: '{}',
  continueAfterHook: true,
  continuationPrompt: 'Continue the active workflow from live browser state.',
}],
```

The activation hook receives `details.workflow`, a generic `WorkflowStore`:

```js
async handler({ workflow, payload }) {
  const plan = await workflow.activate(WORKFLOW_ID, {
    activationReason: payload.intent,
    metadata: { sourcePath: '/session/generated-output.html' },
  });
  await workflow.update({
    workflowId: plan.id,
    stepId: 'inspect',
    status: 'in_progress',
    note: 'Opened the retained application tab; live inspection is next.',
  });
  return { output: 'Started the saved preparation plan.' };
}
```

Allowed step statuses are `pending`, `in_progress`, `waiting`, `completed`,
`skipped`, and `failed`. Completed steps require a verification note. Waiting
steps require a concise reason or human action. Use skipped when observed state
makes a conditional branch unnecessary. The store derives workflow `active`,
`waiting`, or `completed` state and writes atomically to
`session.paths.saves/workflow-state.json`.

The active plan is included in every fresh agent turn. Agents update it through the
internal application-neutral workflow bridge after observations and verification.
Pi receives `browserctl_update_workflow`; browserctl captures its structured event,
validates the exact step/status/note, persists it, and only then releases deferred
final text. A required continuation that produces prose without changing the plan
fails visibly. Other agents use the same validated local workflow bridge.
The browser panel lets the human click **Retry** or **Prompt agent**; the latter
collects a natural correction. `/plan` offers the same choices in the terminal.
Queued actions survive reopen. Application modules should put policy, values, and
branch meanings in step instructions; browserctl owns only generic state/UI.

Do not store credentials, secret tokens, full reasoning, or large document content
in workflow metadata. Store large content in a session file and put only its path,
provenance, and size in metadata.

### Turn context

`agentInstructions`, `beforeTurn`, `canHandleTurn`, and `handleTurn` receive:

```js
{
  runner,            // AgentRunner; avoid changing it unless necessary
  session,           // active service session
  browserState,      // fresh authoritative browser/extension context
  userPrompt,        // exact human request for this turn
  memoryMode,        // "managed" or "ephemeral"
  invokeBrowserHook, // async (name, payloadObject) => serializable result
}
```

Extension lifecycle context returned by this module is available at:

```js
turn.browserState.extensionContext[extensionId]
```

### `agentInstructions`

A string or async function returning a string. It is inserted under a heading for
the extension before the current user request. Keep it concise and operational:

- explain application semantics the model cannot infer from the DOM;
- describe the application's layers, concepts, ownership, effects, and safe procedures;
- include current structured state instead of large repeated source dumps; and
- tell the model what must be verified before reporting success.

Do not include secrets. The text is sent to the selected agent.

### `beforeTurn(context)`

Runs before instructions and before deterministic/model dispatch. Use it for
small validation or preparation. The browser snapshot has already been captured,
so do not silently perform user-visible mutations here.

An exception fails the turn.

### `canHandleTurn(context)`

Returns `null`/`false` or a short activity label such as `"Document extension"`.
This controls the terminal's “is working” label; it does not prevent
`handleTurn()` from being called.

Return a truthy value only when `handleTurn()` will definitely handle the same
request. Otherwise the console could claim the extension is working before the
request falls through to a model.

### `handleTurn(context)`

This is a low-level escape hatch for an exact protocol or non-linguistic condition.
Do not use it to build keyword/regex routing for ordinary human requests; declare a
semantic capability and let the selected agent interpret language instead.

- Return `null`/`undefined` to continue to the selected model.
- Return a nonempty string or `{ output: "nonempty final" }` to complete the turn.
- Call `context.invokeBrowserHook(name, payload)` for browser mutations.
- Throw a clear error when the operation or verification fails.

In managed mode, a successful deterministic final is saved as
`extension:<extension-id>` conversation history. Empty handled output is an error.

Extensions are checked in manifest order. The first non-null handled result wins.

### `recoverTurn(context)`

Runs only after the selected model exits successfully without a final response.
It receives a fresh `browserState` and:

```js
{
  failure: {
    type: 'empty-agent-final',
    agent: 'pi',
    stderr: '',
    initialBrowserState: {}, // authoritative snapshot captured before model dispatch
  },
}
```

Return the same nonempty shape as `handleTurn` only when refreshed state or a
durable action ledger independently proves what changed. Return `null` to keep the
normal visible error. Never blindly repeat the request here: the silent model may
already have mutated the page.

### `afterTurn(context)`

Runs after any successful deterministic or model final. It receives the normal
turn context plus:

```js
{
  output,                         // successful final text
  handledByExtension: 'id'       // present only for deterministic extension handling
}
```

Every active extension's `afterTurn` runs, not only the extension that handled
the request. It does not run after a failed/empty turn. Keep it idempotent.

## Browser hooks

Each hook has this shape:

```js
{
  name: 'myapp.operation',
  description: 'One clear sentence shown in agent context.',
  inputHint: '{"field":"value"}',
  async handler(details) {
    return { ok: true }; // Must be JSON-serializable.
  },
}
```

Hook names are global within a session. Prefix them with the extension ID.
`description` and `inputHint` are optional but strongly recommended because the
agent sees them in fresh browser context.

The handler receives:

```js
{
  browserManager,    // service owner; save state through this object
  page,              // managed Playwright Page, possibly unavailable/closed
  context,           // existing service-owned BrowserContext
  playwrightBrowser, // existing service-owned Browser
  session,
  paths,             // standard absolute session paths
  payload,           // validated JSON object from the caller
  agentDecision,     // async bounded decision callback, or null outside an agent turn
  workflow,          // generic WorkflowStore for declared plans, or null
}
```

Hook results must be JSON-serializable because the authenticated bridge validates
them with `JSON.stringify`. Hook errors are logged and propagated to the caller.

When a hook invoked from a normal agent turn throws, browserctl marks its side
effects uncertain and starts the generic bounded recovery loop. The same selected
agent receives the original request, hook/capability identity, error, and fresh
application/browser/workflow context. Browserctl does **not** invoke the hook again.
The agent must inspect authoritative state and module-owned checkpoint/action
evidence before deliberately choosing a repair or retry. A hook therefore still
needs transactional validation and rollback; generic recovery is not a substitute
for idempotency or exact verification.

An exception from `handleTurn` follows the same recovery path, but the failed
deterministic handler is skipped on recovery so it cannot replay before agent
inspection. `beforeTurn`/instruction failures are surfaced as application-context
failures; on recovery the agent receives a notice and generic live browser context
if that extension context still cannot be rebuilt. Modules do not need custom
phrase/error handlers for this behavior.

### Bounded decisions after inspection

Some safe application decisions cannot honestly be made in the initial semantic
proposal because deterministic inspection must happen first. For example, a hook
may need to extract an article before asking which configured category best fits.
When the hook was invoked from an agent turn, `agentDecision(prompt, options)` runs
one fresh, non-recorded, extension-disabled decision using the same selected agent:

```js
const answer = await agentDecision(classificationPrompt, {
  label: 'the extracted article evidence against configured categories',
});
```

Use this only for bounded judgment over evidence already gathered by the hook.
Supply the complete allowed choices and request a strict machine-validated answer.
Do not mutate before the decision, do not let the decision invoke another bounded
decision, and do not treat its output as trusted until the application validates
it. If the callback is `null`, fail safely or require an already validated caller
value. Direct authenticated bridge hook calls do not receive an agent callback.
Browserctl owns the generic execution channel but knows nothing about the
application's evidence, categories, or decision schema.

Bounded decisions intentionally do not start another general recovery loop. The
owning hook may validate/retry a non-mutating decision within its declared policy,
or fail before mutation; the outer normal turn then receives that hook failure and
may recover once full live context is available.

For manual diagnostics, not normal human workflow:

```bash
./browserctl.js invoke myapp.set-label '{"label":"reviewed"}'
```

Humans should normally speak naturally; the selected agent maps intent to semantic
capabilities or ordinary browser work.

## Browser lifecycle handlers

`browserLifecycle` may contain only these functions:

| Handler | When it runs | Extra fields |
| --- | --- | --- |
| `pageReady` | After start, recovery launch, managed-page open, and reload | `reason`: `start`, `launch`, `open`, or `reload` |
| `context` | While building fresh agent/browser state | `reason`, commonly `agent-context` |
| `beforeSave` | After browser storage state is written for an explicit save | `label`, `storageStatePath` |
| `beforeStop` | Before final storage save and browser shutdown | `reason: "shutdown"` |

Every lifecycle handler receives the hook's service-owned browser objects plus
`targetUrl` and the generic `workflow` store:

```js
{
  browserManager,
  page,
  context,
  playwrightBrowser,
  session,
  paths,
  targetUrl,
  workflow,
  // event-specific fields above
}
```

Return a small JSON-serializable object. Results are namespaced by extension ID.
In particular, `context()` becomes agent-visible structured state at
`browserState.extensionContext[id]`.

Lifecycle errors are logged as `browser-extension-lifecycle-error` and the host
continues. Do not rely on lifecycle exceptions to abort launch. A user-requested
critical operation belongs in a browser hook, where errors propagate visibly.

Keep lifecycle handlers idempotent: start/reload/context/save may run repeatedly.

## Persistence and reopen

There are three separate persistence layers:

1. **Manifest entry:** module identity and small settings needed to reload it.
2. **Extension artifacts:** application state under `session.paths.saves` or a
   documented application folder.
3. **Managed conversation:** successful user/final continuity owned by
   `ConversationStore`, not by the extension.

Recommended rules:

- Put small stable settings in `entry.options`.
- Put mutable/recoverable state under the session directory.
- Use atomic writes for state files.
- Keep a `README.md` in every application-created folder.
- Return a concise summary of saved state from lifecycle `context()`.
- Treat closure state as a cache only; reconstruct it after reopen.
- Version and validate persisted formats before restoring them.

A robust extension typically combines a versioned document checkpoint, profile
autosave, a restart-safe last-action ledger, and manifest-persisted settings.

## Safety requirements

- Never launch Chrome or call `connectOverCDP`; use the provided objects.
- Never close the service-owned browser, context, or managed page.
- Validate every payload and URL before mutation.
- Inspect live state immediately before editing.
- Preserve unrelated page/application state.
- For multi-step mutations, checkpoint first and roll back failures.
- Rebuild/verify the visible or rendered result before claiming success.
- Keep useful human-visible tabs; close only requested, stale, or excess tabs.
- Write only under the run/session paths placed in scope.
- Do not expose internal hook syntax as required human interaction.
- Do not put credentials, tokens, hidden reasoning, or raw tool streams into
  agent instructions, lifecycle context, or action ledgers.

## Verification checklist

At minimum, add tests for:

- module path confinement and extension validation;
- manifest upsert without deleting unrelated extensions;
- semantic catalog content, agent proposal parsing, and normal-final fall-through;
- proposal validation across targets, resource types/cardinality, live capacity,
  malformed/unknown capabilities, and requested-versus-resolved operation;
- paraphrases that share no target label words, proving no prompt keyword matcher
  decides the boundary;
- `canHandleTurn` matching `handleTurn` behavior;
- browser-hook payload validation and serializable results;
- mutation verification and rollback;
- lifecycle `context` shape and repeated/idempotent calls;
- persistence followed by generic `browserctl --open` reload; and
- application-neutral browserctl source boundaries.

Run:

```bash
npm run check
npm test
```

For a real application, also run one isolated browser integration using a copied
checkpoint or temporary session. Do not test destructive mutations against the
only user-owned state.

## Generic responsibility map

A well-factored application extension separates responsibilities like this:

| Requirement | Implementation |
| --- | --- |
| Persist registration/settings | The application launcher upserts one stable extension ID and small manifest options. |
| Provider guidance | `agentInstructions(context)` describes live capacity and safe policies. |
| General human intent | `semanticCapabilities` explains meanings/effects; the selected provider proposes typed work without keyword routing. |
| Proposal safety | Browserctl validates generic target/resource rules; `preparePayload` validates application references. |
| Safe browser operations | Named hooks inspect, checkpoint, mutate, verify, and roll back application state. |
| Structured fresh state | `browserLifecycle.context` includes architecture, procedures, live document state, and durable collections. |
| Exact page recovery | `pageReady`, `beforeSave`, and `beforeStop` own the checkpoint lifecycle. |
| Restart-safe follow-up | A versioned file under `session.paths.saves`. |
| General host isolation | No application command vocabulary or DOM logic inside browserctl core. |
