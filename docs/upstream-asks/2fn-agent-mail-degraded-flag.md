# 2fn — Agent Mail `degraded_read_only` is a false alarm (needs mcp-agent-mail upstream)

**Status:** wontfix-upstream-coordinate — lives in `mcp-agent-mail`, not here.
**Bead:** `claude-orchestrator-2fn` (P2 / P1.3)
**Date:** 2026-05-03

## What we observed

A fresh, healthy Agent Mail session returns the following from
`health_check`:

```json
{
  "recovery": "degraded_read_only",
  "next_action": "Run am doctor repair to attempt automatic recovery"
}
```

…while every `send_message`, `file_reservation_paths`, and `fetch_inbox`
call in the same session succeeded normally. The flag refers to an
internal forensics replica / write-ahead bundle, **not** the live mailbox.

## Effect on the flywheel

Operators see "degraded_read_only" + a "run repair" recommendation as the
first signal in their session. Two failure modes follow:

1. **Premature repair attempt** — operator runs `am doctor repair` against
   a healthy mailbox; the repair churns through cleanup paths it doesn't
   need to.
2. **Alert blindness** — operators who notice "writes work fine despite
   the flag" learn to ignore the field, then miss the *real* degraded
   state when it eventually fires.

Both end the same way: the field carries no actionable signal in its
current shape.

## What "degraded_read_only" actually means today

Best operator-side guess (verify in the mcp-agent-mail source): the flag
is set when an internal forensics replica or off-process audit-log writer
is behind the live store. The live mailbox accepts writes; only the
secondary replica is read-only / behind. The naming makes it sound like
the *primary* mailbox is read-only, which it isn't.

## Proposed shape (pick whichever is cleanest in mcp-agent-mail)

1. **Rename the field** — surface the truth in the name, e.g.
   `forensics_replica_degraded: true`. Pair with a separate
   `live_writes_healthy: true|false` so callers can tell the two apart at
   a glance.
2. **Gate the flag behind real write failures** — only return
   `recovery: degraded_read_only` when the live mailbox has actually
   failed a write in the last N seconds (suggested 60s window). Otherwise
   return `recovery: healthy` (or whatever the green-state value is).
3. **Both** — rename to `forensics_replica_degraded` AND gate
   `next_action` so the repair recommendation only fires on actual write
   failure.

Option (3) is the most honest signal. Option (1) alone is the smallest
diff and probably enough to stop the false alarm.

## Acceptance from the flywheel side

Once shipped:

- A fresh, healthy Agent Mail session shows green/healthy in the first
  `health_check` call.
- The forensics-replica state, when degraded, surfaces under a name that
  doesn't imply primary mailbox failure.
- `next_action` only suggests repair when repair is needed.

## Suggested coordination

Open an issue against the `mcp-agent-mail` repo (the source of the
`am doctor` CLI and the MCP-side `health_check` tool). Reference this doc
plus bead `claude-orchestrator-2fn` and the 2026-05-03 operator
post-mortem. Mention that the flywheel-side runbook currently advises
operators to ignore this field on session start, which is brittle.
