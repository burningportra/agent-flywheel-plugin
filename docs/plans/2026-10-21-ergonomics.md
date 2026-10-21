# Ergonomics plan: Antigravity mirror, Complete Guide gaps, pstack integration

**Date:** 2026-10-21
**Perspective:** ergonomics (API design, developer experience, naming, discoverability, simplicity) plus a challenge of the shared assumptions
**Goal slug:** `create-an-antigravity-agy-mirror-plugin-close-all-july-2026-`
**Inputs read:** planner brief, Phase 0.5 brainstorm, `live_complete_guide.txt` (operator library, deep review, pcr, rch, inversion sections), the cloned pstack tree (v0.15.29), `opencode/manifest.json` and `scripts/opencode/*.mjs`, `mcp-server/src/{gates,completion-report,model-detection,bead-templates,swarm-spawn,tender}.ts`, `adapters/model-diversity.ts`, `adapters/platform/*`, `tools/{review,plan}.ts`, the agy 1.4.4 CLI, and ntm v1.37.2.

## Verdict

Ship this as three independent tracks that share one small seam, and keep each track to the smallest version that a user would actually notice. The brainstorm treats "agy mirror", "guide gaps" and "pstack" as one 15-file mega-change, but they have different owners, different blast radii and different verification oracles, so bundling them only makes the release harder to review and harder to roll back.

The main caveat is that four of the brainstorm's load-bearing assumptions are wrong or already obsolete on this machine. I checked each one against the real tools, and the simplest version of the goal looks different from the brainstorm's version:

1. **agy already converts Claude plugins, but badly.** So `sync-agy` should build a clean, whitelisted native bundle and let `agy plugin validate --strict` be the oracle. It should not be a second 4,000-line clone of the OpenCode sync.
2. **ntm v1.37.2 already has a native `--agy N[:model[:effort]]` lane**, and the agy lane runs the same `gemini-4-argon` model the existing Gemini lane runs. So agy is a *transport* for the Gemini seat. It is not a fourth model provider.
3. **pstack is already installed here as a Claude plugin (`pstack@pstack-claude`), and it validates cleanly as a native agy plugin (56 skills, 2 agents, 0 errors).** Vendoring ~60 pstack skills into agent-flywheel would create duplicate skill names, drift from upstream, and strip the `references/` and `scripts/` folders those skills depend on. Encode pstack's *contracts* in TypeScript and delegate to the peer plugin for its interactive skills.
4. **`check-plan.mjs` validates pstack's PR-program plan format.** Run against our own synthesized plan, it reports `0 PR sections, 64 problems`. "`node scripts/check-plan.mjs` exits 0" is therefore not a meaningful acceptance gate for this repo. The rule worth porting is the `Verify, unit / Verify, live / Verify, perf` triad, and it belongs in bead-quality scoring.

The rest of this plan is organized around making each new surface easy to use correctly and hard to misuse: one entry point per job, names that match existing idioms, server-side defaults instead of agent-remembered steps, and lint rules that catch the typos humans and models actually make.

---

## 1. Evidence behind the challenged assumptions

These are things I ran, not things I inferred. Each one changes a design decision below.

### 1.1 What `agy plugin install <repo>` does today

I installed the repo into an isolated `HOME` under the scratchpad and validated the result. The trial install is still in the scratchpad because the guard blocked its recursive delete.

| Observation | Consequence for the design |
|---|---|
| It copied the **entire checkout (1.0 GB)**, including `.beads/beads.db`, `.pi-flywheel/checkpoint.json`, `node_modules/`, `.claude/settings.local.json`, `.audit/`, and `.git/` | Raw `agy plugin install <repo>` leaks local state and possibly secrets. The sync must stage a whitelisted bundle first and install from that staging dir. |
| `skills: 42 processed`, `commands: 26 processed (converted to skills)` | Skill conversion mostly works, so we keep skill bodies close to verbatim. |
| Converted command skills lack `name:` frontmatter, which leaves 16 skills all named `"SKILL"` and silently skipped | The bundle must write `name:` itself. Only one command (`flywheel-bead-viewer`) has no skill dir; every other command is a thin pointer to a skill of the same name and should **not** be emitted at all. |
| The `agent-flywheel` stdio MCP server, declared in `.claude-plugin/plugin.json`, was **dropped**. `agent-mail` (an http server in `.mcp.json`) became `{"command": ""}` | The sync must write `mcp_config.json` itself. Validator wording: `server "agent-mail" has neither "command" nor "url"`. |
| `hooks.json`: `invalid hook "hooks": command hook must specify 'command'. The loader skips this whole file` | Claude's nested `{matcher, hooks:[…]}` shape is rejected wholesale, so hooks need a real translation step with an explicit unsupported list. |
| `AGENTS.md: never loaded … Move it to rules/AGENTS.md` | The port's harness glossary and hard constraints go in `rules/`. |
| `$CLAUDE_PLUGIN_ROOT` left unrewritten in 5+ skill files | Reuse `replacePluginRootTokens` from `scripts/opencode/transforms.mjs`. |

### 1.2 Other probes

- `ntm spawn --help` documents `--agy N[:model[:effort]]`, `--assign-agy-only`, and `ntm spawn myproject --cc=3 --cod=3 --gmi=1   # legacy: Gemini CLI instead of Antigravity`. agy panes are ntm-typed, so `--type=agy` robot-send and ntm's stuck-pane tending work. Pi and Pi-Gemini panes don't get either.
- The working tree already has uncommitted agy-lane edits in `mcp-server/src/swarm-spawn.ts` (`NTM_LANES = ['cc','cod','agy']`, `AGY_LANE_VALUE_PATTERN`), `lint/rules/pane001.ts`, their tests, and `skills/start/_implement.md` / `_planning.md`. **Another agent owns this in-flight work.** Wave 2's swarm bead must coordinate in its Agent Mail thread before touching those files.
- The effort vocabularies line up across all three runners. `pi --thinking` takes `off|minimal|low|medium|high|xhigh|max`, `agy --effort` takes `low|medium|high|xhigh|max`, and ntm takes `N:model:effort`. `swarm-spawn.ts:163` hardcodes `--thinking high` today.
- `flywheel_pi_models` already ranks `xai/grok-4.7` from a SuperGrok login (see `pi-models.ts:3` and the v3.21.0 section of AGENTS.md). The `grok-4.7-xhigh-fast` strings in `setup-pstack/SKILL.md` are **Cursor subagent model ids**, not `pi --model` values.
- `skills/flywheel-research/SKILL.md:30,62` already runs **Inversion** as Phase 3, so that gap is a wording tweak and needs no new phase.
- `tender.ts:556,823` already has `onCrossReviewDue` / `recordCrossReview()`, so the cross-agent *timer* exists. What's missing is the prompt pair and the alternation and termination rules.
- `tools/plan.ts:665` already asks the synthesizer for "git-diff style changes", so only the 3-tier agreement report is missing.
- `build-skills-bundle.ts` walks only `skills/**/SKILL.md` and `skills/start/_*.md`. Vendored pstack skills would lose `references/*.md` (for example `interrogate/references/code-quality-review.md`, `architect/references/design-red-flags.md`, and `why/references/*`) when served through `flywheel_get_skill`.
- `prompt-budget` is a CI job (`.github/workflows/ci.yml:46`). Pasting the 9-field brief plus a 24-principle index into every implementer prompt will trip it unless the budget baseline moves deliberately.
- A `fix-bug` bead template already exists (`bead-templates.ts:263`). Adding pstack's `bug-fix` beside it would put two near-identical template ids in front of every bead author.

