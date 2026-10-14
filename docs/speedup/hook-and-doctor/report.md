# Report: Bash PreToolUse hook + `flywheel_doctor`

Lane: in-place (see `triage.md`). Both KPIs are met on the baseline machine (`baseline.md` fingerprint, same host before and after).

## Before and after

| Path | Metric | Before | After | KPI |
|---|---|---|---|---|
| Bash hook, command without `doctor`/`DOCTOR`/`activity.lock` (≈ every Bash call) | per-call overhead | 60.9 ms p50, 75.9 ms p99 | no process spawned | p99 < 10 ms ✓ |
| Bash hook, matching command | per-call overhead | 60.9 ms p50 | 44.5 ms p50 (node direct, no wrapper) | — |
| Bash hook, block decision in Claude Code | corpus block cases blocked | 0 / 15 (exit 2 swallowed) | 15 / 15 | — |
| Doctor, warm sweep (n=20) | p50 / p99 | 938 / 1063 ms | 350 / 386 ms | p99 < 500 ms ✓ |
| Doctor, fresh-server first call (n=10) | p50 / p99 | 1001 / 2457 ms | 355 / 568 ms | — |
| Doctor, first call with empty probe cache | once per gemini install, at most daily | — | 1109 ms | — |
| Doctor, distinct result vectors over 30 sweeps | determinism | 2 (1 intermittent rescue timeout) | 1 | identical ✓ |

The before and after doctor samples are `perf-baseline/doctor_ab_before.json` and `doctor_ab_after.json` (harness: `doctor_ab.py`) in the session scratchpad. The hook "after" claim comes from the probe run in `baseline.md`: on Claude Code 2.1.300, handlers whose `if` rule didn't match never logged a spawn for `ls -la` or `git status`. An end-to-end headless run confirmed that a harmless `true am doctor repair --yes` and an `rm -f …/.mailbox.activity.lock` are both blocked with the guard's message, while `echo ok` runs.

Per-check warm p50 after the change: `rescues_last_30d` 317 ms (the floor for `cm context` is about 290 ms), `cm_binary` 112 ms, `ntm_binary` 77 ms, and `gemini_model_compat` about 0 ms (it was 900 ms).

## Commits

1. `79d2456` perf(hooks): gate the Bash guard behind if-rules; make its exit 2 block again.
2. `689bc93` perf(doctor): cache gemini --version, drop the cm history search, share cm --version. Attribution comes from the per-check durations above. The two levers touch disjoint checks.

## Ratchets

Timing gates on shared CI runners are noisy, so the ratchets are structural and live in the normal `npm test` CI job:

- `hooks-guard-wiring.test.ts`: every `PreToolUse[Bash]` handler has an `if` rule and doesn't go through the wrapper. Everyday commands match no handler. Every corpus block case matches a handler whose exact command exits 2.
- `doctor.test.ts` › `gemini_model_compat probe cache`: a second sweep doesn't re-run `gemini --version`, and a changed binary does.
- `doctor.test.ts` › `cm probes`: one `cm --version` per sweep, and `cm context` gets `--history 0`.

## Behavior notes

- `rescues_last_30d` no longer counts cass history snippets. Rescue events are written as playbook bullets through `flywheel_memory` → `cm add`, so a history hit for the same event was a duplicate. Counts were 0 both ways on this machine. The count still depends on `cm context` ranking, which limits how many bullets it returns. That's a pre-existing limit: with a large number of rescue bullets the count could under-report, so the red threshold of 15 deserves a direct playbook query in a later change.
- The `if` rules are case-sensitive. `Am Doctor Repair` (mixed case) doesn't spawn the guard, and neither does any other casing outside the corpus. All 15 corpus block cases are covered.
- The probe cache lives at `$XDG_CACHE_HOME/agent-flywheel/doctor-probes.json` (default `~/.cache/…`). Deleting it is always safe.

## Left for later

- The SessionStart banner (`startup.js` stdout) is swallowed by `_run-hook.sh` in the same way the guard's exit code was.
- `tender-daemon.test.ts` › "writes tick events periodically" fails about 1 run in 3 in isolation. It's a pre-existing flake that's unrelated to these files.
