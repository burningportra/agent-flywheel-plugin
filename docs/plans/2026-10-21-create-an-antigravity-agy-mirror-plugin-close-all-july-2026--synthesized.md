# Synthesized Deep Implementation Plan: Antigravity (`agy`) Mirror Plugin + July 2026 Complete Flywheel Guide Parity + Deep `pstack` (`poteto-mode`) Integration

- **Goal**: Create an Antigravity (`agy`) mirror plugin for `agent-flywheel-plugin`, close all gaps compared to the live July 17, 2026 Complete Flywheel Guide (`https://agent-flywheel.com/complete-guide`), and deeply incorporate Poteto's `pstack` (`https://github.com/cursor/plugins/tree/main/pstack`) following the flywheel method.
- **Date**: 2026-10-21
- **Goal Slug**: `create-an-antigravity-agy-mirror-plugin-close-all-july-2026-`
- **Brainstorm Source**: `docs/brainstorms/create-an-antigravity-agy-mirror-plugin-close-all-july-2026--2026-10-21.md`
- **Source Perspective Plans**:
  - `docs/plans/2026-10-21-correctness.md` (553 lines — `RoseFrog`, Claude Opus 5.5)
  - `docs/plans/2026-10-21-ergonomics.md` (476 lines — Claude Opus 5.5)
  - `docs/plans/2026-10-21-robustness.md` (408 lines — Pi `meta/muse-wonder-1.0`)

---

## 1. Perspective Synthesis & Attribution

### 1.1 Correctness Plan (`docs/plans/2026-10-21-correctness.md`) — Strongest & Unique Contributions
- **Empirical Verification Against Installed `agy` 1.4.4 & `ntm` v1.37.2**: Proved by direct CLI probing that:
  1. `agy plugin validate <dir> --strict --json` exists on this host and validates `.agy-plugin/plugin.json` against a strict 7-field schema (`name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `disabled` — rejecting `skills`, `commands`, `hooks`, `mcpServers`, `author`, `repository`, `license`, `keywords`).
  2. `agy` silently truncates `rules/*.md` files at **24,000 bytes** (`AGENTS.md` is 68,958 bytes).
  3. `agy` `hooks.json` must live at the plugin root (`hooks.json`, not `hooks/hooks.json`), uses flat event objects (`BeforeTool`, `AfterTool`, `UserPromptSubmit`, `SessionStart`, `Stop`), matches `run_command` instead of `Bash`, and requires structured JSON stdout (`{"decision":"allow"}` / `{"decision":"deny","reason":"..."}`).
  4. `agy models` outputs effort-suffixed slugs (`gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-4-argon-high`, no bare `gemini-4-argon`).
- **Discovery of Bug in Working-Tree WIP**: Identified that uncommitted edits in `mcp-server/src/swarm-spawn.ts` set `AGY_LANE_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._ ()-]*$/` (allowing spaces/parentheses like `Gemini 4 Argon (High)`) and applied that loose regex inside `laneCount()` for *all* lanes. Provided the exact fix (`^[a-z0-9][a-z0-9.-]*$` + `resolveAgySlug`).
- **SHA-Coupled + Patch-ID Equivalent Verification**: Designed `git diff <baseSha>..<headSha> | git patch-id --stable` equivalence so rebases with identical patch content preserve verification while any real code delta invalidates prior verification.

### 1.2 Ergonomics Plan (`docs/plans/2026-10-21-ergonomics.md`) — Strongest & Unique Contributions
- **Discovery of `pstack` Sub-Asset Stripping in `build-skills-bundle.ts`**: Proved by measurement that `pstack` contains **56 skill directories** (`208,543` bytes of `SKILL.md` plus `436,582` bytes of `references/` and `scripts/` subdirectories), that `mcp-server/scripts/build-skills-bundle.ts` only bundles top-level `SKILL.md` files (stripping `references/` and `scripts/` that `pstack`'s `interrogate`, `architect`, `why`, and `poteto-mode` skills read), and that `pstack` validates with **0 errors and 0 warnings** via `agy plugin validate --strict --json`.
- **Zero-Friction User Menus & Tool Consolidation**: Designed `poteto-mode` as a first-class row in existing Step 0.preflight and Step 5 menus (`AskUserQuestion`) rather than forcing new top-level MCP tool proliferation, and folded `Verify, unit / live / perf` scoring into `flywheel_approve_beads` quality metrics.
- **Condensed `agy/rules/AGENTS.md` with Harness-Translation Glossary**: Designed a ≤ 20 KB rules file that includes a translation table mapping Claude Code tool names (`AskUserQuestion` → `ask_question`, `Bash` → `run_command`, `Agent()` → `invoke_subagent`) so rewritten `skills/flywheel-*/SKILL.md` bodies work seamlessly in Antigravity without breaking `SKILL001`–`SKILL018` lint rules.

### 1.3 Robustness Plan (`docs/plans/2026-10-21-robustness.md`) — Strongest & Unique Contributions
- **Crash-Safe Atomic File Writes & Symlink Traversal Guards**: Specified `writeAtomic` (temp file + `fs.renameSync`), `fs.realpathSync` containment checks for `flywheel_emit_agy`, and `withCheckLock` mutex protection for `agy_port_sync` remediation.
- **Degraded-Mode Fallbacks Across All External CLI Boundaries**: Specified graceful degradation when `agy`, `ntm --agy`, or `bv --robot-*` are absent or time out (`AbortSignal` propagation + explicit `timeout` on every `exec()` call), plus deterministic loop caps (`MAX_POLISH_ROUNDS = 6`, `MAX_FRESH_EYES_ROUNDS = 5`, `MAX_VERIFICATION_RETRIES = 3`).
- **Self-Annealing CASS Memory Rule Generation**: Designed the Step 7/Step 9 feedback loop where any `verification-failed` or peer-review rejection automatically drafts a scoped prevention rule via `flywheel_memory({ operation: "store" })` and appends to `.pi-flywheel/ledger.tsv`.

---

## 2. Three-Tier Agreement Report (Complete Guide Step 5.4 Parity)

### Tier 1 — Wholeheartedly Agree (All 3 Planners Converged)
1. **AGY Mirror Port Architecture**: `agy/manifest.json` + `scripts/sync-agy.sh` + `scripts/agy/{sync,rewrite-body,emit-hooks,validate}.mjs` mirroring `opencode/manifest.json` and `scripts/sync-opencode.sh` (`--check`, `--write`, `--prune`, `--json` with `[OK]`, `[ADD]`, `[UPDATE]`, `[LOCAL]`, `[PRUNE]` status tags and timestamped `.bak` backups).
2. **AGY Strict Plugin & Hook Contracts**:
   - `.agy-plugin/plugin.json` contains only the 7 permitted fields (`name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, `disabled`).
   - `.mcp.json` and `hooks.json` live at the plugin root (`~/.gemini/antigravity/plugins/agent-flywheel/`).
   - `hooks.json` uses flat event handlers (`BeforeTool`, `AfterTool`, `UserPromptSubmit`, `SessionStart`, `Stop`) matching `run_command` and outputting JSON (`{"decision":"allow"|"deny"}`).
   - `agy/rules/AGENTS.md` is byte-budgeted ≤ 24,000 bytes and validated by `scripts/agy/validate.mjs` + `agy plugin validate --strict --json`.