---

## 2. Design principles for this cycle

1. **One entry point per job, matching the nearest existing idiom.** `scripts/sync-agy.sh` takes exactly the flags `scripts/sync-opencode.sh` takes (`--check` default, `--dry-run`, `--write`, `--help`). A user who learned one learns both.
2. **The host's validator is the oracle.** Run `agy plugin validate --strict --json` on the staged bundle and don't rebuild its rules in our own code. Our validator only checks what agy can't know: the ownership boundary, inventory, and leak prevention.
3. **Server-side defaults beat agent-remembered steps.** Patch-ids get computed by `flywheel_verify_beads` rather than requested from implementers. Decisions get auto-logged by the tools that receive the user's choice rather than by skill prose saying "remember to log". Effort comes from bead size rather than from a flag the coordinator must remember.
4. **Additive contracts only.** `CompletionReportSchemaV1` gains optional fields, `version` stays `1`, and every new config key defaults to today's behavior.
5. **No new MCP tool where an action on an existing tool fits.** The deep bug hunt is `flywheel_review({ action: "deep_hunt" })`, not `flywheel_deep_review`.
6. **Lint the misuse we can predict.** That means unknown `[OPERATOR: …]` names, unknown template ids, `--gmi=` on a raw `ntm spawn` (PANE001 already does this), and a pstack skill referenced without the peer-plugin fallback.

---

## 3. Architecture overview

```
                    ┌────────────────────── repo (source of truth) ───────────────────────┐
                    │ skills/  commands/  hooks/  mcp-server/src  AGENTS.md               │
                    │                                                                     │
  Track A: agy      │ agy/manifest.json ──► scripts/agy/sync.mjs ──► staging dir          │
  mirror            │   (reuses scripts/opencode/{transforms,validate}.mjs)  │            │
                    │                                    agy plugin validate --strict     │
                    │                                    agy plugin install <staging>     │
                    │                                    ~/.gemini/config/plugins/agent-flywheel
                    │                                                                     │
  Track B: swarm    │ swarm-spawn.ts  --gmi=N ─► transport auto: agy (ntm lane) | pi-gw   │
  transport+effort  │ model-detection.ts EFFORT_BY_SIZE ─► pi --thinking / agy --effort  │
                    │                                                                     │
  Track C: guide    │ gates.ts deep-hunt prompts ─► flywheel_review(action:"deep_hunt")   │
  gaps              │ skills/start/_operators.md  (8 operators, OPERATOR001 lint)         │
                    │ hooks.json SessionStart[matcher=compact] ─► AGENTS.md re-read       │
                    │                                                                     │
  Track D: pstack   │ completion-report.ts  verification{verdict,evidence,verifier}       │
  contracts         │                       + server-computed patchIds                    │
                    │ adapters/brief.ts     9-field ORCH brief, size-collapsed            │
                    │ decisions.ts          .pi-flywheel/decisions/<slug>.tsv (auto)      │
                    │ bead-templates.ts     hillclimb, runtime-forensics, trace-forensics,│
                    │                       fix-bug v2 (scientific)                       │
                    │ doctor: pstack_plugin ─► skills delegate to /pstack:<x> or fallback │
                    └─────────────────────────────────────────────────────────────────────┘
```

The only seam the tracks share is `AGENTS.md` and the doctor check list. Each gets exactly one owning bead in the final wave, so no two parallel beads edit them.

---

## 4. Track A: the Antigravity mirror

### 4.1 User-facing contract

```bash
scripts/sync-agy.sh                 # --check (default): stage privately, validate, diff vs installed; exit 1 on drift
scripts/sync-agy.sh --dry-run       # print every file the write would install, plus validator findings
scripts/sync-agy.sh --write         # stage → validate --strict → agy plugin install <staging> → re-check
scripts/sync-agy.sh --staging-dir /tmp/agy-preview   # keep the staged bundle for inspection
```

The flags and exit codes match `sync-opencode.sh`: 0 means clean, 1 means drift or validator findings, and 2 means usage error or a missing prerequisite (node, agy). The script doesn't accept `--force` and never writes into `~/.gemini/config/plugins/` itself. `agy plugin install` owns that directory, which removes the whole `[LOCAL]` divergence and backup machinery the OpenCode port needed. Because agy reinstalls from the staging dir, a hand edit in the installed copy simply shows as drift on `--check` and gets replaced on `--write`.

Final output is always one summary line plus a next action:

```
sync-agy: clean · 44 skills · 2 MCP servers · 2 hooks (3 unsupported, see agy/compatibility.json) · agy 1.4.4
sync-agy: drift · 3 skills differ · run scripts/sync-agy.sh --write
sync-agy: invalid · agy plugin validate found 2 errors (listed above) · fix the source, not the install
```

### 4.2 The staged bundle (whitelist, never copy the repo)

```
<staging>/
  plugin.json                 # {name, version, description, author} from .claude-plugin/plugin.json
  mcp_config.json             # agent-flywheel (stdio, absolute launch-server.mjs path) + agent-mail (url)
  hooks.json                  # agy-native shape, translated from hooks/hooks.json
  hooks/                      # only the scripts hooks.json references (startup.js, agent-mail-guard.js, _run-hook.sh)
  rules/AGENTS.md             # generated: harness glossary + hard constraints (see 4.4)
  skills/<name>/              # every skills/<name>/ in the manifest's skills[], with name: frontmatter enforced
  skills/flywheel-bead-viewer/SKILL.md   # the one command with no skill dir, converted
```

The bundle excludes `.beads/`, `.pi-flywheel/`, `node_modules/`, `.claude/`, `.git/`, `.audit/`, `evals/`, `docs/`, `commands/` (pointer files would only collide with the skills they point to), and `mcp-server/` (the MCP config points at the repo checkout by absolute path, like the OpenCode plugin does). A unit test asserts that no staged path matches the deny list.

### 4.3 `agy/manifest.json`

