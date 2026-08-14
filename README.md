# Browserctl

Browserctl is an application-neutral, recoverable headed-Chrome session console.
It owns one persistent browser profile, exposes its existing Playwright objects
through an authenticated loopback bridge, supports conversational automation, and
loads project behavior through extensions rather than hard-coding websites into
the core.

Want a concrete starting point? Run the
[page-label example](examples/page-label/README.md), which uses Playwright to make,
verify, persist, and restore a visible page change.

## Install

You need:

- Node.js 20.6 or newer;
- Google Chrome or Chromium; and
- at least one supported provider CLI on `PATH`: `pi`, `codex`, or `claude`.

Clone the repository and install its locked JavaScript dependencies:

```bash
git clone https://github.com/PhilipZhu/browserctl.git
cd browserctl
npm ci
```

`npm ci` installs `playwright-core`. It does not download a browser or install a
provider CLI. Check the required programs before the first run:

```bash
node --version
command -v google-chrome || command -v chromium
command -v pi || command -v codex || command -v claude
```

If Chrome is installed somewhere unusual, pass `--chrome /path/to/chrome` or set
`CHROME_PATH`. Provider executable overrides are listed under
[Configuration](#configuration).

## First run

```bash
./run.js --new --url https://example.com/
```

The default provider is Pi. Choose another installed provider explicitly when
needed:

```bash
./run.js --new --agent codex --url https://example.com/
./run.js --new --agent claude --url https://example.com/
```

Wait for `Chrome ready`, then type a normal request at the prompt. For example:

```text
Tell me what is on this page and keep the useful tab open.
```

Enter `/quit` to save the session and stop browserctl cleanly.

## Choose the agent model

The Pi worker starts with your Pi installation's default model. Override it from
browserctl itself, in order of precedence:

- `/model <id>` in the console (or `/model` to list) — switches live and saves
  the choice for this session;
- `./run.js --open <session> --model <id>` (or `provider/id`) — applies and
  saves the choice for that session;
- `BROWSERCTL_PI_MODEL=<id>` in the environment — the default for sessions with
  no saved choice.

Saved choices live in the session manifest, so a reopened session keeps its
model. If a model turns out unresponsive mid-run, browserctl still falls back
automatically to a responsive one for the rest of the service process.

## Continue later

Reopen or inspect sessions:

```bash
./run.js --open latest
./run.js --list
```

Cookies (logins) are shared across sessions through a single owner-only jar at
`<sessions-root>/shared-cookies.json`: it is imported into the browser at launch
and rewritten from the live browser on every save and at shutdown. Everything
else — tabs, localStorage, and the rest of the Chrome profile — stays inside each
session's own `browser-profile/`. Use `--no-shared-cookies` for a fully isolated
session, or `--shared-cookies <path>` to point at a different jar.

A new session starts at `about:blank` when no URL is supplied. An existing session
keeps its saved URL, tabs, browser profile, managed conversation, extension
registration, and extension-owned state.

If the executable bit was not preserved on your platform, use `node run.js` in
place of `./run.js`.

## Run the example

After completing [Install](#install):

```bash
node examples/page-label/run.js --new
```

Then ask it to put a short label at the top of the page. See the
[page-label walkthrough](examples/page-label/README.md) for the expected result
and reopen command.

## Where private data goes

By default, mutable data is created relative to the directory from which browserctl
is invoked:

```text
weekly-logs/<session>/
├── README.md
├── session.json
├── browser-profile/
├── conversations/
├── downloads/
├── drafts/
├── logs/
├── saves/
└── screenshots/
```

Resolution order is `BROWSERCTL_RUN_DIR`, npm's original invocation directory,
then the current directory. If the repository itself is the run directory,
`weekly-logs/` and `templates/` are ignored by Git.

Private application extensions belong under ignored `local/plugins/`. Machine
wrappers and environment configuration belong under ignored
`local/environments/`. Environment files and secrets are ignored; use
`.env.example` only as a list of supported variable names.

## Natural browser collaboration

Describe the intended result normally. Each turn receives fresh page, process,
session, artifact, workflow, and extension context. Browserctl requires inspection
before mutation, verification afterward, and a plain-language result.

Extensions provide architecture, current state, procedures, and typed semantic
capabilities. The selected provider decides whether a capability matches the
request. Browserctl validates its identity, target, operation, values, cardinality,
and capacity before invoking the declared hook. It does not route human language
with application-specific phrase matching.

Useful tabs remain open for human observation. A tab should close only when the
human requests it, it is stale, or space must be freed. Extensions and providers
must never close the service-owned browser or context.

### Failure recovery

Ordinary failures are returned to the selected provider with the original request,
a bounded error envelope, and freshly rebuilt browser/workflow/extension context.
Browserctl permits two recovery turns by default and never blindly replays a hook
or browser command with uncertain effects. Cancellation, unavailable providers,
invalid host configuration, and bounded sub-decisions are not retried.

### Resumable workflows

Extensions may declare evidence-bearing multi-step plans. Browserctl atomically
stores generic step IDs, dependencies, statuses, attempts, notes, and queued human
actions in `saves/workflow-state.json`. A closed-shadow-root panel lets the human
retry a step or send a free-form correction. Application names, values, branching,
and safety policy remain in the extension.

### Quick actions

Extensions may also register a few one-line quick actions. They render as a
collapsed “✦ Quick actions” pill at the bottom-left of every managed page — a
memory aid for the main actions a returning human tends to forget. Clicking an
entry sends its example prompt to the live console agent over the same
authenticated binding the workflow panel uses. At most eight entries are allowed
across all modules, and malformed or duplicate entries fail loudly at console
start. See [EXTENSIONS.md](EXTENSIONS.md) → “Quick actions” for the contract.

## Interactive commands

```text
/status              current browser, provider, and continuity status
/plan                retry or correct an active workflow step
/launch              recover a closed browser or managed tab
/open <url>          navigate the managed page
/reload              reload the managed page
/screenshot [label]  save a full-page screenshot
/save [label]        save browser and extension-owned state
/agent <name>        choose a supported automation provider
/verbose on|off      show readable provider/tool progress
/memory <mode>       managed or ephemeral continuity
/quit                save and stop the service
```

Run `./run.js --help` for authoritative options.

## Bridge client

The service creates a token-authenticated, loopback-only bridge. From another
terminal in the same run directory:

```bash
./browserctl.js state
./browserctl.js eval 'return { title: await page.title(), url: page.url() };'
./browserctl.js screenshot review
./browserctl.js save review
./browserctl.js open https://example.com/
./browserctl.js workflow state
```

Use `--session <id>` if several services are active. `eval` and `run` execute in
the launcher's existing Playwright client with `page`, `context`,
`playwrightBrowser`, `session`, and `paths`; they never create a second browser
connection. Hook invocation and workflow updates are internal gateways normally
selected from natural language rather than typed by a human.

## Extensions

Read [EXTENSIONS.md](EXTENSIONS.md) for the complete, copyable module contract.
An extension may provide:

- contextual instructions and structured state;
- typed semantic capabilities and validated browser hooks;
- resumable workflows;
- quick actions for the in-browser reminder bar;
- before/after/recovery turn callbacks; and
- `pageReady`, `beforeSave`, `context`, and `beforeStop` lifecycle handlers.

Extension modules resolve beneath the configured mutable run directory. Duplicate
IDs/hooks, paths outside that boundary, and malformed contracts are rejected.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BROWSERCTL_RUN_DIR` | Mutable run/session root |
| `CHROME_PATH` | Chrome or Chromium executable |
| `BROWSERCTL_PI_BIN` | Pi executable override |
| `BROWSERCTL_CODEX_BIN` | Codex executable override |
| `BROWSERCTL_CLAUDE_BIN` | Claude executable override |
| `VISUAL` / `EDITOR` | Draft editor |

Bridge connection values are generated per service and passed as temporary
`BROWSERCTL_*` environment variables. They must not be committed.

## Inline automation

Run a JSON sequence against an explicitly selected session:

```bash
./run.js --open latest --inline @inline-example.json
```

Inline mode emits JSON Lines and defaults to ephemeral turns.

## Repository safety and verification

The repository intentionally excludes dependencies, sessions, profiles, prompts,
project plugins, machine environments, credentials, old Git metadata, and agent
work/context files.

```bash
npm run verify
git status --short
git diff --cached
```

`npm run audit:public` examines exactly the files Git would include. It rejects
personal paths and emails, non-loopback IP addresses, credentials, private-project
vocabulary, agent-work files, and recognizable local model identifiers. Loopback
addresses are expected because the authenticated bridge is local-only.

See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md),
[DESIGN.md](DESIGN.md), and [lib/README.md](lib/README.md) for details.
