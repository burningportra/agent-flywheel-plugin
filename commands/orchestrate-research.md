---
description: Deep research on an external GitHub repository to extract implementation insights.
---

Research an external GitHub repository: $ARGUMENTS

Run a 7-phase research pipeline to extract implementation insights.

**Parse**: Extract the GitHub URL from `$ARGUMENTS`.

**Phase 1 — Investigate**: Use Agent(Explore) to analyze the repository:
- Architecture overview
- Key abstractions and patterns
- Entry points and data flows
- Testing approach
- Notable implementation techniques

**Phase 2 — Deepen**: Use Agent(general-purpose) to explore 3 most interesting areas in depth.

**Phase 3 — Inversion**: Use Agent(general-purpose) to ask: "What does this repo do *badly* or *unconventionally* that we should avoid?"

**Phase 4 — Blunder hunt**: Use Agent(general-purpose) to look for known pitfalls, anti-patterns, or design regrets in the codebase.

**Phase 5 — User review**: Present findings to the user. Ask: "Which insights are most relevant to your project? Any areas to explore further?"

**Phase 6 — Multi-model synthesis**: Spawn 2 parallel agents:
- Agent(Plan, model: "opus"): "What can we learn from this repo and apply to our codebase?"
- Agent(Plan, model: "sonnet"): "What ideas from this repo would improve developer ergonomics in our project?"

**Phase 7 — Synthesis**: Combine all findings into a structured research proposal.

Save the proposal to `docs/research-<repo-name>-<date>.md` and present key takeaways.
