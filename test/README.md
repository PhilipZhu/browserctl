# Tests

Run the standalone deterministic suite from the repository root:

```bash
npm test
```

The tests cover the self-contained package/run-directory boundary, session naming
and migration, documented artifact layouts, manifest preservation, CLI validation,
template discovery, authenticated bridge execution, generic extension lifecycle
and semantic dispatch, validated resumable workflows, adaptive plan actions,
failure recovery without blind replay, cancellation, managed conversation records,
service leases, fresh per-turn context, empty-final rejection, readable structured
events, inline execution, owner-only storage, and no-session provider protocols.

Private application integrations and real authenticated sessions are deliberately
outside this repository and must be tested from disposable local fixtures.

Tests are executable regression references, not the shortest learning path. Start
with the runnable [`examples/page-label/`](../examples/page-label/README.md), then
use focused tests to study validation and failure behavior.