It copies the shape of `opencode/manifest.json` so a contributor who knows one knows the other. `kind` is `"agy-port-manifest"`, and the file carries `skills[]`, `ownership.neverOwn`, `transformProfiles`, `mcp`, and `hooks`. The discovery pattern differs on purpose. The OpenCode port owns only `flywheel-*` and `start`, but agy has no other path to the non-flywheel bundled skills (`brainstorming`, `cass`, `idea-wizard`, …), so the agy manifest declares **every** `skills/*/SKILL.md` dir except `_template`. That's 42 today, and the count is discovered, never written into prose. The cross-check reuses `discoverManaged` / `checkInventory` from `scripts/opencode/validate.mjs`: a new skill dir that isn't listed fails with `inventory_unclassified`, which is the same error name a contributor already knows.

Transform profiles reuse `scripts/opencode/transforms.mjs` by import, without moving the files this cycle. Moving them into a `scripts/port/` folder is a follow-up; doing it now would make this cycle's diff touch the stable OpenCode port.

- `skill`: `replacePluginRootTokens(repoRoot)` and `rewriteSlashPrefixes`. It does **not** do tool-name rewrites (see 4.4), and it ensures `name:` frontmatter equals the dir name. `assertMcpNamesPreserved` stays a postcondition.
- `command-to-skill`: used only for `flywheel-bead-viewer`. It adds `name:`, drops `argument-hint`, and turns `$ARGUMENTS` into "the user's request".

### 4.4 Harness translation: a glossary rule, not lexical rewrites

The brainstorm proposes rewriting `Agent(...)` → `invoke_subagent`, `AskUserQuestion` → `ask_question`, and `TeamCreate` → `define_subagent` in skill bodies. I recommend against it for v1:

- Those agy tool names are unverified. agy 1.4.4's `--help` doesn't list tool names, and Wave 0 spike S1 must confirm them from a live `agy -p` session before anything depends on them.
- A regex over prose is the riskiest kind of transform. The OpenCode port's own plan (`2026-07-17-ergonomics.md`, friction item 5) recorded that lexical rewrites left `AskUserQuestion`, `Agent(...)` and `TeamCreate` behind, and they still needed a residual-token audit.
- agy loads `rules/*.md` into every session, so one generated `rules/AGENTS.md` that opens with a **Harness vocabulary** table ("When a skill says `AskUserQuestion`, use `<agy tool>`; when it says `Agent(subagent_type: …)`, use `<agy tool>`; `ToolSearch` doesn't exist here, so skip that step") translates every skill at once. It's easy to correct, and it can't corrupt code blocks.

`rules/AGENTS.md` is generated from a checked-in template `agy/rules/AGENTS.md.tmpl` plus the repo's `## Hard Constraints` and `## Agent Coordination` sections, which are extracted by heading so they never drift. The glossary rows come from `agy/compatibility.json`, so the doc and the report share one source.

### 4.5 Hooks translation and the compatibility report

`agy/compatibility.json` lists every Claude hook and every Claude-only tool with an explicit disposition:

| Claude source | agy | Disposition |
|---|---|---|
| `SessionStart` → `startup.js` | `SessionStart` | `translated` |
| `Stop` / `SubagentStop` → `agent-mail-guard.js --release-reservations` | `Stop` | `translated` (SubagentStop folds into Stop) |
| `PreToolUse[Bash]` with `if: Bash(*doctor*)` guards | no per-tool pre-hook seen in the user's `hooks.json` (events: `SessionStart`, `SessionEnd`, `Stop`, `PreInvocation`, `Notification`, `turn-completion`) | `unsupported` until S1 confirms whether `PreInvocation` receives the tool call |
| `PostToolUse` | n/a | `unsupported` |
| `SessionStart[matcher=compact]` (new, Track C) | no compaction event | `unsupported`, so agy relies on `rules/` being reloaded every turn |

`--check` prints the unsupported count in its summary line. The doctor's new `agy_port_drift` row is yellow on drift and green otherwise, and it never turns red, because the agy port is optional.

### 4.6 Discovery and docs

- `docs/agy.md` (about 100 lines, shaped like `docs/opencode.md`) covers prerequisites, a first sync, the update loop (`git pull → scripts/sync-agy.sh --write → agy plugin list`), what the port owns, why `commands/` isn't mirrored, the unsupported hooks, and how to install pstack for agy (`agy plugin install <pstack checkout>`, which validates clean).
- `install.sh` gains `--agy`, which runs `scripts/sync-agy.sh --write` after the Claude install when `agy` is on PATH. It's off by default so existing installs never start writing to `~/.gemini`.
- README gets a one-line pointer under "Other harnesses" beside the OpenCode line.

---

## 5. Track B: agy as a transport for the Gemini seat, plus effort budgets

### 5.1 The problem with a fourth provider

AGENTS.md's canonical rule is a `cc:pi:gem` 1:1:1 split for **model diversity**. agy runs `gemini-4-argon`, which is the same model the Gemini seat already runs through Pi on the Vercel gateway (`GEMINI_LANE_MODEL`). Adding `'agy'` to `ModelProvider` would:

- produce ratios like `2:2:1:1` where two of the four "providers" are the same model, which defeats the diversity argument the ratio exists for;
- force changes to `CapabilitiesMap`, `FALLBACK_PRIORITY`, `splitBeadsByProvider`, the `swarm_model_ratio` doctor row, the `data.report.swarm.label` string the Auto-swarm menu prints, and every skill that reads `cc:pi:gem`;
- leave the user to decide between `--gmi=2` and `--agy=2` with nothing to go on.

### 5.2 Recommended shape

The Gemini seat gains a transport. `--gmi=N` stays the only flag a user or skill has to know, and `swarm-spawn` resolves it:

| `lanes.agy` (flywheel.config.yaml) | agy on PATH and logged in | `--gmi=N` spawns |
|---|---|---|
| `true` (default) | yes | N ntm `--agy=N:<argon id>:<effort>` panes (ntm-typed, robot-send by `--type=agy`) |
| `true` | no | N Pi panes on the gateway, as today |
| `false` | any | N Pi panes on the gateway, as today |

- `--agy=N` stays accepted as an explicit override (the in-flight work already parses it), so pstack-style users who think in agy terms aren't blocked. The help text says "`--agy=N` forces the agy transport for the Gemini seat", which makes the relationship visible.
- `CliCapability` for `gemini` gains an optional `transport?: 'agy' | 'pi-gateway'`. `ModelProvider` is unchanged, as are the ratio strings and `FALLBACK_PRIORITY`.
- `gemini_cli` doctor row: green when either transport is ready, with `detail` naming which one. A new `agy_cli` row reports agy's version and login state and is yellow (never red) when agy is missing, since the Pi gateway transport covers that case.
- Prompts: `adaptPromptForGemini` already writes the Pi-terminal prompt with `am` CLI steps and `--model gemini-4-argon`. agy panes reuse it as-is, because the `am` CLI works whether or not the agy plugin is installed. **There is no `agy-prompt.ts`.** A fourth prompt adapter would be a copy of the Gemini one, and it would drift.
- Tending: agy panes are ntm-typed, so the `_implement.md` note "ntm reports Pi and Gemini panes as type `unknown`, tend them with `tmux capture-pane`" becomes "Pi panes, and Gemini panes on the gateway transport".

