---
description: Start or resume the full agentic coding flywheel. Drives the complete workflow: scan → discover → plan → implement → review.
---

# Orchestrate: Full Flywheel

Run the orchestrator for this project. $ARGUMENTS (optional: initial goal or `--mode single-branch`)

## Step 1: Check for existing session

Read `.pi-orchestrator/checkpoint.json` if it exists. If a non-idle/non-complete session is found, ask the user:

> "I found a previous session (phase: `<phase>`, goal: `<goal>`). What would you like to do?
> 1. Resume from where we left off
> 2. Start fresh (discards previous state)"

If the user chooses to start fresh, delete the checkpoint file.

## Step 2: Scan and profile the repository

Use the Agent tool with `subagent_type: "Explore"` to analyze the repo structure, languages, frameworks, key files, and recent commits. Then call the `orch_profile` MCP tool (from the `orchestrator` MCP server) with `cwd` set to the current working directory.

## Step 3: Discover improvement ideas

Call `orch_discover` with `cwd`. This returns a list of candidate improvement ideas ranked by potential impact.

Present the top ideas to the user clearly. Ask:

> "Which of these goals would you like to pursue? You can pick one from the list or describe your own goal."

## Step 4: Select goal

Once the user chooses, call `orch_select` with `cwd` and `goal` set to their choice.

## Step 5: Choose planning mode

Ask the user:

> "How would you like to plan?
> 1. **Standard plan** — single planning pass (faster)
> 2. **Deep plan** — 3 AI models give competing perspectives, then synthesize (higher quality, takes longer)"

**Standard plan**: Call `orch_plan` with `cwd` and `mode: "standard"`.

**Deep plan**:
1. Spawn 3 Plan agents IN PARALLEL using the Agent tool:
   - `Agent(subagent_type: "Plan", model: "opus", prompt: "Analyze this repository and create a correctness-focused implementation plan. Emphasize safety, avoiding regressions, and proper error handling. Goal: <goal>")`
   - `Agent(subagent_type: "Plan", model: "sonnet", prompt: "Analyze this repository and create an ergonomics-focused plan. Emphasize developer experience, clarity, API design, and simplicity. Goal: <goal>")`
   - `Agent(subagent_type: "general-purpose", prompt: "Analyze this repository and create a robustness-focused plan. Emphasize edge cases, failure modes, and resilience. Goal: <goal>")`
2. Wait for all 3 to complete.
3. Spawn a synthesis Agent(Plan): "Synthesize these 3 implementation plans into one optimal plan. Preserve the best insights from each perspective."
4. Call `orch_plan` with `cwd`, `mode: "deep"`, and `planContent` = synthesized plan text.

## Step 6: Review and approve beads

The plan creates beads (tasks) in the bead tracker. Show the beads list. Ask:

> "Here are the implementation beads. What would you like to do?
> 1. **Start implementing** — launch the implementation loop
> 2. **Polish further** — refine the beads more
> 3. **Reject** — start over with a different goal"

- "Start" → call `orch_approve_beads` with `action: "start"`
- "Polish" → call `orch_approve_beads` with `action: "polish"`, show updated beads, loop
- "Reject" → call `orch_approve_beads` with `action: "reject"`, return to Step 3

## Step 7: Implement each bead

Use TodoWrite to create a todo item for each bead. For each ready bead:

1. Spawn an implementation agent:
   ```
   Agent(
     subagent_type: "general-purpose",
     isolation: "worktree",
     prompt: "<bead title>\n\n<bead description>\n\nAcceptance criteria:\n<criteria>"
   )
   ```
2. Mark the bead's todo as `in_progress`.
3. When the agent completes, mark todo as `completed` and proceed to review.

## Step 8: Review each bead

After each bead completes, ask:

> "Bead `<id>` is done. What's next?
> 1. **Hit me** — 5 parallel review agents give fresh-eyes feedback
> 2. **Looks good** — accept and move on"

- "Hit me" → call `orch_review` with `action: "hit-me"` and `beadId`. The tool returns 5 agent task specs. Spawn them all with `run_in_background: true` using the Agent tool. Collect and summarize results.
- "Looks good" → call `orch_review` with `action: "looks-good"` and `beadId`.

## Step 9: Loop until complete

Continue implementing and reviewing beads until all are done. Show a final summary of what was accomplished.
