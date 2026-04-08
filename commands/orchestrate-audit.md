---
description: Audit the codebase for bugs, security issues, test gaps, and dead code.
---

Run a codebase audit. $ARGUMENTS

Audit mode: "full" (4 parallel agents) or "quick" (2 agents). Default: full.

If $ARGUMENTS contains "quick", run 2 agents. Otherwise run 4.

**Full audit** — spawn 4 agents in parallel using the Agent tool with `run_in_background: true`:

1. `Agent(general-purpose, prompt: "Audit this codebase for bugs and logical errors. Focus on: null pointer dereferences, off-by-one errors, race conditions, incorrect error handling. Report findings with file:line references.")` 

2. `Agent(general-purpose, prompt: "Audit this codebase for security issues. Check for: injection vulnerabilities, improper input validation, exposed secrets, insecure dependencies, auth bypass risks. Report severity (critical/high/medium/low).")`

3. `Agent(general-purpose, prompt: "Audit test coverage. Identify: untested critical paths, missing edge case tests, flaky tests, test-only code that's not actually testing anything. Suggest specific tests to add.")`

4. `Agent(general-purpose, prompt: "Identify dead code and unused exports. Look for: unreachable code, unused imports, deprecated functions still in use, over-engineered abstractions. Report what can be safely removed.")`

After all agents complete, synthesize findings and present:
```
BUGS: N critical, N medium
SECURITY: N critical, N high  
TEST GAPS: N missing tests
DEAD CODE: N files/functions
```

Ask: "Would you like to create beads to address any of these findings?"

If yes, for each category the user selects, create a bead via `br create` with appropriate description.