**Open item for synthesis:** if the robustness or correctness plan insists on agy as a distinct provider, the fallback is to keep `ModelProvider` unchanged and add `agy` only as a *lane label* in `SwarmSpawnResult.panes[].lane`. Changing the provider union is the most expensive option and the least visible to users.

### 5.3 Effort budgets (pstack's role/effort matrix, minus the Cursor model ids)

Add one exported table to `model-detection.ts`:

```ts
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** pstack setup-pstack budget tiers, keyed by the bead's size. */
export const EFFORT_BY_SIZE = { small: 'medium', medium: 'high', large: 'xhigh', unlimited: 'max' } as const satisfies Record<string, Effort>;
export function effortForBead(bead: Bead): Effort; // reuses classifyBeadComplexity: simple→small, medium→medium, complex→large
```

- `swarm-spawn.ts` stops hardcoding `--thinking high`. It takes `--effort=<level>`, defaulting to `high`, which is today's behavior and passes the existing tests unchanged. The value goes to `pi --thinking`, to ntm's `N:model:effort` for `cc`/`cod`/`agy`, and nowhere else.
- Per-bead effort rides on the dispatch prompt's header line (`Effort: xhigh`) and on `nextWave.prompts[].effort`, so a coordinator that spawns per-bead panes can pass it. The coordinator never computes it.
- `unlimited` maps to `max` only for the deep-plan synthesis and the duel. Implementers never get `max` by default, because it's the slowest and most expensive tier.

### 5.4 grok-4.7

There's nothing to add in `model-detection.ts`. `xai/grok-4.7` already reaches users through `flywheel_pi_models` whenever they have an xai login, and v3.21.0 explicitly decided the plugin must not pin Pi models. The acceptance check for "first-class grok-4.7 routing" is a `pi-models` test fixture with an xai OAuth login, asserting that `xai/grok-4.7` is the recommended option for `robustness` and is offered for `implementer`. If that test already passes, the brainstorm item is closed by documentation: one row in AGENTS.md's Pi section saying "SuperGrok users: pick `xai/grok-4.7`, which pstack's setup also defaults to."

---

## 6. Track C: closing the Complete Guide gaps

The table records what each gap needs on top of what already exists. I gave each the smallest surface that closes it.

| Gap | Already exists | Add |
|---|---|---|
| Random Code Exploration + Cross-Agent Review alternation | per-bead fresh-eyes (`gates.ts`), cross-review timer (`tender.ts`) | two prompt builders + `flywheel_review` action + termination rule |
| 8 Cognitive Operators | none | one library file, an `OPERATOR001` lint rule, and references at the 3 places that use them |
| Lie to Them / overshoot-mismatch-hunt in `_beads.md` | none | a reference to the operator, plus the concrete number (80) in the bead-audit step |
| Stack-aware validation + `rch exec --` | `profile.languages` | `verifyCommandsForStack()`; `rch` prefix only for Rust and only when the `rch` probe is green |
| `cass search` in `flywheel-refine-skill` | none in that skill | one step that runs `cass search "<skill name>" --robot --limit 20` before the rewrite |
| Inversion Analysis | `flywheel-research` Phase 3 | a wording tweak to name the asymmetric-capability question verbatim from the guide |
| git-diff + 3-tier agreement report | git-diff requested at `plan.ts:665` | an `## Agreement` section in the synthesis output: all planners / majority / single planner |
| pcr post-compaction AGENTS.md re-read | none | a `SessionStart` hook with `matcher: "compact"` |

### 6.1 Deep bug hunt

`gates.ts` gains two exported builders whose bodies are the guide's prompts verbatim (lines 1339–1350 of the guide), plus the repo-specific AGENTS.md line:

```ts
export function buildRandomExplorationPrompt(opts: { round: number; memoryContext: string }): string;
export function buildCrossAgentReviewPrompt(opts: { round: number; memoryContext: string; sinceSha?: string }): string;
```

`flywheel_review` gains `action: "deep_hunt"`, with input `{ round?: number, lastRoundClean?: boolean[] }`:

