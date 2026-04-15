---
description: Search, store, or manage CASS long-term memory.
---

Memory operation: $ARGUMENTS

**Subcommands** (parse from $ARGUMENTS):

- `stats` (or no args): Show memory statistics.
  - Run `cm stats` via Bash. Display rule count, session count, last update.

- `search <query>`: Search memory for relevant rules and context.
  - Call `flywheel_memory` via `agent-flywheel` MCP with `operation: "search"` and `query: <query>`.
  - Display results ranked by relevance.

- `store <content>` or `remember <content>`: Store content as a memory rule.
  - Call `flywheel_memory` with `operation: "store"` and `content: <content>`.
  - Confirm: "Stored to memory."

- `view`: Show recent memory entries.
  - Run `cm list --recent 10` via Bash.

- `prune`: Remove stale or low-quality entries.
  - Run `cm prune --dry-run` via Bash first, show what would be removed.
  - Ask for confirmation, then run `cm prune`.

If $ARGUMENTS doesn't match a subcommand, treat it as a search query.
