# Baseline: the start screen on v3.23.0

Date: 2026-10-19. Machine: the operator's Mac, load average 20 to 30 from other sessions throughout, which is typical for this host.

## Real runs

The operator's own interactive `/start` runs, timed from the slash command to the first menu in Claude Code transcripts, took 62.6 s, 71.7 s (`cheen-os`, v3.20.1), and 117.5 s (`ntm`, v3.23.0).

## Harness

`tools/bench-start.py` drives `claude -p` with stream-json input against a clone of the `ntm` repo that carries its 2,998 real beads and a pinned checkpoint (an active session at `discovering`). It loads each arm's plugin with `--plugin-dir` and the installed copy disabled, and stops a run when the session ends its turn on the first decision. In this fixture that decision is the pre-flight gate, because the doctor reports a `projects_base_misconfig` collision.

Two harness problems turned up and were fixed before any number below was kept:

1. **`AskUserQuestion` is disabled in every headless session.** Without it the model sometimes acted on the menu itself. A first 8-run pass had 2 runs resume the session's goal, loading phase skills, spawning a subagent, and reserving files. The harness now appends one instruction to both arms (print the question as text and end the turn), blocks the tools that act on an answer, and marks a run invalid if it loads a phase skill.
2. **The fixture drifted between runs.** One runaway run wrote a plan into the fixture. Every run now restores the pinned checkpoint, and the harness aborts if a run leaves any file behind.

The baseline and candidate arms ran interleaved, 8 rounds, with the order reversed every other round so load swings land on both.

## v3.23.0 numbers

| Run | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| seconds | 100.0 | 84.3 | 81.7 | 251.8 | 83.6 | 69.3 | 126.7 | 48.0 |
| model turns | 8 | 9 | 10 | 13 | 9 | 8 | 9 | 8 |

Median 84.0 s, min 48.0 s, max 251.8 s. `tools/split-time.py` splits each run into model time (turns waiting on the model) and tool waits on the critical path. The medians are 64.9 s of model time and 17.5 s of tool waits.

## Where the time goes

Model turns dominate. Step 0 took 8 to 13 sequential turns: two `ToolSearch` round trips, a Bash call for the version, the doctor alone, then a batch with `flywheel_profile`, then ad-hoc Bash and python reads of `checkpoint.json` and `br list`, then more probes the skill never asked for.

The slow tools on that path, measured one at a time on the fixture:

- `flywheel_doctor` took 5.7 s cold. Its first-run probe ran `cass search ""`, which takes about 8 s on this index and hit its 5 s timeout every time, even when a checkpoint already answered the question.
- `flywheel_profile` took 12 to 14 s on a cache miss, and Step 0 called it although only Step 2 uses it.
- `flywheel_memory` search took 5.9 to 7.9 s per query. `cm context` spends about 5.5 s of that on a session-history search that times out (`cass: TIMEOUT`) and returns no history. With `--history 0` the same query takes 0.4 to 0.9 s and returns the same learnings.
- `flywheel_observe` takes 0.6 s and `br count` 40 ms. Neither was on the path.

## Accuracy

The banner also showed wrong numbers. `br list --json` drops closed beads and `br list --all --json` stops at 50 rows, so the banner printed "50+ done" for 2,982 closed beads on all 8 runs and miscounted open or blocked beads on 3 of 8 (see `oracle.md`).
