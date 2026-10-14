# Oracle: behavior frozen before optimizing

| Flow | Test | Data |
|---|---|---|
| Guard decision per command | `node opencode/fixtures/hooks/run-corpus.mjs` (bats: `install/test/test-sync-opencode.bats`) | `opencode/fixtures/hooks/guard-corpus.json`, 33 cases (15 block, 18 allow) |
| Guard decision as Claude Code actually invokes it | New: `mcp-server/src/__tests__/hooks-guard-wiring.test.ts`. It runs each `PreToolUse[Bash]` handler's exact `command` string through `sh -c` with `CLAUDE_PLUGIN_ROOT` set and the case on stdin, and asserts exit 2 for every block case and exit 0 for every allow case. | Same corpus |
| `if` filter coverage | Same test. It models each handler's `if` rule as a case-sensitive glob over the command string and asserts that every block case matches at least one handler. The probe run on Claude Code 2.1.300 (baseline.md) is the ground truth this model was checked against. | Same corpus |
| Doctor report shape and per-check results | `npm test`: `__tests__/tools/doctor.test.ts`, `__tests__/chaos/*` | Stubbed exec |
| Doctor results on the real machine | Before/after severity-and-message vectors from 20 warm sweeps plus 10 fresh-server first calls (`profile_targets.py`, `doctor_firstcall.py`). Messages may differ only in `durationMs`. | This machine's CLIs |

The one intended behavior change is that the guard now blocks in Claude Code, matching what the corpus always specified. Everything else must come out identical.