3. **Working-Tree `swarm-spawn.ts` Bug Fix**: Tighten `AGY_LANE_VALUE_PATTERN` to `^[a-z0-9][a-z0-9.-]*$`, keep `laneCount()` strict for non-`agy` lanes, add `resolveAgySlug()` (`gemini-4-argon` → `gemini-4-argon-high`), and probe `ntm spawn --help` for `--agy`.
4. **Complete Flywheel Guide Gap Closures**:
   - **Step 0.preflight**: Structured 6-category interview (`Users & Personas`, `Core Value & MVP`, `Technical Stack & Constraints`, `Integrations & Data`, `Scale & Performance`, `Risks & Non-Goals`) + mandatory pre-code research checklist (`architecture`, `dependencies`, `security`, `performance`).
   - **Step 5.4**: 3-tier synthesis agreement report (`Wholeheartedly agree`, `Somewhat agree`, `Disagree`) + git-diff style change table.
   - **Step 6**: 6× Polish iterative bead convergence loop (`flywheel_approve_beads(action: "converge-polish")`, max 6 rounds or 2 consecutive zero-delta passes) + `bv --robot-triage | --robot-next | --robot-plan | --robot-insights` integration.
   - **Step 7**: In-flight prompt (`skills/start/_inflight_prompt.md`) explicitly enforcing `AGENTS.md` re-read after compaction, Agent Mail heartbeat/reservation, `bv --robot-triage`, and self-annealing rule capture.
   - **Step 8**: Iterative fresh-eyes review loop (up to 5 rounds or 2 consecutive zero-finding passes) + cross-agent peer review (`implementer.modelFamily !== reviewer.modelFamily`).
