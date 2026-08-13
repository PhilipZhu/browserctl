# Contributing

1. Install dependencies with `npm ci`.
2. Keep application-specific behavior in an extension outside the public core, or
   under ignored `local/plugins/` while developing privately.
3. Keep machine settings and wrappers under ignored `local/environments/`.
4. Run `npm run verify`.
5. Review `git diff --cached` before committing.

Do not commit sessions, profiles, screenshots, downloads, environment files,
credentials, personal paths, agent-work instruction files, private project names,
or local model identifiers. Do not add automated-agent attribution or co-author
trailers to commits unless a maintainer explicitly requests them.
