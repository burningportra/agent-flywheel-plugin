# e4m — Eager-load core flywheel_* MCP tools (needs Claude Code upstream)

**Status:** wontfix-needs-upstream — blocked on Claude Code platform feature.
**Bead:** `claude-orchestrator-e4m` (P1 / P2.1)
**Date verified:** 2026-05-03

## What we want

A plugin manifest field that lets a plugin author mark specific MCP tools as
**eager-loaded** (full schema injected at session start, no `ToolSearch`
indirection required), while keeping the long tail deferred. Concretely, the
agent-flywheel plugin would mark this set as eager:

- `flywheel_select`
- `flywheel_plan`
- `flywheel_approve_beads`
- `flywheel_advance_wave`
- `flywheel_review`
- `flywheel_verify_beads`
- `flywheel_memory`
- `flywheel_doctor`
- `flywheel_get_skill`

Everything else (`flywheel_calibrate`, `flywheel_remediate`, `flywheel_observe`,
`flywheel_discover`, `flywheel_profile`, `orch_*`, etc.) would stay deferred.

## Why a plugin can't fix this today

The published Claude Code [plugin manifest schema](https://docs.claude.com/en/docs/claude-code/plugins-reference)
exposes these top-level keys: `name`, `version`, `description`, `author`,
`homepage`, `repository`, `license`, `keywords`, `skills`, `commands`,
`agents`, `hooks`, `mcpServers`, `outputStyles`, `themes`, `lspServers`,
`monitors`, `dependencies`. **None of them control tool deferral.** Whether
a tool surfaces eagerly or via `ToolSearch select:<name>` is a Claude Code
runtime decision, not something a plugin author can declare.

Verified by fetching `docs.claude.com/en/docs/claude-code/plugins-reference`
on 2026-05-03 and searching for `eagerLoad`, `alwaysLoad`, `preload`,
`exposedTools`, `defaultTools` — no such field exists.

## What this costs the flywheel

Every phase boundary (discover → plan → polish → dispatch → review → wrap-up)
pays a `ToolSearch` round-trip per gating MCP call. Net ~4–6 round-trips
per phase boundary, ~1k+ tokens of catalog noise each — and `flywheel_get_skill`
itself is deferred, so even the documented recovery path needs a `ToolSearch`
first. Compounded across a multi-hour swarm session this is meaningful
context bloat (per `docs/design/2026-05-03-flywheel-architectural-design-pass.md`
§A and the original feedback at session 2026-05-03).

## What we need from Claude Code

One of:

1. **Per-tool `eager: true` flag** in the MCP server entry — e.g.

   ```json
   {
     "mcpServers": {
       "agent-flywheel": {
         "command": "node",
         "args": ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.js"],
         "eagerTools": [
           "flywheel_select", "flywheel_plan", "flywheel_approve_beads",
           "flywheel_advance_wave", "flywheel_review", "flywheel_verify_beads",
           "flywheel_memory", "flywheel_doctor", "flywheel_get_skill"
         ]
       }
     }
   }
   ```

2. **Tool annotations honored from the MCP server side** — let the server
   emit `annotations: { eager: true }` per tool in `ListTools`, and Claude
   Code respects it. This would not need a manifest schema change.

3. **A `--eager-tool` CLI flag** the user can opt into when they install the
   plugin (or a setting in `~/.claude/settings.json`).

Option (2) is the cleanest for plugin authors — no manifest churn, schema
already permits free-form `annotations`.

## Workarounds we've already tried

- **Bundling skills** to avoid `flywheel_get_skill` round-trips: shipped as
  `mcp-server/dist/skills.bundle.json` (T12). The bundle is in-process, but
  agents still need to invoke `flywheel_get_skill` to read from it — and that
  tool is deferred.
- **Compressing skill bodies**: helps token count, doesn't help the
  round-trip count.
- **Documenting the tax**: the `using-superpowers` and start skill both warn
  about the deferred-tool round-trip, but operators still pay it on every
  fresh session.

## Suggested coordination

Open an issue at `anthropics/claude-code` proposing option (2) above (MCP
tool annotations honored for eager loading). Reference this doc and the
flywheel design pass. If the Claude Code team prefers a manifest field,
option (1) is also acceptable — the flywheel will adopt whichever ships.