5. **`pstack` (`poteto-mode`) Core Discipline**:
   - Hard verification state machine (`needs-verification` → `verified` | `verification-failed`) with `git patch-id --stable` equivalence and `.pi-flywheel/ledger.tsv` audit log.
   - 6-stage `poteto-mode` (`interrogate → architect → plan → red-green-implement → verify → ship`) enforcing `docs/specs/<slug>-interrogation.md` and `docs/architecture/<slug>-adr.md` before `flywheel_plan(poteto: true)`.
   - Plan Verification Triad (`Verify, unit`, `Verify, live`, `Verify, perf`) enforced on beads and checked by `scripts/check-bead-verify.mjs` + vendored `scripts/check-plan.mjs`.
   - Anti-rationalization guardrails in implementer and verifier prompts.

### Tier 2 — Somewhat Agree (2 of 3 Planners Converged)
1. **`--agy` Model Diversity vs. Transport Seat (`Correctness` + `Ergonomics` vs. `Robustness`)**:
   - *Decision*: Keep `DispatchPlan.ratio` as the 3-family `{ claude, pi, gemini }` tuple so existing callers and tests never break, add `ratioByLane: { cc, pi, gmi, agy }`, and use `--agy` as the preferred native NTM transport for the Gemini seat when `agy` and `ntm --agy` are healthy (falling back to `gmi` → `pi` → `cc`).
2. **Verification Evidence Storage (`Ergonomics` + `Robustness` vs. `Correctness`)**:
   - *Decision*: Extend `CompletionReportSchemaV1` (`mcp-server/src/completion-report.ts`) additively with optional `verification?: { verdict, headSha, baseSha, patchId, verifier, verifiedAt, evidence }` AND append every transition to `.pi-flywheel/ledger.tsv`. When `potetoGateEnabled` is active, require `verification.verifier.agentName !== agentName` (or an independent `flywheel_approve_beads(action: "verify-bead")` pass) before `flywheel_advance_wave` closes the wave.

### Tier 3 — Disagree / Contested (Surfaced for User Confirmation in Step 5.55)
1. **`pstack` Skill Delivery (`Correctness` + `Robustness` full vendoring vs. `Ergonomics` peer plugin)**:
   - *Measured facts*: `pstack` has **56** skills (0 name collisions with our 42 skills; `208,543` bytes of `SKILL.md` + `436,582` bytes of `references/` and `scripts/`). `pstack` validates natively in AGY with 0 errors.
   - *Synthesized recommendation*: **Hybrid Core-6 Bundle + Peer Plugin** — vendor the 6 foundational `pstack` skills (`poteto-mode`, `interrogate`, `architect`, `plan`, `verify`, `why`) and their `references/` + `scripts/check-plan.mjs` into `skills/` with `skills/PSTACK_VENDOR.json` SHA-256 provenance, extend `build-skills-bundle.ts` to bundle `references/*.md`, and add a `pstack_plugin` doctor check for the full 56-skill peer plugin. (User can choose Hybrid Core-6, Peer-Plugin-Only, or Full-56 Vendoring in Step 5.55).

### Git-Diff Summary of Synthesized Architecture Choices
```diff
+ agy/manifest.json, agy/plugin.json, agy/.mcp.json, agy/rules/AGENTS.md (<=24KB)
+ scripts/sync-agy.sh & scripts/agy/{sync,rewrite-body,emit-hooks,validate}.mjs
+ mcp-server/src/adapters/antigravity.ts (AntigravityAdapter + resolveAgySlug)
+ mcp-server/src/tools/emit-agy.ts (flywheel_emit_agy MCP tool)
! mcp-server/src/swarm-spawn.ts (fix AGY_LANE_VALUE_PATTERN bug, keep laneCount strict, probe ntm --agy)
! mcp-server/src/model-detection.ts (keep 3-family ratio {claude,pi,gemini} + add ratioByLane {cc,pi,gmi,agy})
! mcp-server/src/completion-report.ts (additive verification block + git patch-id --stable + .pi-flywheel/ledger.tsv)
+ mcp-server/src/bv-runner.ts (typed bv --robot-triage|--robot-next|--robot-plan|--robot-insights wrapper)
! mcp-server/src/tools/{plan,approve-beads,advance-wave,review,doctor,remediate}.ts (poteto-mode, 6x polish, verify gate, iterative + cross-agent review, agy_cli + agy_port_sync + pstack_plugin checks)
+ scripts/check-plan.mjs (vendored pstack verifier) & scripts/check-bead-verify.mjs (Flywheel bead triad verifier)
- Rejected: 4-field breaking change to DispatchPlan.ratio (preserves backwards compatibility)
- Rejected: Unbounded polish/review loops (capped at 6 polish rounds, 5 review rounds)
```

