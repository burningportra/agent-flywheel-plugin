---
description: Fast path to apply a targeted fix without running the full flywheel.
---

Apply a targeted fix: $ARGUMENTS

Fast-path implementation for small, focused changes.

1. Parse the fix description from $ARGUMENTS. If empty, ask: "What needs to be fixed?"

2. Use Agent(Explore) to analyze the relevant code and understand the scope of the fix.

3. Create a single bead for the fix:
   ```bash
   br create --title "Fix: <description>" --description "<full context>" --type bug
   ```
   via Bash.

4. Use TodoWrite to add: "Fix: <description>" as in_progress.

5. Spawn a focused implementation agent:
   ```
   Agent(
     subagent_type: "general-purpose",
     prompt: "Apply this fix: <description>\n\nContext from codebase analysis:\n<analysis>\n\nKeep changes minimal and targeted. Do not refactor unrelated code."
   )
   ```

6. After the agent completes, call `orch_review` with `action: "hit-me"` to get fresh-eyes review.

7. Show the results and ask: "Looks good to commit?" If yes, mark the bead closed: `br update <id> --status closed`.
