# Page Label Example

This example uses browserctl's service-owned Playwright page to add a persistent,
visible label to a website. It demonstrates the smallest complete extension:

- an application launcher that registers the module in each session;
- natural-language instructions and one typed semantic capability;
- a browser hook that mutates and verifies the live page;
- lifecycle state that lets the agent inspect the current label;
- restoration after navigation, reload, or session reopen.

## Run it

First complete the repository's [installation steps](../../README.md#install).
Then, from the browserctl repository root:

```bash
node examples/page-label/run.js --new
```

Chrome opens `https://example.com/`. At the `pi ›` prompt, speak naturally:

```text
Put “Ready for review” at the top of this page.
```

The selected agent interprets the request, proposes the declared typed action,
and browserctl validates it before the extension changes the page. The extension
uses Playwright, verifies the visible result, and saves browser state.

Quit with `/quit`, then reopen the same browser session:

```bash
node examples/page-label/run.js --open latest
```

The label is restored from the page's local storage. Try asking:

```text
What label is currently attached to this page?
Change it to “Approved”.
```

## Files

- `run.js` creates or opens the recoverable session and persists the extension
  registration before delegating to browserctl.
- `page-label-extension.js` contains all application knowledge and Playwright page
  work. The browserctl core remains application-neutral.

Generated `weekly-logs/` and `templates/` directories are ignored. They are safe
to delete when you no longer need the example sessions.