---

## 3. Architecture & File Inventory

### 3.1 New Files to Create
| Path | Responsibility |
|---|---|
| `agy/manifest.json` | Ownership manifest for the AGY mirror port (`schemaVersion: 1`, target `~/.gemini/antigravity/plugins/agent-flywheel`, `rulesMaxBytes: 24000`, `skills`, `commands`, `hooks`, `rules`). |
| `agy/plugin.json` | Strict 7-field AGY plugin manifest template (`name`, `displayName`, `version`, `description`, `logo`, `suggestedPrompts`, `disabled`). |
| `agy/.mcp.json` | Root MCP stdio config pointing at `${PLUGIN_ROOT}/mcp-server/dist/server.js`. |
| `agy/rules/AGENTS.md` | Condensed ≤ 24,000-byte rules file + Claude-to-AGY tool glossary (`AskUserQuestion` → `ask_question`, `Bash` → `run_command`, `Agent()` → `invoke_subagent`). |
| `scripts/sync-agy.sh` | Operator entrypoint (`--check`, `--write`, `--prune`, `--json`, `--target`, `--backup-dir`). |
| `scripts/agy/sync.mjs` | Deterministic sync engine with `[OK]`, `[ADD]`, `[UPDATE]`, `[LOCAL]`, `[PRUNE]` classification, SHA-256 manifest state, and `.bak` backups. |
| `scripts/agy/rewrite-body.mjs` | Body/frontmatter transformer for commands → `skills/cmd-<name>/SKILL.md` and `CLAUDE_PLUGIN_ROOT` path rewriting. |
| `scripts/agy/emit-hooks.mjs` | Translates `hooks/hooks.json` into flat AGY root `hooks.json` + JSON-stdout wrapper scripts (`session-start.sh`, `prompt-submit.sh`, `pre-Command-guard.sh`, `post-Command-beads.sh`, `stop-finalize.sh`). |
| `scripts/agy/validate.mjs` | Validates generated tree (7-field `plugin.json`, `rules/*.md` ≤ 24,000 bytes, hook JSON schema, skill frontmatter, and delegates to `agy plugin validate --strict --json` when `agy` is installed). |
| `docs/agy.md` | Operator workflow guide for the Antigravity mirror plugin (first sync, update flow, `--agy` swarm lanes, troubleshooting). |
| `mcp-server/src/adapters/antigravity.ts` | `AntigravityAdapter`: `detectAgyCli`, `probeAgyModels`, `resolveAgySlug`, `buildAgyNtmArgs`. |
| `mcp-server/src/tools/emit-agy.ts` | `flywheel_emit_agy({ cwd, targetDir, mode })` MCP tool with `realpath` containment check. |
| `mcp-server/src/bv-runner.ts` | Typed runner for `bv --robot-triage`, `--robot-next`, `--robot-plan`, `--robot-insights` with timeout + `AbortSignal` + graceful fallback. |
| `scripts/check-plan.mjs` | Vendored `pstack` PR-program plan validator (`--strict`, `--json`). |
| `scripts/check-bead-verify.mjs` | Flywheel plan & bead validator enforcing `Verify, unit`, `Verify, live`, `Verify, perf` commands (`--strict`, `--json`). |
| `skills/PSTACK_VENDOR.json` | Provenance manifest (`upstreamRepo`, `upstreamCommit`, `vendoredAt`, per-file SHA-256) for vendored `pstack` skills/scripts. |

