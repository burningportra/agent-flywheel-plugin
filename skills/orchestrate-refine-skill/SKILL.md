---
name: orchestrate-refine-skill
description: Refine a specific agent skill using session evidence and feedback.
---

Refine a specific skill: $ARGUMENTS (skill name required)

1. Parse the skill name from $ARGUMENTS. If not provided, list available skills and ask which to refine.

1b. **Check for recent proposal cache:**
    - Look for `docs/skill-refine-<name>-proposed.md`.
    - If it exists and was modified within the last 7 days:
      - Output: "Recent proposal found (modified <date>). Showing cached analysis:"
      - Display the file contents.
      - Ask: "Re-analyze with fresh evidence, or apply these changes?"
      - If user says "apply", jump to step 6 (apply changes).
      - If user says "re-analyze", continue to step 2.
    - If not found or older than 7 days, continue to step 2.

2. Read the current skill from `skills/<name>/SKILL.md`.

3. **Triage gate — check for evidence before spawning an agent:**
   a. Search agent-mail for feedback: `search_messages` with `query: "<skill-name> feedback"`.
   b. Search agent-mail for usage: `search_messages` with `query: "<skill-name>"`.
   c. Check if any `.beads/` entries reference this skill name.
   d. If ALL searches return empty AND no session evidence was provided in $ARGUMENTS:
      - Output: "No evidence found for skill `<name>` — skipping (nothing to improve)."
      - Stop. Do NOT spawn an analysis agent.
   e. If results exist, collect them into `$EVIDENCE_SUMMARY` (max 2000 chars, newest first).

4. Proceed to analysis only if triage gate passed.

5. Use `Agent(subagent_type: "general-purpose", run_in_background: true, name: "skill-refine", team_name: "refine-skill-<name>")` to analyze.

   **Agent prompt MUST include:**
   - The full text of the current SKILL.md
   - `$EVIDENCE_SUMMARY` collected in step 3 (verbatim feedback quotes, failure logs, success patterns)
   - Specific questions to answer:
     a. Which instructions caused confusion or were ignored? (cite evidence)
     b. Which instructions worked well? (cite evidence)
     c. What failure modes appeared that the skill doesn't guard against?
     d. What DON'Ts should be added based on observed bad patterns?
     e. What DOs should be added based on observed good patterns?
   - Instruction: "If evidence is thin (< 3 data points), limit proposals to high-confidence changes only. Do not invent problems."

   Agent prompt must also include Agent Mail bootstrap (`macro_start_session`) and instruction to write proposed changes to `docs/skill-refine-<name>-proposed.md`, then send the file path via `send_message`.

   Save the task ID. Nudge if idle: `SendMessage(to: "skill-refine", message: "Please send your proposed changes.")`.
   Shutdown when done: `SendMessage(to: "skill-refine", message: {"type": "shutdown_request", "reason": "Analysis complete."})`.

6. Read the proposed changes file and show the user a diff:
   ```
   BEFORE: <current text>
   AFTER:  <proposed text>
   ```

7. Ask: "Apply these changes?" If yes, write the updated SKILL.md.

8. Confirm: "Skill `<name>` updated."
