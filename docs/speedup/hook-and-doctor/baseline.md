# Baseline: Bash PreToolUse hook + `flywheel_doctor`

## Fingerprint

| Field | Value |
|---|---|
| Machine | Apple M2 Max, 12 cores, 32 GB RAM, Low Power Mode off |
| OS | macOS 27.0.1 |
| Runtime | Node v26.5.1; Claude Code 2.1.300 |
| CLIs | cm 0.2.14 (810 KB playbook), gemini-cli 0.49.0, ntm, br, bv, am |
| Git SHA | `260ef00` (v3.19.0) |
| Isolation | Bare host, warm page cache, no other heavy jobs |
| Harness | `subprocess` timing from Python. The hook gets n=40 runs after 3 warmups. The doctor gets 22 sweeps over one long-lived MCP server, with the first 2 discarded as warmup. |

## Numbers

| Path | p50 | p95 | p99 | Notes |
|---|---|---|---|---|
| Hook, full path (`bash _run-hook.sh node agent-mail-guard.js`) | 60.9 ms | 66.8 ms | 75.9 ms | Paid on every Bash tool call |
| `bash -c true` (spawn floor) | 8.5 ms | 10.0 ms | 12.8 ms | Any spawned hook pays at least this |
| `_run-hook.sh` around `true` | 19.0 ms | 35.6 ms | 67.7 ms | Wrapper cost about 10–16 ms |
| `node -e 0` | 43.3 ms | 46.0 ms | 47.3 ms | Node startup dominates |
| Guard, direct | 44.5 ms | 49.7 ms | 51.6 ms | The guard's own logic is about 1 ms |
| Doctor, warm sweep wall | 871 ms | 951 ms | 1353 ms | Same server, repeated calls |
| Doctor, MCP survey (cold + warm mix) | 1340 ms | — | 2256 ms | First calls: 2345 / 2144 / 1057 ms |

## Hotspot table

| Rank | Location | Metric | Value | Category | Evidence |
|---|---|---|---|---|---|
| 1 | Hook process spawn (bash + node) for every Bash call | per-call wall | 61 ms p50 | process startup | `hook_layers.json` |
| 2 | `gemini_model_compat`: `gemini --version` | per-check p50 | 843 ms (every sweep) | subprocess (node bundle boot) | `doctor_checks.json` |
| 3 | `rescues_last_30d`: `cm --version` then `cm context flywheel-rescue --json` (history search) | per-check p50 / max | 516 ms / 1398 ms warm; 0.4–5.3 s cold | subprocess + cass history search | `doctor_checks.json`, `cm_compare.py` |
| 4 | `cm_binary`: `cm --version` (run again inside rescues) | per-check p50 | 109 ms | subprocess | `doctor_checks.json` |
| 5 | `ntm_binary` / `orphan_tender_daemons` / `projects_base_misconfig` | per-check p50 | 75 / 60 / 59 ms | subprocess | `doctor_checks.json` |

The evidence files are in the session scratchpad (`perf-baseline/hook_layers.json`, `perf-baseline/doctor_checks.json`, `survey.json`) and were produced by `profile_targets.py` and `bench_plugin.py`.

### cm subcommand floor (n=12)

| Command | p50 | max |
|---|---|---|
| `cm --version` | 97 ms | 101 ms |
| `cm context flywheel-rescue --json --history 0` | 290 ms | 326 ms |
| `cm context flywheel-rescue --json` (with history) | 0.4–5.3 s | timed out at 2 s on cold calls |
| `cm similar flywheel-rescue --json` | 264 ms | 276 ms |
| `cm playbook list --json` | 276 ms | 284 ms (810 KB output) |

Every cm call that touches the playbook costs about 280 ms, so about 290 ms is the floor for the rescue probe as long as it goes through cm.

## Hypothesis ledger

- **The hook is slow because of the guard's logic.** Rejected: the guard costs 44.5 ms run directly and `node -e 0` costs 43.3 ms, so the logic is about 1 ms and the rest is node startup.
- **A faster hook script can reach the 10 ms target.** Rejected: `bash -c true` alone has a 12.8 ms p99, so any spawned process misses the target. Only not spawning at all reaches it, which means the per-handler `if` filter (Claude Code 2.1.85+).
- **The `if` filter matches enough forms to keep the guard's coverage.** Supported, as long as one rule is used per case variant. Probe run on 2.1.300 with a plugin `hooks.json`: `Bash(*doctor*)` matched plain, multi-space, `sudo …&&`, `FOO=1 …`, `bash -c "…"`, `;`, `|` and `&&` forms. Matching is case-sensitive, so `AM DOCTOR REPAIR` needs `Bash(*DOCTOR*)`. Identical command strings with different `if` rules are not deduplicated.
- **The doctor is slow because checks run serially.** Rejected: the checks already run under a 6-wide semaphore. Wall time follows the slowest check, not the sum.
- **gemini cost depends on the machine state.** Rejected: it's about 850 ms every time and the output (`0.49.0`) never names a model, so the result is a constant green that gets recomputed on every sweep.
- **The rescue probe's variance comes from cm startup.** Rejected: `--history 0` is a consistent 290 ms. The variance is the cass history search, which sometimes exceeds the 2 s per-check timeout and flips the row to yellow (`rescue count probe failed: Timed out after 2000ms`). That makes the doctor's result nondeterministic, which is a baseline defect, not only a speed problem.

## Defects found while freezing behavior

- **The PreToolUse guard never blocks.** The hook command runs the guard through `_run-hook.sh`, which captures output and always exits 0 (the R-009 warn-only stage). Before that, `|| true` did the same. Claude Code blocks a tool call only on exit 2, so since `cc34245` (2026-05-02) the guard has logged the block to `hook-errors.log` and let `am doctor repair` and lock deletions through. `run-corpus.mjs` tests the guard script directly, so it never saw the wrapper. Reproduce it like this: `echo '{"tool_input":{"command":"am doctor repair --yes"}}' | bash hooks/_run-hook.sh node hooks/agent-mail-guard.js; echo $?` prints `0`, while the guard run directly exits `2`.
- **The SessionStart banner never reaches the session.** The same wrapper swallows `startup.js` stdout. This is out of scope for this run; it's recorded here so it isn't lost.