### 3.2 Existing Files to Modify
| Path | Modification |
|---|---|
| `mcp-server/src/swarm-spawn.ts` | Fix `AGY_LANE_VALUE_PATTERN` (`^[a-z0-9][a-z0-9.-]*$`), restore strict `laneCount()` for non-`agy` lanes, add `resolveAgySlug`, probe `ntm spawn --help` for `--agy`. |
| `mcp-server/src/model-detection.ts` | Keep 3-field `ratio: { claude, pi, gemini }`, add `ratioByLane: { cc, pi, gmi, agy }`, route Gemini seat to `agy` when `agy_cli` + `ntm --agy` are green. |
| `mcp-server/src/state.ts` | Add optional `potetoMode`, `interrogationDocPath`, `architectureDocPath`, `preCodeResearch`, `polishRound`, `polishConverged`, `reviewIterations`, `verificationLedgerPath` to `CheckpointState`. |
| `mcp-server/src/completion-report.ts` | Add optional `verification` block (`verdict`, `headSha`, `baseSha`, `patchId`, `verifier`, `verifiedAt`, `evidence`), `computePatchId()`, and `.pi-flywheel/ledger.tsv` append helper. |
| `mcp-server/src/adapters/completion-attestation-prompt.ts` | Inject anti-rationalization guardrails, `Verify, unit / live / perf` execution requirement, and `needs-verification` attestation fields into implementer prompts. |
| `mcp-server/src/tools/plan.ts` | Support `poteto?: boolean`, enforce interrogation + ADR prerequisites (`poteto_prerequisite_missing`), and enforce pre-code research checklist (`pre_code_research_incomplete`). |
| `mcp-server/src/tools/approve-beads.ts` | Add `action: "converge-polish"` (6× Polish loop), `action: "verify-bead"` (independent SHA + patch-id verification + ledger write), `bv --robot-*` enrichment, and `Verify, unit / live / perf` triad scoring. |
| `mcp-server/src/tools/advance-wave.ts` | Enforce `verification.verdict === "verified"` and SHA/patch-id match when `potetoMode` or `FW_VERIFICATION_REQUIRED=1` is active (`verification_missing`, `verification_failed`, `verification_sha_drift`). |
| `mcp-server/src/tools/review.ts` | Add `action: "converge"` (iterative fresh-eyes loop, max 5 rounds / 2 clean rounds) and `action: "cross-agent"` (cross-family reviewer assignment). |
| `mcp-server/src/tools/doctor.ts` | Add `agy_cli`, `agy_port_sync`, and `pstack_plugin` doctor checks; surface `--agy` in `data.report.swarm`. |
| `mcp-server/src/tools/remediate.ts` | Add `agy_port_sync` remediation handler (`scripts/sync-agy.sh --write`). |
| `mcp-server/src/server.ts` | Register `flywheel_emit_agy` and updated tool schemas. |
| `mcp-server/scripts/build-skills-bundle.ts` | Support bundling optional `references/*.md` under each skill and raise bundle budget guard cleanly. |
| `skills/start/{SKILL,_planning,_beads,_implement,_inflight_prompt,_review,_wrapup}.md` | Wire Step 0.preflight 6-category interview + pre-code research + `poteto-mode` option, Step 5.4 3-tier synthesis report, Step 6 6× Polish + `bv --robot-*`, Step 7 in-flight prompt, Step 8 iterative + cross-agent review, Step 9 ledger audit. |

---

## 4. Wave-Ordered Bead Specification

### Wave 0: Working-Tree Stabilization & Core Type/State Substrate

#### Bead W0.1 — Stabilize `--agy` lane parsing in `swarm-spawn.ts` and `pane001.ts`
- **Template**: `bug-fix`
- **Complexity**: `M`
- **Depends On**: none
- **Scope**:
  - `mcp-server/src/swarm-spawn.ts`
  - `mcp-server/src/lint/rules/pane001.ts`
  - `mcp-server/src/__tests__/swarm-spawn.test.ts`
  - `mcp-server/src/__tests__/lint/pane001.test.ts`
