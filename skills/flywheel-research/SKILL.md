---
name: flywheel-research
description: Deep research on an external GitHub repository to extract implementation insights.
---

Research an external GitHub repository: $ARGUMENTS

Run a 7-phase research pipeline to extract implementation insights.

**Parse**: Extract the GitHub URL from `$ARGUMENTS`.

**Clone safety (MANDATORY)**: the URL MUST be https:// on an allowed Git host (`github.com`, `gitlab.com`, `bitbucket.org`, `codeberg.org`, `git.sr.ht`). Reject anything else unless the user explicitly confirms a private / self-hosted host. After cloning, pin the HEAD SHA via `git -C <dir> rev-parse HEAD` and surface it in the final research doc as `Source: <url> @ <short-sha>` so readers can reproduce the exact commit you studied. Refuse `http://` / `git://` / `ssh://` unless the user has set `FLYWHEEL_ALLOW_INSECURE_CLONE=1`.

**Setup:**
Bootstrap Agent Mail: call `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Research: <repo-name>")`.
Create a team: `TeamCreate(team_name: "research-<repo-slug>")`.

**Phase 1 — Investigate**: Use `Agent(subagent_type: "Explore", name: "research-explore", team_name: "research-<repo-slug>", run_in_background: true)` to analyze the repository:
- Architecture overview
- Key abstractions and patterns
- Entry points and data flows
- Testing approach
- Notable implementation techniques
- **Record the clone HEAD SHA** and include it in the agent's report so the synthesis phase can surface provenance.

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

Write the proposal to disk first: `docs/research-<repo-name>-<date>.md`. The proposal's header MUST include a `Source:` line with the repo URL and the short HEAD SHA recorded in Phase 1 (e.g. `Source: https://github.com/foo/bar @ abc1234`). Then present key takeaways.

---

## Major Feature Integration Mode

If the user's goal is to integrate a major feature inspired by the researched repo (not just extract insights), extend with these post-research phases:

**Phase 8 — Integration proposal**: Write a dedicated integration document at `docs/research-<repo>-integration.md`:
- What specific capabilities to adopt
- How they map to our architecture
- What we can do that the researched repo cannot (inversion analysis)
- Estimated scope and effort

**Phase 9 — Iterative deepening**: Push past conservative initial suggestions. Spawn an agent to deepen the proposal:
```
Agent(model: "opus", name: "deepen-integration", prompt: "Read docs/research-<repo>-integration.md. The initial proposal is too conservative. Push further: what ambitious integration would create the most value? What non-obvious synergies exist? Expand the proposal and write back to the same file.")
```

**Phase 10 — 5x blunder hunt**: Run 5 sequential blunder-hunt passes on the integration proposal. Each pass reads the proposal and asks: "What will go wrong if we build this? What are we missing? What assumptions are wrong?"

**Phase 11 — Cross-model feedback**: Make the proposal self-contained (no external references needed), then get feedback from 2-3 different models via parallel agents. Each writes feedback to `docs/research-<repo>-feedback-<model>.md`.

**Phase 12 — Final synthesis**: Blend all feedback using the Best-of-All-Worlds approach. Present the final integration proposal to the user with a recommended action:
- Convert to beads and implement via `/start`
- Refine further
- Shelve for later
