---
name: orchestrate-audit
description: Audit the codebase for bugs, security issues, test gaps, and dead code.
---

Run a codebase audit. $ARGUMENTS

Audit mode: "full" (4 parallel agents) or "quick" (2 agents). Default: full.

**Setup:**
1. Bootstrap Agent Mail: call `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Codebase audit")`
2. Create a team: `TeamCreate(team_name: "audit")`

**Full audit** — spawn 4 agents in parallel, each with `run_in_background: true` and `team_name: "audit"`:

1. `Agent(subagent_type: "general-purpose", name: "audit-bugs", team_name: "audit", run_in_background: true, prompt: "Bootstrap Agent Mail: call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: 'claude-sonnet-4-6', task_description: 'Bug audit'). Then audit this codebase for bugs and logical errors. Focus on: null pointer dereferences, off-by-one errors, race conditions, incorrect error handling. Report findings with file:line references. Send your full report to <your-coordinator-name> via send_message when done.")`

2. `Agent(subagent_type: "general-purpose", name: "audit-security", team_name: "audit", run_in_background: true, prompt: "Bootstrap Agent Mail: call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: 'claude-sonnet-4-6', task_description: 'Security audit'). Then audit this codebase for security issues. Check for: injection vulnerabilities, improper input validation, exposed secrets, insecure dependencies, auth bypass risks. Report severity (critical/high/medium/low). Send your full report to <your-coordinator-name> via send_message when done.")`

3. `Agent(subagent_type: "general-purpose", name: "audit-tests", team_name: "audit", run_in_background: true, prompt: "Bootstrap Agent Mail: call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: 'claude-sonnet-4-6', task_description: 'Test coverage audit'). Then audit test coverage. Identify: untested critical paths, missing edge case tests, flaky tests, test-only code that's not actually testing anything. Suggest specific tests to add. Send your full report to <your-coordinator-name> via send_message when done.")`

4. `Agent(subagent_type: "general-purpose", name: "audit-dead-code", team_name: "audit", run_in_background: true, prompt: "Bootstrap Agent Mail: call macro_start_session(human_key: '<cwd>', program: 'claude-code', model: 'claude-sonnet-4-6', task_description: 'Dead code audit'). Then identify dead code and unused exports. Look for: unreachable code, unused imports, deprecated functions still in use, over-engineered abstractions. Report what can be safely removed. Send your full report to <your-coordinator-name> via send_message when done.")`

**Save task IDs** returned by each Agent call — use `TaskStop(task_id: "<id>")` to force-stop unresponsive agents.

**Monitor:** If an agent goes idle without reporting, nudge it: `SendMessage(to: "<name>", message: "Please send your findings now.")`. Do NOT broadcast structured messages to "*".

**Shutdown** each agent individually after collecting results:
```
SendMessage(to: "audit-bugs",      message: {"type": "shutdown_request", "reason": "Audit complete."})
SendMessage(to: "audit-security",  message: {"type": "shutdown_request", "reason": "Audit complete."})
SendMessage(to: "audit-tests",     message: {"type": "shutdown_request", "reason": "Audit complete."})
SendMessage(to: "audit-dead-code", message: {"type": "shutdown_request", "reason": "Audit complete."})
```

After all agents complete, synthesize findings and present:
```
BUGS: N critical, N medium
SECURITY: N critical, N high
TEST GAPS: N missing tests
DEAD CODE: N files/functions
```

Ask: "Would you like to create beads to address any of these findings?"

If yes, use `TaskCreate` to track each category, then create beads via `br create` with appropriate descriptions.
