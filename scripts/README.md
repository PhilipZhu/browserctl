# Repository Scripts

- `audit-public.js` examines exactly the files Git would include and rejects agent
  work files, personal paths/emails, non-loopback IP addresses, credentials,
  private-project vocabulary, and recognizable local model identifiers.

Run it with `npm run audit:public`. The same command is installed as this local
repository's pre-commit hook during preparation.
