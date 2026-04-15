---
description: Deep research on an external GitHub repository to extract implementation insights.
---

Research an external GitHub repository: $ARGUMENTS

Run a 7-phase research pipeline to extract implementation insights.

**Parse**: Extract the GitHub URL from `$ARGUMENTS`.

**Setup:**
Bootstrap Agent Mail: call `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Research: <repo-name>")`.
Create a team: `TeamCreate(team_name: "research-<repo-slug>")`.

**Phase 1 — Investigate**: Use `Agent(subagent_type: "Explore", name: "research-explore", team_name: "research-<repo-slug>", run_in_background: true)` to analyze the repository:
- Architecture overview
- Key abstractions and patterns
- Entry points and data flows
- Testing approach
- Notable implementation techniques

Save the task ID. If agent goes idle without reporting, nudge: `SendMessage(to: "research-explore", message: "Please send your findings.")`.

**Phase 2 — Deepen**: Use `Agent(subagent_type: "general-purpose", name: "research-deep", team_name: "research-<repo-slug>", run_in_background: true)` to explore 3 most interesting areas in depth. Agent prompt must include Agent Mail bootstrap (`macro_start_session`) and instruction to send findings via `send_message`.

**Phase 3 — Inversion**: Use `Agent(subagent_type: "general-purpose", name: "research-invert", team_name: "research-<repo-slug>", run_in_background: true)` to ask: "What does this repo do *badly* or *unconventionally* that we should avoid?" Agent prompt must include Agent Mail bootstrap.

**Phase 4 — Blunder hunt**: Use `Agent(subagent_type: "general-purpose", name: "research-blunders", team_name: "research-<repo-slug>", run_in_background: true)` to look for known pitfalls, anti-patterns, or design regrets in the codebase. Agent prompt must include Agent Mail bootstrap.

Phases 2–4 can run in parallel after Phase 1 completes. Nudge idle agents individually. Shutdown each individually (NOT broadcast):
```
SendMessage(to: "research-deep",    message: {"type": "shutdown_request", "reason": "Research phase complete."})
SendMessage(to: "research-invert",  message: {"type": "shutdown_request", "reason": "Research phase complete."})
SendMessage(to: "research-blunders",message: {"type": "shutdown_request", "reason": "Research phase complete."})
```

**Phase 5 — User review**: Present findings to the user. Ask: "Which insights are most relevant to your project? Any areas to explore further?"

**Phase 6 — Multi-model synthesis**: Spawn 2 parallel agents with `run_in_background: true`:
- `Agent(subagent_type: "Plan", model: "opus", name: "research-synth-a", team_name: "research-<repo-slug>", run_in_background: true, prompt: "... Agent Mail bootstrap ... What can we learn from this repo and apply to our codebase? Write findings to docs/research/<repo>-apply.md and send path via send_message.")`
- `Agent(subagent_type: "Plan", model: "sonnet", name: "research-synth-b", team_name: "research-<repo-slug>", run_in_background: true, prompt: "... Agent Mail bootstrap ... What ideas from this repo would improve developer ergonomics in our project? Write findings to docs/research/<repo>-ergonomics.md and send path via send_message.")`

Shutdown each individually after collecting results.

**Phase 7 — Synthesis**: Combine all findings into a structured research proposal.

Write the proposal to disk first: `docs/research-<repo-name>-<date>.md`. Then present key takeaways.
