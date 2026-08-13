# Security

## Reporting

Before a public issue tracker is configured, report security concerns privately to
the repository owner rather than including credentials, tokens, session files, or
browser data in a public issue.

## Local data

Browser profiles, sessions, screenshots, downloads, prompt templates, bridge
tokens, environment files, and project-specific plugins are intentionally ignored.
Run `npm run audit:public` before every commit and inspect `git diff --cached`.

The browser bridge binds only to the loopback interface and requires a random
owner-only token. Do not expose its port through a public proxy or copy its token
into source control.
