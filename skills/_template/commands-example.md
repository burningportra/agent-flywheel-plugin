<!--
  COPY THIS FILE, do not edit it in place.

    cp skills/_template/commands-example.md commands/<your-skill-name>.md

  The destination filename (minus the .md extension) becomes the slash-command
  name that users type: `/agent-flywheel:<your-skill-name>`. The
  `agent-flywheel:` prefix is the plugin namespace — it is added at invocation
  time by Claude Code based on the plugin manifest, NOT embedded in the
  filename. Keep filenames bare: `commands/my-skill.md`, not
  `commands/agent-flywheel:my-skill.md`.

  Delete this comment block before committing.
-->
---
description: One-sentence summary of what the slash command does. Shows up in the command palette in Claude Code.
---

Invoke the `<your-skill-name>` skill. $ARGUMENTS

Use the `Skill` tool to run the skill: `Skill(skill_name: "agent-flywheel:<your-skill-name>")`.

<!--
  Optional: add a short description of when to use this command. For a single
  skill-entry-point command this is usually 1–3 sentences. Example from
  commands/flywheel-doctor.md:

  > The skill calls the `flywheel_doctor` MCP tool against the current working
  > directory, renders the `DoctorReport` envelope as an `[OK]` / `[WARN]` /
  > `[FAIL]` checklist, and prints the one-line remediation for each failing
  > check.
  >
  > Run this before `/start` on a fresh clone, after `/flywheel-cleanup`, as a
  > CI gate, or whenever toolchain drift is suspected. Doctor is read-only —
  > it never mutates checkpoint state.
-->
