---
# REQUIRED. Must match the directory name exactly (skills/<name>/SKILL.md).
# Claude Code uses `name` as the skill identifier. When invoking via the Skill
# tool, the fully qualified form is `agent-flywheel:<name>` — the plugin
# namespace prefix is added at invocation time, not in this frontmatter.
name: _template

# REQUIRED. One sentence, ideally under 200 chars. This is what the SKILL
# selection heuristic matches against, and what users see in the slash-command
# palette. Start with a verb ("Diagnose...", "Refine...", "Scan...").
description: One-sentence summary of what this skill does. Start with a verb, keep it specific enough that Claude can decide when to invoke it.

# OPTIONAL. Add only if your skill has strict tool requirements. Most skills
# in this repo omit this field entirely — Claude is allowed to use any tool
# by default. Uncomment and edit if you need to restrict:
# allowed-tools:
#   - Bash
#   - Read
#   - Edit
#   - Skill

# OPTIONAL. If the slash command takes arguments, document the shape here
# for reference. Claude Code does not parse this field — it is a hint for
# humans reading the source.
# argument-hint: <goal-description> [--mode <research|integrate>]
---

# <Skill Title — human-readable>

<!--
  The body below is injected verbatim into Claude's system prompt when this
  skill is selected. Prose IS behavior — be precise, use imperative voice, and
  avoid vague hedges like "consider" or "maybe". Anchor steps to tools that
  exist (Bash, Read, Edit, Skill, AskUserQuestion, MCP tools, etc.).

  Reference patterns:
  - skills/flywheel-doctor/SKILL.md — small, single-purpose skill
  - skills/start/SKILL.md — large multi-phase skill with sub-files
  - skills/flywheel-status/SKILL.md — minimal 5-step skill
-->

<One-paragraph framing of what this skill does and why. Reference `$ARGUMENTS`
if the skill accepts them.>

## When to invoke

- **<Scenario 1>** — <when it applies; what the skill delivers>
- **<Scenario 2>** — <...>
- **<Scenario 3>** — <...>

<!--
  "When to invoke" is read by the orchestrator skill (skills/start/SKILL.md)
  when deciding whether to route to you. Be concrete — vague triggers like
  "when the code is messy" will never fire.
-->

## Step 1: <Action>

<Instructions. Cite the exact tool names: Bash, Read, Edit, AskUserQuestion,
and any MCP tool as `tool_name` (e.g. `flywheel_doctor`).>

## Step 2: <Action>

<Instructions.>

## Step 3: <Action>

<Instructions. If the skill terminates with a user decision, use
`AskUserQuestion` — never free-text prompts. See UNIVERSAL RULE 1 in
skills/start/SKILL.md.>

## Error handling

<!--
  Every flywheel MCP tool returns errors as a tagged FlywheelErrorCode inside
  a Zod-validated envelope at `result.structuredContent?.data?.error`. If your
  skill calls any flywheel_* tool, branch on `error.code` (not error.message):
-->

If your skill calls `flywheel_*` MCP tools, route on
`result.structuredContent?.data?.error?.code` rather than parsing
`error.message`. Surface `error.hint` inline — it is the user's next step.

## Notes

- <Any gotchas, rate limits, or idempotency guarantees.>
- <Whether the skill is read-only or mutates state.>
