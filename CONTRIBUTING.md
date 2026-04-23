# Contributing to agent-flywheel

This guide walks you from a fresh clone to a new skill discoverable through `/agent-flywheel:<your-skill>` in about 30 minutes. Read the whole page once before you start — the three moving parts (skill dir, commands dir, and built dist) must land in the same PR or CI will catch it.

## Prerequisites

- Node.js 18.18+ (see `mcp-server/package.json` `engines` for the pinned minimum).
- [Claude Code](https://github.com/anthropics/claude-code) (latest).
- Optional: [br](https://github.com/Dicklesworthstone/beads_rust), [bv](https://github.com/Dicklesworthstone/beads_viewer), and [agent-mail](https://github.com/Dicklesworthstone/mcp_agent_mail) if you want to exercise the full flywheel locally. `/agent-flywheel:flywheel-setup` installs them.

Clone, install, and build once:

```bash
git clone https://github.com/burningportra/agent-flywheel-plugin.git
cd agent-flywheel-plugin
npm ci --prefix mcp-server
npm run build --prefix mcp-server
claude --plugin-dir .
```

Run `/agent-flywheel:flywheel-doctor` to confirm your toolchain is green before making changes.

## The three-step skill-add loop

Adding a new skill to the plugin requires **three artifacts that must ship together**. Missing any one of them will either hide the skill from Claude Code or trip the `dist-drift` CI job.

### Step 1 — Create `skills/<name>/SKILL.md`

1. Copy the template to a new directory: `cp -r skills/_template skills/<your-skill-name>`.
2. Edit `skills/<your-skill-name>/SKILL.md`:
   - Set `name:` in the frontmatter to match the directory name.
   - Write a one-sentence `description:` — this is what Claude Code shows in the command palette and what the SKILL-selection heuristic matches against.
   - Replace the Step skeletons with your actual workflow.
3. Keep the skill idempotent and read-only where possible. Destructive operations should ask via `AskUserQuestion` first (see `skills/start/SKILL.md` UNIVERSAL RULE 1).

Skill bodies are Markdown. They are injected verbatim into Claude's system prompt when the skill is selected, so the prose IS the behavior — be precise.

### Step 2 — Create `commands/<name>.md` with the `agent-flywheel:` namespace prefix

Every skill needs a matching slash-command entry point in `commands/`. The slash command is how users (and other skills) invoke your skill.

1. Create `commands/<your-skill-name>.md`.
2. The frontmatter needs a short `description:` — this shows up in the slash-command listing inside Claude Code.
3. The body instructs Claude Code to invoke the skill: `Skill(skill_name: "agent-flywheel:<your-skill-name>")`.

**Namespace prefix — why `agent-flywheel:`?** When Claude Code loads the plugin, every skill is namespaced under the plugin's manifest name (`agent-flywheel`). The `Skill` tool invocation MUST use the fully qualified form `agent-flywheel:<your-skill-name>`; the bare `<your-skill-name>` will either resolve to a different plugin's skill or fail to resolve at all. The slash command name itself does not carry the prefix in the filename (the file is `commands/<name>.md`, not `commands/agent-flywheel:<name>.md`) — the prefix is added when the command is invoked by the user (`/agent-flywheel:<name>`) and when the command body calls the `Skill` tool.

See `commands/flywheel-doctor.md` for a minimal reference.

### Step 3 — Rebuild `mcp-server/dist/` and commit it in the same PR

Only required if you touched anything under `mcp-server/src/`. Pure docs and skill changes do not need a rebuild.

```bash
npm run build --prefix mcp-server
git add mcp-server/dist/
```

The `dist-drift` CI job fails if `mcp-server/dist/server.js` is older than the newest file under `mcp-server/src/`. Commit the rebuilt `dist/` in the same PR — never in a follow-up.

Do not hand-edit files in `mcp-server/dist/`. They are generated.

## Running tests

```bash
npm test --prefix mcp-server
```

If you added a new MCP tool or touched a runner in `mcp-server/src/tools/`, add a matching test under `mcp-server/src/__tests__/`. The test suite runs on every PR.

## Submitting a PR

1. Branch from `main`.
2. Keep the PR scoped: one skill, or one bug fix, or one doc change. Multi-skill PRs are harder to review.
3. Include `mcp-server/dist/` changes if you rebuilt.
4. Run `/agent-flywheel:flywheel-doctor` locally — if it is `red`, fix the red checks before pushing.
5. The CI pipeline runs: `npm run build`, `npm test`, dist-drift check, and `lint-skill` across every `SKILL.md`.

## Template starting point

- `skills/_template/SKILL.md` — copy-paste scaffold with required frontmatter, step skeleton, and inline comments.
- `skills/_template/commands-example.md` — copy to `commands/<your-skill-name>.md` and edit.

For reference patterns, read `skills/flywheel-doctor/SKILL.md` (small, self-contained) or `skills/start/SKILL.md` (large, multi-phase, uses sub-files).
