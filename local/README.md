# Local-only Files

Everything below this folder is machine-local and ignored except these short
README files. Do not place reusable browserctl source here.

- `plugins/` holds application/project-specific extensions.
- `environments/` holds local environment files, wrappers, and machine settings.

Runtime sessions still belong in the configured run directory, normally under
`weekly-logs/`, and are ignored when the repository itself is used as that root.
