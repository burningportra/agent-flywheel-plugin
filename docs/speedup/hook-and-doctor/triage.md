# Triage: in-place lane

| Target | Baseline p99 | KPI | Gap | Top hotspot share | Amdahl bound (top-k local hotspots → 0) |
|---|---|---|---|---|---|
| Bash hook | 68–76 ms | < 10 ms | ~7.5× | Process spawn ≈ 100% | 0 ms for non-matching commands: the handler is never spawned |
| Doctor | 1353 ms warm, 2256 ms mixed | < 500 ms | ~2.7–4.5× | gemini 843 ms + rescues 516 ms (cold up to 5.3 s) | About 300 ms: the cm context floor plus about 60 ms of slot wait |

**Lane: in-place.** Both gaps come from local hotspots, and removing them reaches the target. The hook's whole cost is a process that doesn't need to start for 99%+ of Bash calls, and the harness can already skip it with a declarative `if` rule. The doctor's wall time is set by its two slowest checks. One of them (gemini) recomputes a constant from an unchanged binary. The other (rescues) runs a history search whose results the count shouldn't include: the rescue events are stored as playbook bullets through `flywheel_memory` → `cm add`, so a history hit for the same event is a second copy of it, not new evidence. Nothing here involves data volume, serialization or a storage model, so a re-architecture would buy nothing that removing those two subprocesses doesn't.

Levers, one commit each:

1. **Hook:** replace the always-spawned `PreToolUse[Bash]` handler with three `if`-gated handlers (`*doctor*`, `*DOCTOR*`, `*activity.lock*`). They call the guard with `node` directly instead of through the warn-only wrapper, so exit 2 blocks again.
2. **Doctor:** cache `gemini --version` output on disk, keyed on the resolved binary's identity (realpath, inode, size, mtime, ctime) with a 24 h backstop TTL.
3. **Doctor:** run rescues' `cm context` with `--history 0`, and share the `cm --version` probe with `cm_binary` instead of spawning it twice.