- **Description**: Fix the working-tree `AGY_LANE_VALUE_PATTERN` bug so `--agy` only accepts valid `COUNT[:model[:effort]]` tokens (`^[a-z0-9][a-z0-9.-]*$` for model slug and `^(low|medium|high|xhigh|max)$` for effort), prevent `laneCount()` from loosening validation on `--cc`/`--cod`/`--gmi`/`--pi`, add `resolveAgySlug()` mapping `gemini-4-argon` + effort to `gemini-4-argon-high`, and verify `ntm spawn --help` advertises `--agy` before passing `--agy` to `ntm spawn`.
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/swarm-spawn.test.ts src/__tests__/lint/pane001.test.ts`
- **Verify, live**: `node mcp-server/dist/scripts/swarm-spawn.js --help`
- **Verify, perf**: `node -e 'const t0=Date.now(); require("./mcp-server/dist/swarm-spawn.js"); if(Date.now()-t0>200) process.exit(1)'`

#### Bead W0.2 — Extend `CheckpointState`, `CompletionReportSchemaV1`, and `.pi-flywheel/ledger.tsv`
- **Template**: `feature-module`
- **Complexity**: `M`
- **Depends On**: none
- **Scope**:
  - `mcp-server/src/state.ts`
  - `mcp-server/src/completion-report.ts`
  - `mcp-server/src/errors.ts`
  - `mcp-server/src/__tests__/completion-report.test.ts`
- **Description**: Add optional `potetoMode`, `interrogationDocPath`, `architectureDocPath`, `preCodeResearch`, `polishRound`, `polishConverged`, `reviewIterations`, and `verificationLedgerPath` fields to `CheckpointState`. Extend `CompletionReportSchemaV1` additively with `verification?: { verdict: "needs-verification" | "verified" | "verification-failed", headSha, baseSha?, patchId?, verifier?, verifiedAt?, failureReason?, evidence? }`, implement `computePatchId(cwd, baseSha, headSha, exec)` via `git diff <base>..<head> | git patch-id --stable`, implement atomic `.pi-flywheel/ledger.tsv` append/read helpers, and register new error codes (`poteto_prerequisite_missing`, `pre_code_research_incomplete`, `verification_missing`, `verification_failed`, `verification_sha_drift`).
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/completion-report.test.ts`
- **Verify, live**: `node -e 'import("./mcp-server/dist/completion-report.js").then(m => { if(!m.CompletionReportSchemaV1) process.exit(1); })'`
- **Verify, perf**: `npm --prefix mcp-server test -- src/__tests__/completion-report.test.ts` (suite runtime < 2000ms)

---

### Wave 1: Antigravity (`agy`) Mirror Port & Adapter

#### Bead W1.1 — Build `agy/` mirror templates, `scripts/sync-agy.sh`, and `scripts/agy/*.mjs`
- **Template**: `feature-module`
- **Complexity**: `L`
- **Depends On**: `W0.1`
- **Scope**:
  - `agy/manifest.json`
  - `agy/plugin.json`
  - `agy/.mcp.json`
  - `agy/rules/AGENTS.md`
  - `scripts/sync-agy.sh`
  - `scripts/agy/sync.mjs`
  - `scripts/agy/rewrite-body.mjs`
  - `scripts/agy/emit-hooks.mjs`
  - `scripts/agy/validate.mjs`
  - `docs/agy.md`
  - `mcp-server/src/__tests__/agy-sync.test.ts`
- **Description**: Implement the Antigravity mirror port modeled on `opencode/manifest.json` and `scripts/sync-opencode.sh`. Generate `.agy-plugin/plugin.json` (strict 7-field schema), root `.mcp.json`, root `hooks.json` + JSON-stdout hook scripts (`BeforeTool`/`AfterTool` on `run_command`), condensed `rules/AGENTS.md` (≤ 24,000 bytes with Claude-to-AGY tool translation glossary), and rewritten skills/commands. Validate with `scripts/agy/validate.mjs` and `agy plugin validate <dir> --strict --json`.
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/agy-sync.test.ts`
- **Verify, live**: `bash scripts/sync-agy.sh --write --target /tmp/fw-agy-verify && agy plugin validate /tmp/fw-agy-verify --strict --json && bash scripts/sync-agy.sh --check --target /tmp/fw-agy-verify`
- **Verify, perf**: `node -e 'const {execSync}=require("child_process"); const t0=Date.now(); execSync("bash scripts/sync-agy.sh --check --target /tmp/fw-agy-verify"); if(Date.now()-t0>1500) process.exit(1);'`

#### Bead W1.2 — Implement `AntigravityAdapter`, `flywheel_emit_agy`, and `agy_cli` / `agy_port_sync` doctor & remediation
- **Template**: `cli-integration`
- **Complexity**: `M`
- **Depends On**: `W0.1`, `W1.1`
- **Scope**:
  - `mcp-server/src/adapters/antigravity.ts`
  - `mcp-server/src/model-detection.ts`
  - `mcp-server/src/tools/emit-agy.ts`
  - `mcp-server/src/tools/doctor.ts`
  - `mcp-server/src/tools/remediate.ts`
  - `mcp-server/src/server.ts`
  - `mcp-server/src/__tests__/antigravity-adapter.test.ts`
- **Description**: Create `AntigravityAdapter` (`detectAgyCli`, `probeAgyModels`, `resolveAgySlug`), update `model-detection.ts` to keep 3-field `ratio: { claude, pi, gemini }` while adding `ratioByLane: { cc, pi, gmi, agy }` and routing the Gemini seat to `--agy` when healthy, register `flywheel_emit_agy({ cwd, targetDir, mode })` with `realpath` containment checks, add `agy_cli` and `agy_port_sync` checks to `flywheel_doctor`, and add `agy_port_sync` remediation to `flywheel_remediate`.
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/antigravity-adapter.test.ts`
- **Verify, live**: `node /Users/kevtrinh/.gemini/antigravity-cli/brain/3fad1e87-42fa-4888-9c91-13c33b2abd43/scratch/fw.mjs flywheel_doctor '{"cwd":"/Volumes/1tb/Projects/agent-flywheel-plugin"}'`
- **Verify, perf**: `flywheel_doctor` probe latency for `agy_cli` + `agy_port_sync` < 500ms.