- Odd rounds return the random-exploration prompt, and even rounds return cross-agent review. The caller doesn't pick, so it can't run the same prompt twice in a row.
- The response carries `data.prompt`, `data.kind: "random_exploration" | "cross_agent"`, `data.round`, and `data.next: "continue" | "converged" | "return_to_bead_space"`. The server computes `next` from `lastRoundClean`: two consecutive clean rounds give `converged`, and four or more rounds still finding bugs give `return_to_bead_space` (the guide's rule).
- `data.preflight` reminds the caller to run `ubs .` on the full project before round 1 (guide: "Always run `ubs .` on the full project first").
- `tender.ts`'s `onCrossReviewDue` message names this action, so the existing timer points at the new behavior.
- `skills/start/_review.md` gains a "Deep bug hunt" subsection: send the returned prompt to 2–3 idle panes, never to all of them (guide: "Do not have all agents stop"), feed the cleanliness back, and stop on `converged`.

The action is named `deep_hunt` and not `deep_review`, because `batch_review` already exists and two `*_review` actions with different scopes inside `flywheel_review` would be easy to confuse.

### 6.2 Operator library

- `skills/start/_operators.md` holds the 8 operators verbatim from guide lines 1960–2045: block, context, and psychology. It gets bundled automatically, since `build-skills-bundle` walks `skills/start/_*.md`, and is served as `agent-flywheel:start_operators`.
- `mcp-server/src/lint/rules/operator001.ts` flags any `[OPERATOR: <name>]` in `skills/**` or `commands/**` whose name isn't a heading in `_operators.md`. The list is parsed from the file, not duplicated in TS, so the library stays the only source.
- Call sites: `_beads.md` (overshoot-mismatch-hunt with "at least 80 mismatches", plan-to-beads-transfer-audit), `_planning.md` (competing-plan-triangulation, convergence-polish-loop, which already match what deep plan does), `_implement.md` (fungible-swarm-launch, fresh-eyes-reset), and `_wrapup.md` (feedback-to-infrastructure-closure, pointing at `flywheel_memory(refresh_learnings)`).

### 6.3 Stack-aware validation

`adapters/implementer-dispatch.ts` gets `verifyCommandsForStack(profile, caps)`, which returns the commands the implementer prompt's VERIFY field lists. For TypeScript in this repo that's `cd mcp-server && npx tsc --noEmit && npm test`. Rust gets `rch exec -- cargo check --all-targets`, plus clippy and test, only when the `rch` probe is green; otherwise the same commands run without the prefix, with a one-line note. Go gets `go vet ./... && go test ./...`. The table lives in one exported constant so docs and tests read the same data.

### 6.4 Post-compaction re-read

Add a `SessionStart` entry with `"matcher": "compact"` to `hooks/hooks.json`. It runs `startup.js --post-compact`, which prints a short reminder: "Context was compacted. Re-read AGENTS.md (Hard Constraints, Agent Coordination) and `flywheel_observe` before continuing." It doesn't depend on any external `pcr` binary, since the guide's `pcr` is a separate tool the user may not have, and a missing binary in a hook is a silent failure. The doctor's hooks validation in `ClaudeCodeAdapter.validateHooks` learns the new entry.

---

## 7. Track D: pstack contracts, natively encoded

### 7.1 Peer plugin, not vendored copies

- New doctor row `pstack_plugin`. It's green when `~/.claude/plugins/installed_plugins.json` lists a `pstack@*` entry, or when `agy plugin list --json` lists `pstack` in an agy session. Otherwise it's yellow with the hint `claude plugin install pstack@pstack-claude` (or `agy plugin install <pstack checkout>`). It's never red, because the flywheel works without pstack.
- Skills reference pstack skills by their real names, which also preserves upstream updates: `/pstack:how`, `/pstack:why`, `/pstack:architect`, `/pstack:arena`, `/pstack:interrogate`, `/pstack:blast-radius`, `/pstack:unslop`, `/pstack:no-comments`, `/pstack:tdd`, `/pstack:create-verification-skill`, `/pstack:correct`. Each reference sits in a two-branch sentence of the form "When `pstack_plugin` is green, run `/pstack:interrogate` on the diff; otherwise run the flywheel's fresh-eyes reviewer." The new lint rule `PSTACK001` flags a `/pstack:` reference with no `otherwise` clause in the same paragraph, so the plugin never hard-depends on an optional peer.
- Where they plug in:
  - `_planning.md` Step 5 pre-plan grounding runs `/pstack:how` (the area being changed) and `/pstack:why` (any surprising existing constraint) before planners spawn, with output saved to `docs/brainstorms/<slug>-grounding.md`. Design forks go to `/pstack:arena` or the `prototype` playbook before an `AskUserQuestion`, but only when the fork is empirically testable in under 15 minutes, so the gate doesn't add a step to every plan.
  - `_review.md` adds `/pstack:interrogate` (Code Judo + Lead Judgment) as an optional third reviewer for beads routed as risky, and `/pstack:blast-radius` for p0/security beads beside the existing duel.
  - `_wrapup.md` runs `/pstack:unslop` on changed docs and `/pstack:no-comments` on the changed-file list (comment-sicko), with the fallback being the existing `docs-de-slopify` skill.
- Attribution: README's credits gain one line, "pstack by Lauren Tan (MIT), used as an optional peer plugin." No pstack files are copied, so the MIT notice requirement doesn't trigger.

**If synthesis insists on vendoring**, put the snapshot under `vendor/pstack/` pinned by commit in `vendor/pstack/pstack.lock.json` (`{ upstream, commit, version: "0.15.29", fetchedAt }`), serve it only to the agy port and never through the Claude bundle (the Claude side already has the real plugin), and extend `build-skills-bundle` to include `references/**` first. Skipping that last step ships skills whose own instructions point at files that aren't there.

### 7.2 Verification ledger, folded into the completion report

pstack's `orch` keeps `ledger.tsv` keyed by PR + SHA. The flywheel has no per-bead PRs, but it already has a per-bead durable record, `.pi-flywheel/completion/<bead>.json`. A second ledger file would give us two sources of truth for "is this bead verified", so the verdict goes into the existing report.

Additive optional fields on `CompletionReportSchemaV1`:

```ts
verification: z.object({
  verdict: z.enum(["live-ui-verified", "unit-test-verified", "type-check-only", "verifier-blocked", "verifier-failed"]),
  evidence: z.string().min(1),        // the command or artifact path that proves it
  verifier: z.string().min(1),        // who ran it: agent name or "coordinator"
}).optional(),
patchIds: z.array(z.string().regex(/^[0-9a-f]{40}$/)).optional(), // written by the server, not the implementer
```

- `flywheel_verify_beads` computes `git patch-id --stable` for each entry in `commits[]` and writes `patchIds` back into the report through `writeCompletionReport`. Implementers never type a patch-id. Its value is that a rebased or cherry-picked commit keeps its verification, because when a report's SHA isn't reachable but a reachable commit has the same patch-id, the report still counts.
- `flywheel_advance_wave`: `verifier-failed` is always treated like `attestation_invalid` (it warns under Stage 1 and blocks under `FW_ATTESTATION_REQUIRED=1`). A missing `verification` adds a `needsVerification` hint and nothing more under Stage 1, so older swarms keep working. `type-check-only` on a bead whose template declares `verifyLive: true` adds a warn hint naming the template.
- `formatCompletionEvidenceSummary` prints the verdict first, since that's what a coordinator scans for.
- `.pi-flywheel/ledger.tsv` exists only as a **derived** view, regenerated by `flywheel_verify_beads` with pstack's header (`pr sha verdict evidence verifier ts`, with `pr` holding the bead id) for anyone who uses pstack's `orch status` habits. A file header says "generated, do not edit".
- The implementer prompt's worked JSON example (`completion-attestation-prompt.ts`) gains the `verification` block, with a one-line rule for picking the verdict: "the strongest verdict whose evidence you actually ran".

### 7.3 The 9-field brief

pstack's brief fields are `GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, REPORT, STANDING`. Today the implementer prompts carry the same information in an ad-hoc order spread across `claude-prompt.ts` and `codex-prompt.ts`.

- A new `adapters/brief.ts` exports `interface ImplementerBrief { goal; scope: { write: string[]; readOnly: string[] }; context; acceptance: string[]; verify: string[]; timeboxMinutes; forbidden: string[]; report; standing }` and `renderBrief(brief, { collapse: boolean })`.
- `buildBrief(bead, ctx)` fills it from data the server already has: the bead title and description, files from the bead or template, acceptance from the template's checklist, `verifyCommandsForStack`, a timebox from `EFFORT_TO_MINUTES[template.estimatedEffort]`, FORBIDDEN from the AGENTS.md "never" list (no stash, no hard reset, no branch switch, matching the in-flight `_implement.md` change), REPORT pointing at the completion JSON, and STANDING pointing at `AGENTS.md`.
- `claude-prompt.ts` and `codex-prompt.ts` (and the Pi/Gemini adapters, which live in `claude-prompt.ts`) render through `renderBrief` instead of composing sections by hand, so every lane gets the same field order.
- Size rule (pstack: "size the brief to the unit"): `collapse: true` for beads classified `simple`. That gives one paragraph that still names goal, scope, the verify command, and the report shape. `medium` and `complex` beads get the full nine-field block.
- `buildBrief` throws when GOAL, SCOPE.write, ACCEPTANCE, or VERIFY would be empty ("a field you cannot fill is a unit you have not scoped yet"), and `flywheel_approve_beads(action: "start")` surfaces it as `invalid_input` naming the bead and field. Under-scoped beads fail at approval, before a pane burns tokens on them.
- **Principles index:** don't inject 24 principles into every prompt. Each bead template declares `principles: string[]` (2–4 names; for example `fix-bug` gets `fix-root-causes`, `prove-it-works`, `test-behavior-not-implementation`), and the brief's STANDING field lists those by name with the one-line description. The full index lives once, in `skills/start/_principles.md`, a one-line-per-principle table that links to `/pstack:principle-<name>` when pstack is installed. This keeps prompt growth to about 4 lines per bead. `docs/perf/prompt-budget.json` gets re-baselined in the same bead that ships the brief, with the delta stated in the commit message.

### 7.4 Playbook-typed bead templates

- Add `hillclimb` (metric, probe, baseline, keep/revert rule per iteration, so pstack's `Verify, perf` items become required placeholders `METRIC`, `PROBE`, `BASELINE`, `RULE`), `runtime-forensics` (reproduce → instrument → capture → hypothesis → confirm), and `trace-forensics` (trace source, span of interest, expected vs observed timing).
- **Don't add `bug-fix`.** Upgrade `fix-bug` to version 2 with pstack's scientific steps (reproduce with a failing test → hypothesize → falsify → minimal fix → prove with the same test), and keep version 1 resolvable through `getTemplateById(id, 1)`, so calibration history for `fix-bug` stays in one bucket. An entry in `TEMPLATE_ALIASES = { "bug-fix": "fix-bug" }` resolves the pstack spelling, and the bead-creation builder prints `Template: fix-bug` either way. Without the alias, a model trained on pstack writes `Template: bug-fix`, the bead silently lands in `__untemplated__`, and calibration loses it.
- Every template gains `verifyLive: boolean` and `principles: string[]`. `verifyLive` drives the advance-wave hint in 7.2 and the bead-quality check in 7.5.

### 7.5 `Verify, unit / live / perf` in bead quality

The part of `check-plan.mjs` worth keeping applies to beads, not to plan documents. `flywheel_approve_beads` quality scoring gains one dimension: a bead's acceptance section must name **unit** evidence (a test command or test file), plus **live** evidence when its template has `verifyLive: true`, plus **perf** evidence when the template is `improve-performance` or `hillclimb`. A missing box costs score and appears in the hotspot matrix as `missing_verify_live` and the like. It doesn't hard-block, matching how the other quality dimensions behave. `check-plan.mjs` itself isn't copied in.

### 7.6 Decision trail

- `mcp-server/src/decisions.ts` exports `appendDecision(cwd, slug, { phase, decision, why, evidence, result })`. It writes `.pi-flywheel/decisions/<slug>.tsv` with pstack's header `ts phase decision why evidence result`, escapes tabs and newlines in cells, and appends atomically under the existing mutex.
- **Auto-logged by the server**, so no skill prose has to remember it, at every point where a tool receives a user choice: `flywheel_select` (goal), `flywheel_plan` (mode, ambition), `flywheel_approve_beads` (start/polish/reject/remediate), `flywheel_synthesize_rubric` (approve/edit/skip), `flywheel_grade_outcome` (verdict), and `flywheel_advance_wave` (an override of an attestation or convergence gate).
- For decisions that happen only in skill prose, such as an `AskUserQuestion` the server never sees, the escape hatch is `node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/scripts/decision-log.js" --phase <p> --decision "<d>" --why "<w>" [--evidence <e>]`, whose flags mirror pstack's `log.sh`. The slug is read from the checkpoint; there's no `--slug` flag to get wrong.
- `flywheel_observe` gains `decisions: { path, count, last?: {ts, decision} }`, so the trail is discoverable from the snapshot every `/start` already takes.

### 7.7 `/correct` and the Rule Enforcement Table

`AGENTS.md` gains a `## Rule enforcement` table with one row per Hard Constraint and Code Convention: the rule, its enforcer (a lint rule id, test file, CI job, or hook), and its status (`enforced` / `partial` / `prose-only`). Building it is mostly reading. For example, "No `console.log` in MCP server code" maps to whichever lint or test enforces it, "All `exec` calls must include a `timeout`" might be prose-only today, and `RESERVE001`, `PANE001`, `TONE001` and the new `OPERATOR001`/`PSTACK001` each get a row. Each `prose-only` row becomes a follow-up bead candidate. That's pstack's `/correct` loop (Architecture → Types → Lint → Test → Docs), applied once by hand. Automating `/correct` itself is out of scope for v1.

---

## 8. Ordered implementation waves

The file-ownership columns are disjoint inside each wave. **Bold** files are already dirty in the working tree from another agent's in-flight work, so the bead owner must message that agent's thread before reserving them.

### Wave 0: spikes (time-boxed, run before beads that depend on them)

| Bead | Question | Output | Timebox |
|---|---|---|---|
| S1 | agy plugin `hooks.json` schema (which events, does `PreInvocation` see tool calls); agy's tool names for subagents and questions; does a plugin's `mcp_config.json` load in `agy -p`? | `docs/research/2026-10-21-agy-plugin-spike.md` with the commands run and outputs; seeds `agy/compatibility.json` | 45 min |
| S2 | agy's model id for gemini-4-argon (`agy models`) and a non-interactive login check | the two exact command lines, recorded in the same doc | 20 min |
| S3 | Does `flywheel_pi_models` already rank `xai/grok-4.7` for robustness given an xai OAuth fixture? | a failing or passing test in `__tests__/pi-models.test.ts`; if it passes, §5.4 closes as docs-only | 20 min |

### Wave 1: independent foundations (8 beads, all parallel)

| Bead | Template | Files (exclusive) | Depends |
|---|---|---|---|
| A1 agy bundle renderer | `add-feature` | `agy/manifest.json`, `agy/compatibility.json`, `agy/rules/AGENTS.md.tmpl`, `agy/fixtures/**`, `scripts/agy/sync.mjs`, `scripts/agy/render.mjs`, `scripts/sync-agy.sh`, `scripts/agy/*.test.mjs` | S1, S2 |
| D1 completion verification + patch-ids | `foundation-with-fresh-eyes-gate` | `completion-report.ts`, `tools/verify-beads.ts`, `adapters/completion-attestation-prompt.ts`, their tests | – |
| D2 templates | `refactor-module` | `bead-templates.ts`, `types.ts` (template fields only), `__tests__/bead-templates*.test.ts` | – |
| D3 decision trail core | `add-feature` | `decisions.ts`, `scripts/decision-log.ts`, `__tests__/decisions.test.ts` | – |
| C1 deep-hunt prompts | `add-feature` | `gates.ts`, `__tests__/gates.test.ts` | – |
| C2 operator library + lint | `new-skill` | `skills/start/_operators.md`, `lint/rules/operator001.ts`, its test, lint rule registry | – |
| B1 effort table | `update-configuration` | `model-detection.ts`, `__tests__/model-detection.test.ts` | – |
| C3 small skill edits | `doc-update` | `skills/flywheel-refine-skill/SKILL.md` (cass step), `skills/flywheel-research/SKILL.md` (inversion wording) | – |

### Wave 2: integrations (7 beads)

| Bead | Files (exclusive) | Depends |
|---|---|---|
| D4 brief renderer + adapters | `adapters/brief.ts`, `adapters/claude-prompt.ts`, `adapters/codex-prompt.ts`, `adapters/implementer-dispatch.ts` (incl. `verifyCommandsForStack`), `docs/perf/prompt-budget.json`, tests | D2, B1 |
| D5 advance-wave verdict gate + ledger view | `tools/advance-wave.ts`, `tools/observe.ts` (decisions + verdict hints) | D1, D3 |
| D6 bead-quality verify triad + decision auto-log in approve | `tools/approve.ts`, `tools/select.ts`, `tools/plan.ts` (also the §6 agreement section), `tools/synthesize-rubric.ts`, `tools/grade-outcome.ts` | D2, D3 |
| C4 `deep_hunt` action | `tools/review.ts`, `tender.ts` (message text only), server schema/registry entry for the new action | C1 |
| B2 Gemini transport + `--effort` | **`swarm-spawn.ts`**, **`lint/rules/pane001.ts`**, `adapters/model-diversity.ts`, `flywheel-config.ts`, **their tests** | B1, S2, plus coordination with the in-flight owner |
| C5 post-compact hook | `hooks/hooks.json`, `hooks/startup.js`, `adapters/platform/ClaudeCodeAdapter.ts` | – |
| X1 doctor rows | `tools/doctor.ts` and its check modules: `agy_cli`, `agy_port_drift`, `pstack_plugin`, `gemini_cli` transport detail | A1, B2 (for the transport detail; the other rows can land first) |

### Wave 3: skills and docs (4 beads, after Wave 2 merges)

| Bead | Files (exclusive) | Depends |
|---|---|---|
| K1 start sub-skills | **`skills/start/_implement.md`**, **`skills/start/_planning.md`**, `skills/start/_beads.md`, `skills/start/_review.md`, `skills/start/_wrapup.md`, `skills/start/_principles.md`, `lint/rules/pstack001.ts`, `.lintskill-*` baselines | C2, C4, D4, B2 |
| K2 AGENTS.md | `AGENTS.md` (quick-reference rows: `deep_hunt`, doctor 24→27, v3.26.0 section, Gemini transport, Rule enforcement table, Effort) | all of Wave 2 |
| K3 user docs | `docs/agy.md`, `README.md`, `CHANGELOG.md`, `install.sh` (`--agy`), `docs/opencode.md` (cross-link only) | A1, X1 |
| K4 agy rules template refresh | `agy/rules/AGENTS.md.tmpl` regenerated against the final AGENTS.md | K2 |

### Wave 4: integration and release (1 bead)

`npm run build` (commit `dist/`), `npm run check:skills-bundle`, `npm run lint:skill`, `npm run prompt-budget -- --check`, the full vitest run, and then `scripts/sync-agy.sh --write --staging-dir <scratch>` into a scratch `HOME`, followed by `agy plugin validate --strict --json` showing 0 errors. The bead also bumps the version (v3.26.0) and runs the `version-sync` script.

---

## 9. Testing strategy

Every test asserts behavior a user or caller observes. The relevant defect for each is named, so the test demonstrably catches it.

| Area | Test | Defect it catches |
|---|---|---|
| agy bundle | Render `agy/fixtures/repo-mini` and assert the staged tree exactly equals the golden list, with no path under `.beads`, `.pi-flywheel`, `node_modules`, `.claude`, `.git` | A whitelist regression that leaks local state (the 1.0 GB trial) |
| agy bundle | Every staged `skills/*/SKILL.md` has `name:` equal to its dir name, and the names are unique | The 16 `"SKILL"` collisions the native converter produced |
| agy bundle | `mcp_config.json` has `agent-flywheel.command === "node"` with an absolute args path, and `agent-mail.url` is set | Dropped stdio server, empty-command http server |
| agy bundle | `hooks.json` has no nested `hooks` key, and every Claude hook appears in `compatibility.json` as `translated` or `unsupported` | `loader skips this whole file` |
| agy bundle | Rendering twice gives byte-identical output; `--check` after `--write` exits 0 | Non-idempotent sync |
| agy CLI | Integration test gated on `command -v agy` runs `agy plugin validate <staging> --strict --json` and expects 0 errors. When agy is absent it prints `skipped: agy not on PATH` and the test is marked skipped. It never silently passes | Our renderer and the host's real loader disagreeing |
| Transport | `--gmi=2` with agy ready yields ntm args containing `--agy=2:<argon>:high`; with `lanes.agy: false` it yields 2 Pi panes on `GEMINI_LANE_MODEL` | Gemini seat silently switching transports |
| Effort | Default spawn still emits `--thinking high`, and `--effort=xhigh` emits `--thinking xhigh` and `:xhigh` on ntm lanes | Behavior change for existing swarms |
| Completion | A report with `verification.verdict: "verifier-failed"` makes `advance_wave` return `needsEvidence` (warn) and `attestation_invalid` under `FW_ATTESTATION_REQUIRED=1` | A failed verifier advancing silently |
| Completion | A v3.25 report with no `verification` and no `patchIds` still parses and validates | Breaking the additive-forever schema |
| Patch-id | Rewriting a commit's SHA (cherry-pick onto a new parent in a temp repo) still satisfies verification through the matching patch-id | Rebases invalidating evidence |
| Brief | Every prompt from `approve(start)` for a medium bead contains the 9 headers in order; a simple bead's prompt contains goal, scope, verify and report in one paragraph | Lanes drifting in field order; bloating trivial beads |
| Brief | A bead with no files and no template files fails `approve(start)` with `invalid_input` naming `SCOPE` | Under-scoped beads reaching panes |
| Templates | `getTemplateById("bug-fix")` resolves to `fix-bug` v2, and `getTemplateById("fix-bug", 1)` still returns v1 | The duplicate-template and calibration-bucket split |
| Deep hunt | Round 1 returns `random_exploration`, round 2 `cross_agent`; `[true,true]` gives `converged`; four dirty rounds give `return_to_bead_space` | Repeating one prompt; never terminating |
| Operators | `OPERATOR001` flags `[OPERATOR: overshot-mismatch-hunt]` (a typo) and passes the 8 real names | Typos in operator references |
| PSTACK001 | Flags a `/pstack:interrogate` paragraph with no fallback clause | A hard dependency on an optional plugin |
| Decisions | `flywheel_select` appends exactly one row; a cell containing a tab or newline is escaped; two concurrent appends both land | Lost rows, corrupt TSV |
| Hooks | `ClaudeCodeAdapter.validateHooks` accepts the `compact` matcher, and `startup.js --post-compact` prints the AGENTS.md reminder to stdout and exits 0 | A hook that errors after every compaction |
| Doctor | `pstack_plugin` and `agy_cli` are yellow, never red, when missing; the `flywheel_doctor` count is 27 | Optional peers blocking the preflight banner |

---

## 10. Acceptance criteria

1. `cd mcp-server && npx tsc --noEmit && npm run build && npm test && npm run check:skills-bundle && npm run lint:skill && npm run prompt-budget -- --check` all exit 0, and `git status` shows `dist/` in sync.
2. `scripts/sync-agy.sh --check` exits 0 on a machine where `--write` has run, and exits 1 with a `drift` summary after any `skills/**` edit.
3. `agy plugin validate ~/.gemini/config/plugins/agent-flywheel --strict --json` reports 0 errors. Its warnings are exactly the ones listed in `agy/compatibility.json`.
4. The installed agy plugin is under 5 MB and contains no `.beads`, `.pi-flywheel`, `node_modules`, `.claude` or `.git` path.
5. In an agy session, the `start` skill loads and the `flywheel_get_skill` MCP tool answers. This is verified by hand once and recorded in `docs/agy.md` with the agy version.
6. `swarm-spawn.js <p> --label t --cc=1 --pi=1 --gmi=1 --dry-run` (or the equivalent unit test) shows the Gemini seat on the agy transport when agy is ready and on Pi otherwise, and the label stays `cc:pi:gem 1:1:1`.
7. `flywheel_review({ action: "deep_hunt", round: 1 })` returns the guide's random-exploration prompt verbatim plus the AGENTS.md line.
8. All 8 operator names appear in `_operators.md`, and `OPERATOR001` passes on the whole `skills/` tree.
9. `.pi-flywheel/decisions/<slug>.tsv` gains a row on `flywheel_select` with no skill-side action.
10. AGENTS.md has a `## Rule enforcement` table covering every Hard Constraint, and its quick reference lists `deep_hunt`, the three new doctor rows, the Gemini transport, and `EFFORT_BY_SIZE`.
11. `node scripts/check-plan.mjs` is **not** an acceptance gate (§1.2). The bead-quality verify triad (§7.5) replaces it.

---

## 11. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| agy's plugin format changes; agy is at 1.4.x and moving fast | High | `agy plugin validate` is the oracle on every `--check`, so format drift shows up as a named validator finding instead of a silent load failure. The renderer stays small enough to update in one bead. |
| Collision with the in-flight agy-lane edits (`swarm-spawn.ts`, `pane001.ts`, `_implement.md`, `_planning.md` are dirty) | High | B2 and K1 are Wave 2/3 and must message that agent's thread before reserving. If the other work lands first, B2 rebases onto it and only adds the transport resolution and `--effort`. |
| The brief and principles push prompts over budget | Medium | Simple beads get the collapsed brief, principles are per-template (2–4 names), and the baseline moves in the same bead with the delta in the commit message. |
| Reviewers or synthesis reject the "transport, not provider" call | Medium | §5.2 lists the cheaper fallback (a lane label only). Neither option touches the ratio strings that downstream skills parse. |
| Users without pstack get weaker reviews | Low | Every `/pstack:` call has a fallback (PSTACK001 enforces it), and the doctor hint gives the one-line install. |
| Auto-logged decisions create noise | Low | Only tool calls that carry a user choice log; polling and read-only calls never do. `flywheel_observe` shows the count so noise is visible. |
| `--agy` in `install.sh` writes outside `~/.claude` | Low | It's off by default and opt-in by flag, it prints what it will install before running `agy plugin install`, and it's a no-op when agy is absent. |
| `fix-bug` v2 changes calibration | Low | Versioned template; calibration groups by id, so v1 and v2 history stay in one bucket on purpose, and the CHANGELOG notes it. |

---

## 12. Explicitly out of scope for v1 (future direction)

- Moving `scripts/opencode/{transforms,validate}.mjs` into a shared `scripts/port/` library (do it when a third harness arrives).
- Lexical harness-tool rewrites in skill bodies for agy (revisit after S1 confirms tool names and the glossary rule proves insufficient).
- An automated `/correct` loop that turns `prose-only` enforcement rows into lint rules.
- pstack's `orch` CLI, `watch-pr`, `benny` automations, and overnight `autopilot-*` playbooks, which presume per-unit PRs the flywheel doesn't create.
- Formal verification skill generation (`create-formal-verification-skill`), which is reachable through the peer plugin.
- A fourth model-diversity provider for agy (see §5.1).

## 13. Contradictions and under-specified items to resolve in synthesis

1. **"agy CLI on gemini-4-argon" vs v3.22.0 "the gemini CLI never starts; Gemini runs only through Pi on the gateway".** These conflict unless agy is framed as a second transport (§5.2), and AGENTS.md needs an explicit amendment either way.
2. **"First-class xai/grok-4.7 routing in `model-detection.ts`" vs v3.21.0 "the plugin doesn't pin Pi models".** The pstack strings are Cursor model ids. §5.4 closes this through the existing picker plus a test.
3. **"Bundling `how`, `why`, `architect`, … " vs the user already having pstack installed, and the bundle dropping `references/`.** §7.1 recommends the peer plugin.
4. **"`check-plan.mjs` exits 0"** names no input file, and the tool rejects every flywheel plan format (§1.2). §7.5 ports the rule that matters.
5. **"`agy-prompt.ts`"** would duplicate `adaptPromptForGemini` (§5.2).
6. **"`bug-fix` template"** would collide with `fix-bug` (§7.4).
7. **"SHA-keyed ledger"** needs a key for beads without PRs. §7.2 uses the bead id plus server-computed patch-ids inside the existing completion report.
8. **The harness translation names (`invoke_subagent`, `ask_question`, `define_subagent`)** are unverified against agy 1.4.4. Spike S1 owns that.
9. **"Restored" Random Exploration / Cross-Agent gates.** Nothing in git history shows they existed as code (only `tender.ts`'s timer does). This is new surface, and the CHANGELOG should say "added".
