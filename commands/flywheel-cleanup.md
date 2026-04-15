---
description: Clean up orphaned git worktrees from crashed or stopped sessions.
---

Clean up orphaned git worktrees.

1. Run `git worktree list --porcelain` via Bash to list all active worktrees.
2. Compare against tracked worktrees in `.pi-orchestrator/checkpoint.json` (if any).
3. Identify orphaned worktrees: exist on disk but not tracked in checkpoint, or checkpoint is gone.
4. For each orphan:
   - Check for uncommitted changes: `git -C <path> status --short`
   - If dirty, warn the user and ask whether to auto-commit before removing.
   - If the user wants to auto-commit: run `git -C <path> add -A && git -C <path> commit -m "wip: orphaned worktree cleanup"`
5. List what will be removed and ask for confirmation.
6. For each confirmed orphan: `git worktree remove --force <path>` via Bash.
7. Report: "Cleaned N worktrees (M with auto-committed changes)."