---

### Wave 2: `pstack` (`poteto-mode`) Verification Gate, Plan Verifiers & Skill Integration

#### Bead W2.1 — Vendor `pstack` core skills + `check-plan.mjs`, build `check-bead-verify.mjs`, and extend `build-skills-bundle.ts`
- **Template**: `feature-module`
- **Complexity**: `M`
- **Depends On**: `W0.2`
- **Scope**:
  - `scripts/check-plan.mjs`
  - `scripts/check-bead-verify.mjs`
  - `skills/PSTACK_VENDOR.json`
  - `mcp-server/scripts/build-skills-bundle.ts`
  - `mcp-server/src/tools/doctor.ts`
  - `mcp-server/src/__tests__/check-bead-verify.test.ts`
- **Description**: Vendor `pstack` skills/scripts per the Step 5.55 alignment choice with `skills/PSTACK_VENDOR.json` SHA-256 provenance, extend `build-skills-bundle.ts` so `references/*.md` files inside skills are preserved in `skills.bundle.json`, create `scripts/check-bead-verify.mjs` to validate `Verify, unit / live / perf` commands on Flywheel plans and open beads, and add the `pstack_plugin` doctor check.
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/check-bead-verify.test.ts`
- **Verify, live**: `node scripts/check-bead-verify.mjs docs/plans/2026-10-21-create-an-antigravity-agy-mirror-plugin-close-all-july-2026--synthesized.md --json`
- **Verify, perf**: `npm --prefix mcp-server run check:skills-bundle` (< 1500ms)

#### Bead W2.2 — Wire `poteto-mode` prerequisites, Hard Verification Gate, and Anti-Rationalization Prompts into MCP Tools
- **Template**: `feature-module`
- **Complexity**: `L`
- **Depends On**: `W0.2`, `W2.1`
- **Scope**:
  - `mcp-server/src/tools/plan.ts`
  - `mcp-server/src/tools/approve-beads.ts`
  - `mcp-server/src/tools/advance-wave.ts`
  - `mcp-server/src/adapters/completion-attestation-prompt.ts`
  - `mcp-server/src/__tests__/poteto-verification-gate.test.ts`
- **Description**: Add `poteto?: boolean` and `preCodeResearch` validation to `flywheel_plan` (enforcing `docs/specs/<slug>-interrogation.md` and `docs/architecture/<slug>-adr.md` when `poteto: true`). Add `action: "verify-bead"` to `flywheel_approve_beads` to run `Verify, unit / live / perf` commands, verify SHA + `git patch-id --stable` equivalence, record independent `verifier` identity, and append to `.pi-flywheel/ledger.tsv`. Enforce `verification.verdict === "verified"` in `flywheel_advance_wave` when `potetoMode` or `FW_VERIFICATION_REQUIRED=1` is active, and inject anti-rationalization rules into `completion-attestation-prompt.ts`.
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/poteto-verification-gate.test.ts`
- **Verify, live**: `node /Users/kevtrinh/.gemini/antigravity-cli/brain/3fad1e87-42fa-4888-9c91-13c33b2abd43/scratch/fw.mjs flywheel_verify_beads '{"cwd":"/Volumes/1tb/Projects/agent-flywheel-plugin"}'`
- **Verify, perf**: `npm --prefix mcp-server test -- src/__tests__/poteto-verification-gate.test.ts` (< 2000ms)

---

### Wave 3: Complete Flywheel Guide Parity (6× Polish, `bv --robot-*`, Iterative & Cross-Agent Review)

#### Bead W3.1 — Implement `bv-runner.ts` (`bv --robot-*`) and 6× Polish Convergence Loop in `approve-beads.ts`
- **Template**: `feature-module`
- **Complexity**: `M`
- **Depends On**: `W0.2`
- **Scope**:
  - `mcp-server/src/bv-runner.ts`
  - `mcp-server/src/tools/approve-beads.ts`
  - `mcp-server/src/__tests__/bv-runner.test.ts`
  - `mcp-server/src/__tests__/approve-beads-polish.test.ts`
