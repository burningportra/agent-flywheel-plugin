---
description: "Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review."
---

Invoke the start skill now: `skill(name: "start")`. Any user input after `/start`: $ARGUMENTS — the skill's preflight classifies it.

The skill body is the single source of truth for the opening ceremony, menus, and routing — do not re-implement them inline. If the `skill` tool reports it unavailable, load the bundled body via `flywheel_get_skill({ name: "agent-flywheel:start" })` and execute it verbatim (degraded path; run `/flywheel-doctor` afterward).
