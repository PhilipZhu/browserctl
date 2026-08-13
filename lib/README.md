# Runtime Modules

The launcher’s production modules live here:

- `session-store.js` creates, discovers, migrates, and updates recoverable sessions.
- `browser-manager.js` owns Chrome and the Playwright CDP connection.
- `browser-bridge.js` lets coding agents execute operations in that existing service-owned Playwright client.
- `conversation-store.js` owns small prompt/final conversation records and compact checkpoints.
- `agent-runner.js` coordinates managed live workers or fresh ephemeral Pi, Codex, and Claude calls with classified activity, semantic-tool dispatch, safe tool-free model failover, bounded contextual failure recovery, waiting feedback, persisted finals, and empty-final rejection. Recovery gives the same agent the original request, a compact failure history, and fresh live context; it never blindly replays uncertain work.
- `agent-event-renderer.js` turns structured agent JSON events into concise terminal progress and tool output.
- `extension-loader.js` safely loads optional run-directory agent instructions, browser hooks, and application-owned browser lifecycle handlers.
- `semantic-action.js` renders module capability/state catalogs, parses an agent's
  typed proposal, and validates targets, URL types/cardinality, and live capacity.
- `workflow-store.js` validates extension-declared plans, atomically persists
  adaptive step state, renders the authenticated browser plan panel, and queues
  selected retry/correction actions.
- `pi-semantic-extension.ts` registers Pi's non-mutating application-proposal and
  workflow-progress tools; browserctl, not the tools, validates and applies them.
- `agent-workers.js` implements long-lived no-session RPC/JSON workers for managed
  mode and isolates Pi from ambient repository/user resources.
- `inline-runner.js` executes JSON-defined agent and browser command sequences.
- `terminal-ui.js` provides keyboard menus, chat commands, editable prompt drafts,
  and `/plan` retry/correction selection.
- `utils.js` contains small filesystem, formatting, and process helpers.

Application-specific behavior should be loaded through `extension-loader.js`, not
added to the general bridge command set. Extensions may provide agent instructions,
semantic capabilities, declarative workflows, turn hooks/activity classification and empty-final
recovery, named browser hooks, and `pageReady`/`beforeSave`/`context`/`beforeStop`
handlers while the browser service retains Chrome and Playwright ownership.

The complete factory/callback/context/registration/persistence contract and a
copyable module are documented in [`../EXTENSIONS.md`](../EXTENSIONS.md).