- **Description**: Create `mcp-server/src/bv-runner.ts` wrapping `bv --robot-triage`, `--robot-next`, `--robot-plan`, and `--robot-insights` with timeout + `AbortSignal` + graceful fallback when `bv` is absent. Add `action: "converge-polish"` to `flywheel_approve_beads` implementing the Complete Guide's 6-round bead polish convergence loop (`polishRound` 1..6, early exit on 2 consecutive zero-change rounds), and enrich the `flywheel_approve_beads` response with `bvInsights` and `Verify, unit / live / perf` triad coverage.
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/bv-runner.test.ts src/__tests__/approve-beads-polish.test.ts`
- **Verify, live**: `node /Users/kevtrinh/.gemini/antigravity-cli/brain/3fad1e87-42fa-4888-9c91-13c33b2abd43/scratch/fw.mjs flywheel_approve_beads '{"cwd":"/Volumes/1tb/Projects/agent-flywheel-plugin","action":"converge-polish"}'`
- **Verify, perf**: `bv-runner` fallback/exec timeout bounded ≤ 3000ms.

#### Bead W3.2 — Implement Iterative Fresh-Eyes Convergence and Cross-Agent Peer Review in `review.ts`
- **Template**: `feature-module`
- **Complexity**: `M`
- **Depends On**: `W0.2`
- **Scope**:
  - `mcp-server/src/tools/review.ts`
  - `mcp-server/src/__tests__/review-converge-cross-agent.test.ts`
- **Description**: Extend `flywheel_review` with `action: "converge"` (tracking per-bead `reviewIterations[beadId]`, terminating on 2 consecutive zero-finding passes or max 5 rounds) and `action: "cross-agent"` (selecting a healthy reviewer lane whose model family differs from the implementer recorded in `.pi-flywheel/completion/<beadId>.json`, with self-annealing CASS rule draft on rejection).
- **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/review-converge-cross-agent.test.ts`
- **Verify, live**: `node /Users/kevtrinh/.gemini/antigravity-cli/brain/3fad1e87-42fa-4888-9c91-13c33b2abd43/scratch/fw.mjs flywheel_review '{"cwd":"/Volumes/1tb/Projects/agent-flywheel-plugin","action":"status"}'`
- **Verify, perf**: `npm --prefix mcp-server test -- src/__tests__/review-converge-cross-agent.test.ts` (< 2000ms)

---

### Wave 4: Workflow Skill Integration, End-to-End Wiring & Bundle Sync

#### Bead W4.1 — Update `skills/start/*.md`, `AGENTS.md`, rebuild `dist/` + `skills.bundle.json`, and run E2E sync verification
- **Template**: `workflow-skill`
- **Complexity**: `M`
- **Depends On**: `W1.1`, `W1.2`, `W2.1`, `W2.2`, `W3.1`, `W3.2`
- **Scope**:
  - `skills/start/SKILL.md`
  - `skills/start/_planning.md`
  - `skills/start/_beads.md`
  - `skills/start/_implement.md`
  - `skills/start/_inflight_prompt.md`
  - `skills/start/_review.md`
  - `skills/start/_wrapup.md`
  - `AGENTS.md`
  - `mcp-server/dist/`
- **Description**: Update the `/start` phase skills with the Complete Guide 6-category interview, pre-code research checklist, `poteto-mode` menu option, 3-tier synthesis report, 6× Polish loop + `bv --robot-*` triage, in-flight prompt (`AGENTS.md` + `bv --robot-triage` + self-annealing CASS rules), iterative fresh-eyes + cross-agent review, and wrap-up `.pi-flywheel/ledger.tsv` audit. Update `AGENTS.md` quick reference, run `cd mcp-server && npm run build`, run `npm run lint:skills`, and verify both `scripts/sync-opencode.sh --check` and `scripts/sync-agy.sh --write && agy plugin validate --strict --json`.
- **Verify, unit**: `npm --prefix mcp-server test && npm --prefix mcp-server run lint:skills`
- **Verify, live**: `cd mcp-server && npm run build && npm run check:skills-bundle && bash ../scripts/sync-agy.sh --write --target /tmp/fw-agy-e2e && agy plugin validate /tmp/fw-agy-e2e --strict --json`
- **Verify, perf**: `npm --prefix mcp-server run lint:skills` (< 5000ms)
