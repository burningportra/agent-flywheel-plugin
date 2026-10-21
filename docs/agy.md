# The Antigravity (AGY) mirror port

The repository is the source of truth for the Claude Code plugin. The AGY
port under `~/.gemini/antigravity/plugins/agent-flywheel` is a **derived
artifact** produced by `scripts/sync-agy.sh` from manifest-owned sources
(`agy/manifest.json`, the managed `skills/` and `commands/`, `hooks/hooks.json`,
and `agy/rules/AGENTS.md`). Do not hand-edit the installed copy: the next
sync detects it as `[LOCAL]` divergence, backs it up, and overwrites it.

## Prerequisites

- Node 20+ and the flywheel CLIs on PATH (same set as the Claude plugin).
- `agy` 1.4.x on PATH — optional but recommended: `agy plugin validate
  --strict --json` is the oracle the sync runs after every check and write.
  Without it the summary says `agy validate: skipped (agy not on PATH)` so a
  missing CLI is visible, never silent.

## First sync

```bash
scripts/sync-agy.sh --write                 # render → validate → apply → re-check
agy plugin list                             # confirm the plugin is discoverable
```

`--write` renders every managed file into the target, backs up any `[LOCAL]`
divergence first, writes the SHA-256 sync state to
`<target>/.sync-state.json`, then re-checks and runs
`agy plugin validate <target> --strict --json`. The default target comes from
`agy/manifest.json` (`~/.gemini/antigravity/plugins/agent-flywheel`);
override with `--target <dir>` — the verification recipe in the bead used
`--target /tmp/fw-agy-verify`.

## Update flow

```bash
git pull
scripts/sync-agy.sh --check     # exit 0 clean, exit 1 drift
scripts/sync-agy.sh --write     # apply (backs up [LOCAL] divergences)
```

Statuses per managed file:

- `[OK]` — disk matches the rendered bytes.
- `[ADD]` — new managed file, missing on disk.
- `[UPDATE]` — disk is exactly the last sync's output; the source moved on.
- `[LOCAL]` — disk matches neither: hand-edited or foreign. `--write` copies
  the current bytes into the backup dir (default
  `<target>/.agy-sync-backups/<timestamp>/`, override with `--backup-dir`)
  before overwriting.
- `[PRUNE]` — written by a previous sync, no longer rendered. Remove with
  `scripts/sync-agy.sh --prune`. `--check` reports pending prunes and exits 1.

`--json` switches the whole report to machine-readable output. `--write` is
idempotent: a second run writes zero files and exits 0.

## What the port owns

Exactly the files `agy/manifest.json` enumerates inside the target:

- `plugin.json` (strict 7-field AGY schema — extra fields fail
  `--strict` validation) plus a byte-identical `.agy-plugin/plugin.json`
  copy, `logo.svg`
- `mcp_config.json` — the MCP server entry. AGY never loads `.mcp.json`
  (Claude Code's file name; its validator rejects it), so the repo source
  `agy/.mcp.json` is emitted as `mcp_config.json` with `${PLUGIN_ROOT}`
  resolved to this repository's absolute path. The server runs
  `node <repo>/mcp-server/dist/server.js` with `CLAUDE_PLUGIN_ROOT` set, so
  rebuild the repo (`cd mcp-server && npm run build`) before syncing after
  any `src/` change.
- `hooks.json` + `hooks/*.sh` / `hooks/*.mjs` — see below.
- `rules/AGENTS.md` — the condensed rules file, ≤ 20,000 bytes (AGY
  silently truncates rule files above 24,000; the sync fails validation past
  that). It opens with the harness-translation glossary
  (`AskUserQuestion → ask_question`, `Bash → run_command`,
  `Agent()/Task → invoke_subagent`, `Read/Edit/Write → read_file/edit_file/
  write_file`).
- `skills/<name>/**` for the 24 managed flywheel skills and
  `skills/cmd-<name>/SKILL.md` for the 24 managed commands (AGY has no
  commands concept; commands become `cmd-` skills). Skill bodies get the
  same safe-lexical rewrites as the OpenCode port plus the AGY tool-name
  glossary; `flywheel_get_skill({ name: "agent-flywheel:<x>" })` MCP names
  are byte-preserved.

Skill bodies over 24,000 bytes (currently `skills/start/SKILL.md`) are
shipped as a stub pointing at `flywheel_get_skill` — the MCP server serves
the full canonical body, which is the repo's own fast path — because AGY
loads only the first 24,000 bytes of a skill body.

## Hooks: what translates and what does not

AGY hooks are a different contract, not a different file location:
`hooks.json` sits at the plugin root, handlers must print a JSON object on
stdout, the working directory is the plugin dir, and matchers name AGY
tools. Translated (see `agy/manifest.json` hooks[]):

| Claude hook | AGY | Wrapper |
| --- | --- | --- |
| `PreToolUse` on `Bash` (`if: Bash(*doctor*)` × 3) | `PreToolUse` on `run_command` | `hooks/agent-mail-guard.sh` applies the guard patterns to `toolCall.args.CommandLine` itself (AGY has no `if` filter) and prints `{"decision":"deny","reason":…}` or `{"decision":"allow"}`. |
| `SessionStart` (`startup.js`) | `SessionStart` | `hooks/startup.sh` wraps the repo startup text as `injectSteps[0].systemMessage`, capped at 8 KB. |
| `Stop` (release reservations) | `Stop` | `hooks/release-reservations.sh` releases and prints `{}` — never `decision:"continue"`. |

Not portable, recorded explicitly in the manifest:

- `PostToolUse` on `flywheel_approve_beads` — the source `echo` prints plain
  text where AGY requires JSON, and the AGY-side MCP tool name is not known
  at sync time.
- `SubagentStop` — AGY has no such event; the `Stop` wrapper covers
  reservation release.

Note the event-name vocabulary: AGY uses `PreToolUse`/`PostToolUse` and
`PreInvocation`/`PostInvocation` — there is no `UserPromptSubmit`,
`BeforeTool`, or `AfterTool` event, and no compaction event.

## `--agy` swarm lanes

ntm v1.37+ has a native `--agy N[:model[:effort]]` lane. AGY panes run the
same `gemini-4-argon` model family the Gemini seat already runs through Pi
on the Vercel gateway, so `--agy` is a *transport* for the Gemini seat, not
a fourth model provider; the canonical `cc:pi:gem` 1:1:1 ratio and the
gmi→pi→cod→cc substitution ladder are unchanged. `agy models` lists
effort-suffixed slugs (`gemini-4-argon-low|medium|high`) and takes a
separate `--effort` flag — always pass the pair, never a bare model name.

## Troubleshooting

- **`--check` exits 1 on a fresh target** — expected; run `--write` first.
- **`[LOCAL]` on a file you never touched** — a previous sync wrote it and
  something else changed it since; the backup dir keeps the divergent copy.
- **`agy plugin validate` warnings fail the run** — strict mode treats
  warnings as errors. The usual causes are covered by the sync itself
  (7-field `plugin.json`, `mcp_config.json` vs `.mcp.json`, rule size,
  skill-body size, missing logo).
- **MCP server missing after a rebuild** — the target's `mcp_config.json`
  points into this repository; the port does not copy `mcp-server/dist/`.
  Re-run `scripts/sync-agy.sh --write` after rebuilding so the state stays
  consistent.
- **Hook wrappers print nothing** — check that `node` is on PATH for the
  AGY process; every wrapper exits 0 and prints valid JSON even on empty or
  malformed stdin.
