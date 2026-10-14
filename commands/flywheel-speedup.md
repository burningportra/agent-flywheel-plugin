---
description: Make a slow endpoint, flow, job, or service fast. Baselines and profiles it, freezes behavior with real-data e2e tests, then optimizes in place or plans a same-API re-architecture, swarms it, gauntlets it under load, and cuts over behind a canary with automatic rollback.
argument-hint: "[target] [--kpi=\"p99 10s -> <500ms\"]"
---

**First action:** Invoke `Skill(skill: "agent-flywheel:flywheel-speedup", args: "$ARGUMENTS")` and let the skill drive intake; do NOT inline the phases here.

# `/agent-flywheel:flywheel-speedup` — make it fast, then prove it

Speed up the target described here: $ARGUMENTS

The skill measures first, picks the in-place or re-architecture lane from the profile, and hands re-architecture plans to the normal flywheel pipeline (beads, NTM swarm, review). All artifacts land in `docs/speedup/<slug>/`.

## See also

- `/agent-flywheel:start` — the full flywheel; **Speed up** is listed under its "More entry points".
- `/extreme-software-optimization` and `/profiling-software-performance` — the in-place lane's companion skills.
