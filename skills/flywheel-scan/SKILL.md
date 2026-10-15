---
name: flywheel-scan
description: Targeted scan of specific paths or concerns without a full flywheel scan.
---

Targeted repository scan. $ARGUMENTS (optional: path or focus area)

1. Use $ARGUMENTS as the focus when present. Otherwise, ask the user for:
   - Specific path(s) to analyze
   - Focus area: architecture, performance, security, testing, dependencies

2. Call `flywheel_profile({ cwd, goal: "<focus>" })`.

3. Use one read-only Explore agent to inspect the specified focus.

4. Display the scan results:
   - Key findings for the specified area
   - Any immediate concerns
   - Suggested improvements

5. Ask: "Would you like to start a flywheel cycle targeting these findings?"
