---
description: Launch a parallel swarm of agents to implement multiple beads simultaneously.
---

Launch a parallel swarm of implementation agents. $ARGUMENTS

1. Call `orch_approve_beads` with `action: "start"` via the `orchestrator` MCP tool. This returns the list of ready beads.

2. If no beads are ready, say "No beads are ready for implementation. Run /claude-orchestrator:orchestrate to create a plan first."

3. Ask the user: "How many agents should run in parallel? (Recommended: 2-4)"

4. For each ready bead (up to the user's limit), spawn an implementation agent:
   ```
   Agent(
     subagent_type: "general-purpose",
     isolation: "worktree",
     run_in_background: true,
     prompt: "## Bead: <id> — <title>

   <description>

   ## Acceptance criteria
   <criteria>

   ## Agent Mail Coordination
   Before starting work:
   1. Run macro_start_session via: curl -s -X POST http://127.0.0.1:8765/api -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"macro_start_session\",\"arguments\":{\"human_key\":\"<cwd>\",\"program\":\"claude-orchestrator\",\"model\":\"auto\"}}}'
   2. Use the returned agent name for all subsequent agent-mail calls.
   3. When done, send a completion message and release reservations."
   )
   ```

5. Use TodoWrite to mark each bead's todo as `in_progress`.

6. Report: "Swarm launched: N agents working on N beads. Use `/claude-orchestrator:orchestrate-swarm-status` to monitor progress."
