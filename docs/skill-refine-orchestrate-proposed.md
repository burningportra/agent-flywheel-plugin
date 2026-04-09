# Proposed Changes to orchestrate.md

## Change 1: Clarify orch_approve_beads two-call behavior (Step 6)

BEFORE:
> Use `br list` to display the current beads. Ask:
> "Here are the implementation beads. What would you like to do?
> 1. **Start implementing** — launch the implementation loop
> ...
> - "Start" → call `orch_approve_beads` with `action: "start"`

AFTER (add note after the "Start" bullet):
> - "Start" → call `orch_approve_beads` with `action: "start"`
>   **Note:** If the plan was just registered via `orch_plan`, the first `orch_approve_beads` call may return "Create beads from plan" instructions instead of the quality score. In that case, create beads with `br create`, then call `orch_approve_beads` with `action: "start"` a second time to get the quality score and launch.

---

## Change 2: Fix review team creation in Step 8 (Fresh-eyes)

BEFORE:
> - **"Fresh-eyes `<id>`"** → call `orch_review` with `action: "hit-me"` and `beadId`. The tool returns 5 agent task specs. Then:
>   1. Create a review team: `TeamCreate(team_name: "review-<bead-id>")`
>   2. Spawn all 5 with `run_in_background: true`, each with `team_name` set...

AFTER:
> - **"Fresh-eyes `<id>`"** → call `orch_review` with `action: "hit-me"` and `beadId`. The tool returns 5 agent task specs. Then:
>   1. **Team for reviewers**: If an impl team is already active, **reuse it** by passing `team_name: "impl-<goal-slug>"` to the review agents — `TeamCreate` will fail with "already leading a team" if you try to create a second one. Only call `TeamCreate(team_name: "review-<bead-id>")` if no team is currently active.
>   2. Spawn all 5 with `run_in_background: true`, each with `team_name` set...

---

## Change 3: Fix br dep add syntax in Step 5.5

BEFORE:
> 2. After all beads are created, add dependency edges:
>    ```
>    br dep add <downstream-bead-id> <upstream-bead-id>
>    ```

AFTER:
> 2. After all beads are created, add dependency edges:
>    ```
>    br dep add <downstream-bead-id> <upstream-bead-id>
>    ```
>    **Syntax note:** Arguments are positional — `<downstream>` is the bead that depends on `<upstream>`. The `--depends-on` flag does NOT exist. If the command fails, check you are passing two positional IDs without any flags.

---

## Change 4: Simplify impl agent prompts for sequential worktree workflows (Step 7)

BEFORE (in impl agent prompt template):
>       ## STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY — DO THIS BEFORE ANYTHING ELSE)
>       Do NOT read any files or run any commands until all 3 sub-steps below are complete.
>       0a. Call macro_start_session(...)
>       0b. Call file_reservation_paths to reserve every file you plan to edit...
>       0c. Send a 'started' message to '<coordinator-agent-name>' via send_message...

AFTER (add note before the template):
>    **When to use Agent Mail bootstrap in impl agents:**
>    - For **parallel beads** (multiple agents editing different files simultaneously): include the full STEP 0 bootstrap with `macro_start_session`, `file_reservation_paths`, and started notification. File reservation prevents conflicts.
>    - For **sequential beads** (linear chain, one agent at a time): the bootstrap is optional overhead. A simpler prompt without STEP 0 works fine since there are no concurrent file conflicts. Still include the completion report (subject "[impl] <bead-id> done") so the coordinator knows when to proceed.

---

## Change 5: Add quality score clarification to Step 6 (user-visible UX)

BEFORE:
> After calling `orch_approve_beads` with `action: "start"`, display **both** the convergence/quality score and a summary table:
> Wait for user confirmation before proceeding to Step 7

AFTER (add before "Wait for user confirmation"):
> If the user asks "what's the quality score?" before choosing to start, call `orch_approve_beads` with `action: "start"` immediately — this is the only way to surface the score. The score appears in the tool output. Present it, then wait for confirmation before proceeding to implementation.
> Wait for user confirmation before proceeding to Step 7

