---
name: orchestrate-scan
description: Targeted scan of specific paths or concerns without a full orchestration.
---

Targeted repository scan. $ARGUMENTS (optional: path or focus area)

1. Ask the user what to focus on (if not specified in $ARGUMENTS):
   - Specific path(s) to analyze
   - Focus area: architecture, performance, security, testing, dependencies

2. Use Agent(Explore) with the specified focus to perform a targeted scan.

3. Call `orch_profile` via the `orchestrator` MCP tool with `cwd` and optional `goal` = the focus area.

4. Display the scan results:
   - Key findings for the specified area
   - Any immediate concerns
   - Suggested improvements

5. Ask: "Would you like to start an orchestration targeting these findings?"
