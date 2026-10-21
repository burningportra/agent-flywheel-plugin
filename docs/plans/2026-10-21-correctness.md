# AGY mirror, July 2026 guide gaps, and pstack integration: correctness plan

**Date:** 2026-10-21
**Goal slug:** `create-an-antigravity-agy-mirror-plugin-close-all-july-2026-`
**Planner lens:** correctness (type safety, Zod schemas, invariants, edge cases, error handling, data integrity)
**Planner:** RoseFrog (claude-opus-5-5), deep-plan correctness seat
**Inputs read:** the planner brief and Phase 0.5 brainstorm, `mcp-server/src/` (completion-report, gates, review gate loop, model-diversity, swarm-spawn and its uncommitted diff, model-detection, bead-templates, flywheel-config, exec, errors, platform adapters, skills-bundle builder), `scripts/opencode/*`, `hooks/hooks.json`, `AGENTS.md`, the cloned pstack tree (`poteto-mode` SKILL and playbooks, `check-plan.mjs`, `orch/store.ts`, `show-me-your-work/scripts/log.sh`, `setup-pstack`, `interrogate`, `unslop`, `architect/references/design-red-flags.md`), the live Complete Guide text, Antigravity's built-in `agy-customizations` and `plugin` skills, and the installed `agy` 1.4.4 and `ntm` v1.37.2 CLIs.

---

## 1. Executive summary

The goal joins three surfaces (an Antigravity mirror, the July 2026 guide gaps, and pstack), and most of its risk sits at the seams between them: a file format one harness accepts and another silently rewrites, a count one document states and the source contradicts, a key one ledger uses that the flywheel doesn't have. This plan keeps the brainstorm's scope floor and orders the work in four waves whose beads touch disjoint files, but every bead below is written around the invariant it must hold and the test that would catch its violation.

Reading the sources turned up twelve facts that change what the other plans will probably assume. Each one becomes a bead or an acceptance criterion below.

1. **AGY truncates rule files at 24,000 bytes, and `AGENTS.md` is 68,958 bytes.** Copying `AGENTS.md` into the plugin's `rules/AGENTS.md` would ship a file AGY cuts off on a line boundary without an error, so an agent there would see the first third of the hard constraints and none of the swarm rules. The mirror needs a separately authored, byte-budgeted rules file with a `--check` failure past 24,000 bytes.
2. **AGY's `plugin.json` accepts seven fields and silently discards the rest.** `name`, `description`, `logo`, `suggestedPrompts`, `displayName`, `version`, and `disabled` load; `author` and `homepage` are dropped without an error. The sync has to validate the manifest against an exact schema, and `agy plugin validate <dir> --strict --json` exists on this host as a second gate.
3. **AGY hooks are a different contract, not a different file location.** `hooks.json` must sit at the plugin root, each handler must print a JSON object on stdout, the working directory is the folder holding `hooks.json`, tool matchers name AGY tools (`run_command`, not `Bash`), there is no `if` filter, no `SubagentStop`, and no compaction event. Every Claude hook in `hooks/hooks.json` needs an explicit translation or an explicit "not portable" entry, and the `pcr` post-compaction re-read has no AGY trigger at all.
4. **`agy models` lists effort-suffixed slugs.** The host reports `gemini-4-argon-low|medium|high` and no bare `gemini-4-argon`, and `agy` takes a separate `--effort` flag. A lane that passes `--model gemini-4-argon` is betting on an undocumented alias, so model and effort have to be carried as a typed pair and resolved against `agy models` output at the edge.
5. **Another agent already has an uncommitted `agy` lane in the working tree.** `swarm-spawn.ts`, `pane001.ts`, `lint-skill.ts`, `_implement.md`, `_planning.md`, and their tests and `dist/` carry it, unstaged, on top of `ec96fc1`. Its `AGY_LANE_VALUE_PATTERN` accepts spaces and parentheses, which admits display names such as `Gemini 4 Argon (High)` as model values. Wave 0 lands or hands off that work before any bead here touches those files.
6. **The installed ntm (v1.37.2, dirty build) has `--agy` and `--pi` lanes, while `AGENTS.md` still says ntm 1.36.1 has no `pi` lane.** Readiness checks must probe `ntm spawn --help` for the flag rather than compare version strings, because a dirty build's version string doesn't order.
7. **pstack's `check-plan.mjs` validates pstack's PR-program document shape, not a flywheel plan.** It requires `## Program checklist`, ten numbered live lanes with screenshots, a `## Close the program` section, and an appendix, and it fails any line with a long dash, a curly quote, or a mid-sentence colon. Run with no argument it exits 2. Every flywheel plan in `docs/plans/` would fail it, so the brief's "`node scripts/check-plan.mjs` exiting 0" needs a named target and a flywheel-shaped validator.
8. **pstack's ledger is keyed by `(pr, sha)`, and the patch-id rule exists only as prose in `playbooks/shipping.md`.** The flywheel has beads and commits, not PRs per unit, so the ledger has to be re-keyed on `(beadId, headSha)`, and the patch-id carry-forward rule has to be written as code with its edge cases (merge commits, empty patches, multi-commit beads) decided.
9. **The review gate loop persists a numeric `currentGateIndex` and wraps it with `% gateChecks.length`.** Adding the Random Exploration, Cross-Agent, and Interrogate gates changes the length, so a checkpoint saved mid-circuit resumes on a different gate without an error. Gates need stable ids and a legacy-index migration.
10. **`completionReportPath(cwd, beadId)` joins an unvalidated `beadId` into a path.** A bead id such as `../../x` writes outside `.pi-flywheel/completion/`. The new verification ledger and decision trail would copy the same pattern, so a shared id-and-path module comes first.
11. **`DispatchPlan.ratio` is a three-field `Claude:Pi:Gemini` string that doctor text, `describeCapabilities`, and docs parse.** Making `agy` a fourth primary lane changes it to four fields and breaks those readers. This plan seats `agy` as a second transport for the Gemini seat (same model family, so the three-vendor diversity invariant still holds) and adds a structured `ratioByLane` field instead of reshaping `ratio`.
12. **Several numbers in the brief need to be derived from source, not hard-coded.** The source confirms 24 `principle-*` skills (the poteto-mode index lists 10 + 6 + 5 + 2 + 1 = 24), 23 playbooks, 33 numbered unslop rules, and 8 design red flags. "4-bucket `lead-judgment.md`" is slightly off: the four buckets (Act on, Consider, Noted, Dismissed) are defined in `interrogate/SKILL.md` Step 5, while `lead-judgment.md` holds five filtering principles. Tests assert these counts against the vendored files so a later pstack update can't silently change them.

The bottom line for synthesis: build the shared primitives (ids, paths, model/effort pair, gate ids) before any feature, keep every new persisted format versioned and additive, give each concurrently written artifact a single writer per file, and treat every AGY format difference as a translation table with a test, not a copy.

---

## 2. Architecture overview

### 2.1 Components and the contract each one owns

| Component | Location | Contract it owns |
|---|---|---|
| Id and path primitives | `mcp-server/src/ids.ts` (new) | `BeadIdSchema`, `FullShaSchema`, `PlanSlugSchema`, `safeJoinUnder()`. Every on-disk path derived from external input goes through it. |
| Model and effort pair | `mcp-server/src/model-detection.ts` | `EffortLevel` ladder, `PstackBudget`, `ModelChoice = { family, model, effort }`, `budgetToEffort()`, `clampEffort()`; per-CLI rendering (`claude`, `pi --thinking`, `agy --model <slug> --effort`). |
| Lane routing | `mcp-server/src/adapters/model-diversity.ts`, `flywheel-config.ts` | `ModelProvider` gains `agy`; Gemini seat served by `gemini` (Pi on gateway) or `agy`; `ratio` unchanged, `ratioByLane` added. |
| AGY prompt adapter | `mcp-server/src/adapters/agy-prompt.ts` (new) | Terminal prompt for agy panes, Agent Mail through the `am` CLI unless MCP is proven. |
| pstack ORCH brief | `mcp-server/src/adapters/orch-brief.ts` (new) | `OrchBriefSchema` (nine fields), `renderOrchBrief()`, size-to-unit collapse rule; injected by the claude, codex, pi, gemini, and agy adapters. |
| Verification ledger | `mcp-server/src/verification-ledger.ts` (new) | `VerificationRecordSchemaV1`, one file per `(beadId, headSha)`, `evaluateVerification()` with the patch-id carry-forward rule. |
| Decision trail | `mcp-server/src/decision-trail.ts` (new) | Append-only `.pi-flywheel/decisions/<slug>.tsv`, header created with `O_EXCL`, one `write` per row under 4,096 bytes, cell sanitizer from `log.sh`. |
| Review gates | `mcp-server/src/gates.ts`, `mcp-server/src/tools/review.ts`, `types.ts` | `GATE_DEFINITIONS` keyed by id, `currentGateId` (additive), legacy index map, Random Exploration and Cross-Agent alternation state machine, Interrogate gate with the four buckets. |
| Cognitive operators | `mcp-server/src/operators.ts` (new), lint rule `OPER001` | The eight `[OPERATOR: ...]` ids from the guide, as a frozen tuple. |
| Playbook bead templates | `mcp-server/src/bead-templates.ts` | `hillclimb`, `runtime-forensics`, `trace-forensics`, `bug-fix-scientific`, each with a `verificationFloor`. |
| Platform adapter | `mcp-server/src/adapters/platform/AntigravityAdapter.ts` (new), `detect.ts` | `PlatformId = 'claude-code' \| 'antigravity'`, chosen by an explicit `FLYWHEEL_PLATFORM` env value the AGY `mcp_config.json` sets. |
| AGY mirror | `agy/manifest.json`, `agy/templates/`, `agy/rules/AGENTS.md`, `scripts/sync-agy.sh`, `scripts/agy/*.mjs` | Ownership boundary, transform profiles, hook translation table, byte budgets, `--check`/`--dry-run`/`--write`, `[LOCAL]` divergence. Reuses `scripts/opencode/apply.mjs` for lock, ledger, journal, and transaction. |
| Vendored pstack | `skills/<pstack-skill>/`, `skills/PSTACK_VENDOR.json`, `THIRD_PARTY_NOTICES.md` | Pinned upstream version and per-file sha256, recorded local patches, MIT notice. |
| Plan validators | `skills/poteto-mode/scripts/check-plan.mjs` (verbatim), `scripts/check-bead-verify.mjs` (new) | The verbatim pstack checker for pstack-shaped docs; a flywheel checker for bead `Verify, unit`/`Verify, live`/`Verify, perf` fields. |

### 2.2 Data-flow invariants that cross components

- **I1. One writer per file.** Completion reports are written by the bead owner, verification records by the verifier, decision rows by appenders through a single `appendFile` call each. No two actors rewrite the same file.
- **I2. Every persisted format is versioned and additive.** New JSON carries `version: 1`. New `FlywheelState` fields are optional, and a v3.25.x checkpoint loads with all of them undefined (extend `__tests__/migration.test.ts` with a frozen v3.25 fixture).
- **I3. External input is parsed at the boundary.** Bead ids, SHAs, slugs, model slugs, agy model lists, hook payloads, and vendored frontmatter are parsed with Zod or a regex before use. Internal code trusts the parsed types.
- **I4. The Gemini seat is one model family.** Whether it runs through Pi on the gateway (`gmi`) or the agy CLI (`agy`), it runs `gemini-4-argon` at some effort, so the Claude, Pi, and Gemini seats keep three independent reasoners.
- **I5. Counts in docs are derived.** Any count a doc or test states (principles, playbooks, unslop rules, red flags, operators, doctor checks, MCP tools) is asserted against the source by a test.
- **I6. Nothing the sync writes outside its ownership boundary.** The AGY sync owns exactly the files its manifest enumerates under `~/.gemini/config/plugins/agent-flywheel/`, and refuses a target that resolves (after `realpath`) outside that directory.

---

## 3. Shared definitions (normative)

These snippets are the contracts beads implement. Names are binding; bodies are illustrative.

### 3.1 Ids and paths (`mcp-server/src/ids.ts`)

```ts
export const BeadIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'bead id: letters, digits, . _ -, max 128')
  .refine((s) => !s.includes('..'), 'bead id must not contain ..');
export type BeadId = z.infer<typeof BeadIdSchema> & { readonly __brand: 'BeadId' };

export const FullShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'full lowercase SHA-1 or SHA-256');
export const PatchIdSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const PlanSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

/** Resolve segments under base and throw when the result escapes it (after path.resolve, before any I/O). */
export function safeJoinUnder(base: string, ...segments: string[]): string;
```

`completionReportPath` switches to `safeJoinUnder(cwd, COMPLETION_REPORT_DIR, `${beadId}.json`)` after a `BeadIdSchema.parse`. `readCompletionReport` returns a new `{ code: 'invalid_bead_id' }` read error instead of throwing, so `flywheel_verify_beads` reports one bad bead without aborting the sweep. `CompletionReportSchemaV1.beadId` stays `z.string().min(1)` (tightening a V1 field could reject an existing report on disk); the id check happens at path construction.

### 3.2 Model and effort (`mcp-server/src/model-detection.ts`)

```ts
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LADDER)[number];
export const PSTACK_BUDGETS = { unlimited: 'max', large: 'xhigh', medium: 'high', small: 'medium' } as const satisfies Record<string, EffortLevel>;
export type PstackBudget = keyof typeof PSTACK_BUDGETS;

export interface ModelChoice {
  readonly family: 'claude' | 'grok' | 'gemini' | 'gpt';
  readonly model: string;        // provider id, e.g. 'xai/grok-4.7', 'anthropic/claude-opus-5-5', 'gemini-4-argon'
  readonly effort: EffortLevel;
  readonly fast: boolean;
}

/** Highest effort in `supported` at or below `target`; undefined when none is. Never rounds up. */
export function clampEffort(target: EffortLevel, supported: readonly EffortLevel[]): EffortLevel | undefined;
```

Per-family supported ladders are data, sourced from the CLI at runtime where a CLI lists them (`agy models`) and from a constant otherwise (`grok` tops out at `xhigh`, per `setup-pstack` step 3b). The pstack role table (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `arena runners`, `arena cross-judge pool`, `swarm workers`, `architect runners`, `interrogate reviewers`) becomes `PSTACK_ROLE_DEFAULTS: Record<PstackRole, ModelChoice | readonly ModelChoice[]>`, and `inherit-parent` and `auto` are a separate `{ kind: 'inherit' }` variant, not magic strings in the model field.

Rendering per CLI is a total function over `ModelChoice` that returns argv, never a joined string:

- `claude`: `['--model', <alias>]` plus the effort mechanism the CLI exposes (verify with `claude --help` in the bead; when there is none, drop effort and return a warning).
- `pi`: `['--model', model, '--thinking', <pi level>]`, mapping `EffortLevel` to Pi's levels through a table checked against `pi --help` output in a test fixture. `buildPiPaneCommand` stops hard-coding `--thinking high`.
- `agy`: `['--model', <slug>, '--effort', effort]` where `<slug>` is resolved by `resolveAgySlug(family, effort, agyModels)` (3.3).

### 3.3 agy model resolution

```ts
/** Parsed `agy models` output: one `<slug>\t<display name>` per line. */
export const AgyModelLineSchema = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/), display: z.string() });
export function parseAgyModels(stdout: string): { models: AgyModelLine[]; skipped: string[] };
/** 'gemini-4-argon' + 'high' -> 'gemini-4-argon-high' when listed; else the clamped lower effort; else undefined. */
export function resolveAgySlug(base: string, effort: EffortLevel, models: readonly AgyModelLine[]): { slug: string; effort: EffortLevel } | undefined;
```

`agy models` prints "Fetching available models..." before the list; the parser skips lines that don't split into two tab-separated cells and returns them in `skipped` rather than failing. The result is cached in `.pi-flywheel/cache/agy-models.json` for one hour with `version: 1` and a `fetchedAt`, like the gateway catalog.

### 3.4 Verification ledger (`mcp-server/src/verification-ledger.ts`)

```ts
export const VerificationVerdictEnum = z.enum([
  'live-ui-verified', 'unit-test-verified', 'type-check-only', 'verifier-blocked', 'verifier-failed',
]);

const EvidenceSchema = z.object({
  kind: z.enum(['command', 'screenshot', 'video', 'log', 'note']),
  ref: z.string().min(1),              // the command line, or a repo-relative artifact path
  exitCode: z.number().int().optional(), // required when kind === 'command'
  summary: z.string().optional(),
});

export const VerificationRecordSchemaV1 = z.object({
  version: z.literal(1),
  beadId: z.string().min(1),
  headSha: FullShaSchema,
  commits: z.array(z.object({ sha: FullShaSchema, patchId: PatchIdSchema.nullable() })).min(1),
  verdict: VerificationVerdictEnum,
  evidence: z.array(EvidenceSchema).min(1),
  verifier: z.object({ agentName: z.string().min(1), provider: z.string().min(1), model: z.string().min(1) }),
  implementer: z.object({ agentName: z.string().min(1), provider: z.string().optional() }),
  reason: z.string().optional(),
  createdAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
}).superRefine(verdictEvidenceInvariants);
```

`verdictEvidenceInvariants` enforces, per verdict:

| Verdict | Required evidence | Passes the wave gate |
|---|---|---|
| `live-ui-verified` | at least one `screenshot`, `video`, or `log` whose `ref` is repo-relative, plus at least one `command` with `exitCode: 0` | yes |
| `unit-test-verified` | at least one `command` with `exitCode: 0` | yes |
| `type-check-only` | at least one `command` with `exitCode: 0` | only when the bead's template `verificationFloor` is `type-check-only` |
| `verifier-blocked` | non-empty `reason` | no |
| `verifier-failed` | a `command` with nonzero `exitCode`, or a `note`, and a non-empty `reason` | no |

Every `command` evidence must carry `exitCode`. Artifact `ref`s reuse the completion report's relative-path rule (no absolute paths, no `..` after POSIX normalization).

Storage is `.pi-flywheel/verification/<beadId>/<headSha>.json`, written with `writeAtomic`. A re-verification of the same head overwrites that file (latest verdict for a head wins, matching orch's `record`), and a new head gets a new file, so history survives.

`evaluateVerification({ beadId, report, records, git })` returns a discriminated union:

```ts
type VerificationStatus =
  | { status: 'verified'; record: VerificationRecordV1; carriedForward: boolean }
  | { status: 'missing' }
  | { status: 'stale'; record: VerificationRecordV1; reason: 'head_moved' | 'patch_changed' | 'patch_id_unavailable' }
  | { status: 'insufficient'; record: VerificationRecordV1; floor: VerificationFloor }
  | { status: 'failed'; record: VerificationRecordV1 }
  | { status: 'blocked'; record: VerificationRecordV1 };
```

**Patch-id carry-forward rule.** The bead's current head is the last entry of its completion report's `commits`, resolved to a full SHA with `git rev-parse --verify <sha>^{commit}`. A record whose `headSha` equals it applies directly. Otherwise a record carries forward only when the multiset of non-null `patchId`s for the bead's current commits equals the record's multiset exactly. A merge commit or an empty commit has a null patch id (`git patch-id --stable` prints nothing for it), and any null on either side makes the comparison fail with `patch_id_unavailable`, so the bead needs a fresh verdict. Patch ids are computed per commit (`git diff-tree -p --no-color --no-ext-diff --root <sha>` piped into `git patch-id --stable`), never over a range, because other agents' commits interleave with a bead's on `main` and a range diff would include their changes.

Feeding stdin to `git patch-id` needs an `input` option the `ExecFn` doesn't have today. Add `input?: string` to `ExecFn`'s options in `exec.ts` (optional and additive, so every existing mock still type-checks) and write it to the child's stdin in `makeExec`. The SSH exec in `swarm-host.ts` must either forward it or throw a typed error naming the missing support, with a test, so an offloaded wave doesn't compute empty patch ids.

### 3.5 Decision trail (`mcp-server/src/decision-trail.ts`)

```ts
export const DECISION_COLUMNS = ['ts', 'phase', 'decision', 'why', 'evidence', 'result'] as const;
export const DecisionRowSchema = z.object({
  phase: z.string().min(1), decision: z.string().min(1), why: z.string().min(1),
  evidence: z.string().min(1), result: z.string().min(1),
});
export async function appendDecision(cwd: string, slug: string, row: DecisionRow, now?: Date): Promise<{ path: string; truncated: boolean }>;
export async function readDecisions(cwd: string, slug: string): Promise<{ rows: DecisionRecord[]; skipped: number[] }>;
```

- The path is `safeJoinUnder(cwd, '.pi-flywheel/decisions', `${PlanSlugSchema.parse(slug)}.tsv`)`.
- The header is written by `open(path, 'wx')`. An `EEXIST` means another writer won the race, which is fine. This removes the `log.sh` window where two first writers both see an empty file and both write a header.
- Each row is one `appendFile` call. The sanitizer is `log.sh`'s `clean`: tabs, LF, and CR become spaces, and a cell starting with `=`, `+`, `-`, or `@` gets a leading `'`. After sanitizing, the encoded row is capped at 4,000 bytes by truncating the longest cell on a UTF-8 code point boundary and appending `…[truncated]`, so a single `O_APPEND` write stays under `PIPE_BUF` (4,096 on macOS and Linux) and concurrent appenders never interleave mid-row on a local filesystem.
- `readDecisions` skips (and reports) any line whose cell count isn't 6 and any repeated header line, which is the documented `log.sh` failure mode on network mounts.
- `skills/show-me-your-work/scripts/log.sh` is vendored as-is for humans; the MCP-side writer is the TypeScript one. A test feeds the same six inputs through both and asserts byte-identical rows after masking `ts`.

### 3.6 ORCH brief (`mcp-server/src/adapters/orch-brief.ts`)

```ts
export const OrchBriefSchema = z.object({
  goal: z.string().min(1).refine((s) => !s.includes('\n'), 'GOAL is one sentence'),
  scope: z.object({ write: z.array(z.string().min(1)).min(1), forbidWrite: z.array(z.string()), branch: z.string().min(1) }),
  context: z.array(z.string().min(1)),
  acceptance: z.array(z.string().min(1)).min(1),
  verify: z.array(z.string().min(1)).min(1),
  timeboxMinutes: z.number().int().positive().max(24 * 60),
  forbidden: z.array(z.string().min(1)).min(1),
  report: z.array(z.string().min(1)).min(1),
  standing: z.string(),
});
export function renderOrchBrief(brief: OrchBrief, opts: { collapse: boolean }): string;
export function briefFromBead(ctx: BeadDispatchContext, standing: string): { ok: true; brief: OrchBrief } | { ok: false; missing: (keyof OrchBrief)[] };
```

The nine fields and their order are pstack's (`GOAL`, `SCOPE`, `CONTEXT`, `ACCEPTANCE`, `VERIFY`, `TIMEBOX`, `FORBIDDEN`, `REPORT`, `STANDING`). pstack treats a missing field as a refuse-to-spawn condition, so `briefFromBead` returns the missing field names and the dispatch builders (`approve.ts` start, `advance-wave.ts`) surface them as a structured warning in Stage 1 and as `invalid_input` when `FW_ORCH_BRIEF_REQUIRED=1`. `FORBIDDEN` always includes the repo's own never-list (no stash, no hard reset, no branch switch, no force-push), so it can't be empty even when a bead names nothing. `collapse` follows pstack's "size the brief to the unit" rule: a bead whose template effort is `S` renders as one paragraph that still names goal, scope, verify, and report shape.

### 3.7 Gate ids (`mcp-server/src/gates.ts`)

```ts
export const GATE_IDS = [
  'tests-passing', 'no-regressions', 'code-quality', 'documentation', 'integration-sanity',
  'random-exploration', 'cross-agent-review', 'interrogate',
] as const;
export type GateId = (typeof GATE_IDS)[number];
/** Frozen order of the five gates before this change; index i in an old checkpoint meant LEGACY_GATE_ORDER[i]. */
export const LEGACY_GATE_ORDER: readonly GateId[] = ['tests-passing', 'no-regressions', 'code-quality', 'documentation', 'integration-sanity'];
export function resolveCurrentGate(state: Pick<FlywheelState, 'currentGateId' | 'currentGateIndex'>): GateId;
```

`FlywheelState` gains optional `currentGateId?: GateId` and `reviewLoop?: ReviewLoopState`. `resolveCurrentGate` prefers `currentGateId`, else maps `currentGateIndex` through `LEGACY_GATE_ORDER` (an out-of-range legacy index maps to `tests-passing` with a logged warning), and the next save writes `currentGateId`. `currentGateIndex` keeps being written for one release so a downgrade still loads.

**Review loop state machine.** The guide's rules become transitions, not prose:

```ts
export const ReviewLoopStateSchema = z.object({
  version: z.literal(1),
  round: z.number().int().nonnegative(),
  nextKind: z.enum(['random-exploration', 'cross-agent-review']),
  consecutiveCleanRounds: z.number().int().nonnegative(),
  roundsWithFindings: z.number().int().nonnegative(),
});
```

- A round alternates kind: `random-exploration` then `cross-agent-review` then `random-exploration`.
- A clean round increments `consecutiveCleanRounds`; a round with findings resets it to 0 and increments `roundsWithFindings`.
- Two consecutive clean rounds pass the pair of gates.
- At `roundsWithFindings >= 4` the tool stops returning another review prompt and returns `nextStep: 'create_fix_beads'`, per the guide's "go back to bead space" rule.
- "Clean" is decided from the structured findings file (`status: 'pass'` and `findings: []`), never from free text.

---

## 4. Implementation phases

Each bead lists its files (the reservation set), the change, the invariants it must hold, its tests, and its acceptance. Beads within a wave touch disjoint files unless a dependency says otherwise. "Build" means `cd mcp-server && npm run build`, and every bead that changes `mcp-server/src/` commits the matching `dist/` in the same commit, because the `dist-drift` CI job fails otherwise.

### Wave 0: baseline and coordination (serial)

**W0.1 Land or hand off the in-flight agy lane.**
- Files: none until resolved; the WIP set is `mcp-server/src/swarm-spawn.ts`, `mcp-server/src/lint/rules/pane001.ts`, `mcp-server/scripts/lint-skill.ts`, `skills/start/_implement.md`, `skills/start/_planning.md`, their tests, `dist/` counterparts, and `.gitignore`.
- Change: find the owner through Agent Mail (`whois`, reservations on those paths). If the owner is active, message them with the correctness notes below and wait for their commit. If no one holds them and the user confirms, a bead adopts them. Nobody stashes, resets, or overwrites them.
- Correctness notes to send: `AGY_LANE_VALUE_PATTERN` admits spaces and parentheses, so `--agy=2:Gemini 4 Argon (High)` passes and reaches `agy --model` as a display name; restrict the model suffix to `^[a-z0-9][a-z0-9.-]*$` and resolve it with `resolveAgySlug`. `laneCount` now parses every lane with the agy pattern, so `--cc=2:Opus (fast)` also parses; give each lane its own pattern. `NTM_TITLE_PATTERN`'s optional model capture includes spaces and parentheses, so a pane title with a trailing model string can mis-attribute a model; prefer the configured value and drop the title capture.
- Acceptance: the WIP is committed by its owner (or adopted with user confirmation), and `npm test` is green on that commit.

**W0.2 Capture the baseline.**
- Files: `.pi-flywheel/baseline/2026-10-21.json` (runtime state, not committed).
- Change: record exit codes and counts for `npx tsc --noEmit --listFiles | wc -l` (must be above 0), `npm run build`, `npm test` (number of test files and tests), `npm run check:skills-bundle`, `npm run lint:skill`, `npm run verify:error-meta`, and `scripts/sync-opencode.sh --check`.
- Acceptance: every later wave compares against these numbers, and a test count that drops without a recorded deletion is a regression.

**W0.3 Ids, safe paths, and `ExecFn.input`.**
- Files: `mcp-server/src/ids.ts` (new), `mcp-server/src/completion-report.ts`, `mcp-server/src/exec.ts`, `mcp-server/src/swarm-host.ts` (exec forwarding only), `mcp-server/src/__tests__/ids.test.ts` (new), `mcp-server/src/__tests__/completion-report.test.ts`, `mcp-server/src/__tests__/exec.test.ts`.
- Change: section 3.1, plus `input?: string` on `ExecFn` (3.4).
- Invariants: no existing valid bead id (`agent-flywheel-plugin-j0b`, `claude-3hzk`, dotted ids) is rejected; `safeJoinUnder` rejects `..`, absolute segments, and NUL; `input` reaches the child's stdin and a mock exec without `input` support still compiles.
- Tests: table tests for the regexes with every bead id format found in `.beads/` (read them, don't invent them); a traversal test that `completionReportPath(cwd, '../../x')` throws and `readCompletionReport` returns `invalid_bead_id`; `makeExec` round-trips `input` through `cat`; the SSH exec either forwards `input` or throws a typed error (asserted).
- Acceptance: `npx tsc --noEmit`, the touched tests, and build pass.

### Wave 1: independent foundations (parallel)

Six tracks. None of them edits a file another track edits.

#### Track A: models, effort, and the agy lane

**A1 Model and effort pair.**
- Files: `mcp-server/src/model-detection.ts`, `mcp-server/src/__tests__/model-detection.test.ts`.
- Change: section 3.2: `EFFORT_LADDER`, `PSTACK_BUDGETS`, `ModelChoice`, `clampEffort`, `PSTACK_ROLE_DEFAULTS`, `xai/grok-4.7` in the `grok` family with a supported ladder ending at `xhigh`, and the per-CLI renderers.
- Invariants: `clampEffort` never returns a level above its target and returns `undefined` when nothing is at or below it; `budgetToEffort('unlimited')` on grok yields `xhigh` (pstack's documented fallback); renderers return argv arrays, and no renderer emits a model slug that wasn't in its input or its detected list.
- Tests: every budget times every family; `small` on claude yields `medium`; `inherit` passes through; a property test over all `(target, supported)` pairs that the result is the maximum of `supported ∩ [low..target]`.
- Acceptance: tests pass, `CURRENT_GEMINI_MODEL_ID` keeps its value (other code imports it).

**A2 agy capability probe and routing.** Depends on A1 and W0.1.
- Files: `mcp-server/src/adapters/model-diversity.ts`, `mcp-server/src/flywheel-config.ts`, `mcp-server/src/types.ts` (`SwarmMixSchema` comment and the new `ratioByLane`), `mcp-server/src/__tests__/model-diversity*.test.ts`, `mcp-server/src/__tests__/flywheel-config-lanes.test.ts`.
- Change: `ModelProvider` adds `'agy'`; `PROVIDER_BINARIES.agy = 'agy'`; `probeAgy` runs `which agy`, then `agy models` with a 10 s timeout and the abort signal, and is available only when `resolveAgySlug(CURRENT_GEMINI_MODEL_ID, 'high', models)` resolves; `lanes.agy` (boolean, default true) joins `CONFIGURABLE_LANES`; the Gemini seat's fallback order becomes `['agy', 'pi', 'codex', 'claude']`, and Pi's becomes `['codex', 'gemini', 'agy', 'claude']`; `SPAWN_LANE.agy = 'agy'`; `DispatchPlan` gains `ratioByLane: Readonly<Record<ModelProvider, number>>`.
- Invariants: `sum(lane.beadIds.length) === beadIds.length` for every capability combination (16 combinations of 4 optional lanes times disabled flags); `ratio` keeps exactly three colon-separated fields; `ratioByLane` sums to `n`; a disabled `agy` hands its share down silently and never sets `degraded`; with every lane ready the mix is unchanged from today, so a host that has `agy` installed doesn't silently move work off the gateway Gemini lane.
- Tests: exhaustive table over capability maps (generated, not hand-listed); `swarmMixFor` labels and spawn flags with Gemini missing and agy present (`cc:pi:agy 2:2:2`, `--cc=2 --pi=2 --agy=2`); `describeCapabilities` output for the new cases; `agy models` parse failures degrade to unavailable with a reason, never throw.
- Acceptance: tests pass; existing model-diversity snapshots change only where agy is present.

**A3 agy prompt adapter.** Depends on A2 and B0 below (the brief is optional input).
- Files: `mcp-server/src/adapters/agy-prompt.ts` (new), `mcp-server/src/adapters/claude-prompt.ts` (export `adaptPromptForTerminal`'s identity type only if needed), `mcp-server/src/__tests__/adapters/agy-prompt.test.ts` (new).
- Change: `adaptPromptForAgy(ctx)` with identity `{ provider: 'agy', program: 'antigravity', model: <resolved slug>, agentMail: 'cli' }`; `adaptPromptFor('agy', ctx)` routes there.
- Invariants: Agent Mail steps use the `am` CLI because the pane's MCP set depends on the user's AGY config, which the server can't see; every `am` argument is shell-quoted with the existing `shellQuote`; the completion-attestation block is identical to the other adapters' (snapshot equality on the gate section).
- Acceptance: `adaptPromptFor` stays exhaustive over `ModelProvider` (a `never` check in the `switch` default fails the build when a provider is added without an adapter).

#### Track B0: ORCH brief (adapter-independent module)

**B0 ORCH brief schema and renderer.**
- Files: `mcp-server/src/adapters/orch-brief.ts` (new), `mcp-server/src/__tests__/adapters/orch-brief.test.ts` (new).
- Change: section 3.6.
- Invariants: render order is the nine pstack fields in pstack order; `briefFromBead` lists every missing field instead of stopping at the first; `FORBIDDEN` always contains the repo never-list; rendering escapes nothing it doesn't need to and never drops a field in collapsed mode (collapsed output still contains goal, scope, verify, and report text).
- Tests: a bead missing ACCEPTANCE and VERIFY reports both; collapsed and full renders contain every required string; a multi-line GOAL is rejected.
- Acceptance: tests pass. Injection into adapters happens in Wave 2 (W2.4) so this bead doesn't touch adapter files.

#### Track B: verification ledger

**B1 Ledger module.** Depends on W0.3.
- Files: `mcp-server/src/verification-ledger.ts` (new), `mcp-server/src/__tests__/verification-ledger.test.ts` (new).
- Change: section 3.4: schema, invariants, write, read, `computePatchIds(exec, cwd, shas, signal)`, `evaluateVerification`.
- Invariants: listed in the 3.4 table; a record file whose `beadId` or `headSha` doesn't match its path is reported `invalid` and never applied; `computePatchIds` uses a timeout on every exec call and passes the signal; a non-repo cwd yields `patch_id_unavailable`, not a throw.
- Tests (with a real temporary git repo, since patch ids are the behavior under test): a rebased commit keeps its patch id and carries the verdict forward; amending the diff breaks it (`patch_changed`); a merge commit yields `patch_id_unavailable`; two beads interleaved on one branch compute per-commit ids that ignore the other bead's commits; `type-check-only` under a `unit-test` floor is `insufficient`; a verdict on an old head with no patch match is `stale` with `head_moved`.
- Acceptance: tests pass with no network access.

**B2 Error codes.**
- Files: `mcp-server/src/errors.ts`, `mcp-server/src/__tests__/error-contract.test.ts`, `mcp-server/src/__tests__/errors.schema.test.ts`.
- Change: add `verification_missing`, `verification_stale`, `verification_failed`, `orch_brief_incomplete`, `agy_sync_drift` to `FLYWHEEL_ERROR_CODES` and to both metadata tables (hint text and retryability), following the `attestation_missing` entries at the three existing sites.
- Invariants: no existing code changes meaning; only `verification_stale` is retryable (a re-verify can clear it).
- Acceptance: `npm run verify:error-meta` and the error tests pass.

#### Track C: decision trail

**C1 Decision trail writer and reader.** Depends on W0.3.
- Files: `mcp-server/src/decision-trail.ts` (new), `mcp-server/src/__tests__/decision-trail.test.ts` (new).
- Change: section 3.5.
- Tests: 50 concurrent `appendDecision` calls from `Promise.all` produce exactly one header and 50 well-formed rows; a cell of `=HYPERLINK(...)` is prefixed; a 10 KB evidence cell truncates on a code point boundary (test with a multi-byte character at the cut); a file with a stray second header reads with that line in `skipped`; parity with `log.sh` (the test runs `bash` with a timeout and skips with a reason when `bash` is missing).
- Acceptance: tests pass.

#### Track D: AGY mirror (scripts and templates only)

**D1 Manifest and validator.**
- Files: `agy/manifest.json` (new), `scripts/agy/validate.mjs` (new), `scripts/agy/__fixtures__/` (new), a vitest file `mcp-server/src/__tests__/scripts/agy-validate.test.ts` (new) that imports the `.mjs`.
- Manifest shape (`version: 1`, `kind: 'agy-port-manifest'`): `target` (default `~/.gemini/config/plugins/agent-flywheel`), `pluginJson` (the exact rendered fields), `skills[]` (name, source dir, transform profile), `rules` (`{ source: 'agy/rules/AGENTS.md', maxBytes: 24000 }`), `mcp` (`{ serverName: 'agent-flywheel', entry: 'mcp-server/dist/server.js', env: { FLYWHEEL_PLATFORM: 'antigravity', CLAUDE_PLUGIN_ROOT: '<repo>' } }`), `hooks[]` (the translation table, D3), `neverOwn[]` (copied from the OpenCode manifest's list, plus `~/.gemini/config/mcp_config.json`, `config.json`, `hooks.json` at the config root).
- Invariants checked by `validate.mjs`: `pluginJson` keys are a subset of `name, description, logo, suggestedPrompts, displayName, version, disabled`, `name` is lowercase kebab-case, `suggestedPrompts` has at most 3 non-empty strings, `logo` is relative with an allowed extension; every `skills[]` source dir exists and has a `SKILL.md` with `name` and `description` frontmatter; skill names are unique case-insensitively; the declared inventory equals the discovered inventory (same `inventory_unclassified` and `inventory_missing` findings as OpenCode); every Claude hook in `hooks/hooks.json` appears in `hooks[]` either translated or as `{ portable: false, reason }`; the rules source is at most 24,000 bytes after expanding `@[label](path)` includes; MCP server names start with `agent-flywheel`.
- Acceptance: each invariant has a failing fixture and a passing fixture.

**D2 Renderer and sync CLI.** Depends on D1.
- Files: `scripts/agy/sync.mjs` (new), `scripts/agy/transforms.mjs` (new), `scripts/sync-agy.sh` (new, mirrors `sync-opencode.sh`), `mcp-server/src/__tests__/scripts/agy-sync.test.ts` (new).
- Change: render into a private temp stage, compare with the target, and apply with `scripts/opencode/apply.mjs`'s `acquireLock`, `readLedger`, `recoverState`, and `runTransaction`, imported, not copied. Modes are `--check` (default, exit 1 on drift), `--dry-run`, and `--write`, plus `--target <dir>` for tests. When `agy` is on PATH, `--check` and `--write` also run `agy plugin validate <stage> --strict --json` with a 30 s timeout and fail on any `error` finding; when it isn't, the result says `agy validate: skipped (agy not on PATH)`, so a missing CLI is visible rather than silent.
- Transform profile `agy-skill`: `${CLAUDE_PLUGIN_ROOT}` becomes the absolute repo root (JSON-quoted where it lands in JSON); `/agent-flywheel:<x>` slash references become `/<x>`; `AskUserQuestion(` call sites become AGY's `ask_question`; the Claude `Agent`/`Task` subagent wording becomes `invoke_subagent`. Each rewrite is a lexical rule with a postcondition test, and the MCP-name rule from OpenCode carries over (never rewrite `agent-flywheel:` inside a `flywheel_get_skill` name argument).
- Invariants: `[LOCAL]` divergence is detected from the ledger hash exactly as OpenCode does (live bytes differ from the last written hash), backed up, and never silently overwritten by `--check`; a target that `realpath`s outside the plugin directory aborts with exit 2; a crash mid-`--write` is recovered by `recoverState` on the next run (test by killing between journal and rename with an injected fault); `--write` twice in a row is a no-op the second time (idempotence test).
- Acceptance: `scripts/sync-agy.sh --check --target <tmp>` exits 1 on an empty target and 0 after `--write --target <tmp>`.

**D3 Hook translation.** Depends on D1.
- Files: `agy/templates/hooks.json.tmpl` (new), `hooks/agy/*.mjs` (new wrappers), `mcp-server/src/__tests__/scripts/agy-hooks.test.ts` (new).
- The table, as data in the manifest:

| Claude hook | AGY event | Translation |
|---|---|---|
| `PostToolUse` matcher `flywheel_approve_beads`, `echo '...'` | `PostToolUse` | Not portable as written: the MCP tool's AGY name isn't known at sync time and `echo` prints plain text where AGY requires JSON. Marked `portable: false` until a smoke test on a real AGY session records the tool name. |
| `PreToolUse` matcher `Bash` with `if: Bash(*doctor*)`, `Bash(*DOCTOR*)`, `Bash(*activity.lock*)` | `PreToolUse` matcher `run_command` | `hooks/agy/agent-mail-guard.mjs` reads stdin JSON, applies the three patterns to `toolCall.args.CommandLine` itself (AGY has no `if`), and prints `{"decision":"deny","reason":...}` or `{"decision":"allow"}`. |
| `SessionStart` `startup.js` | `SessionStart` (flat list) | Wrapper prints `{"injectSteps":[{"systemMessage":{"systemMessage":<text>}}]}` with the startup text, capped at 8 KB. |
| `Stop` release reservations | `Stop` (flat list) | Wrapper runs the release and prints `{}`; it never returns `decision: "continue"`, so it can't trap the loop. |
| `SubagentStop` release reservations | none | `portable: false`, reason "AGY has no SubagentStop event". |
| `pcr` post-compaction AGENTS.md re-read (new, W2.9) | none | `portable: false`, reason "AGY has no compaction event; plugin rules are always-on". |

- Invariants: every wrapper exits 0 and prints valid JSON even when its inner script throws or stdin is empty or malformed (a malformed payload yields `{"decision":"allow"}` for `PreToolUse`, because a hook that denies everything on a parse error would brick the session); commands use absolute paths because AGY's hook cwd is the plugin directory; each handler declares `timeout` in seconds (AGY's unit), not milliseconds.
- Tests: spawn each wrapper with empty stdin, malformed JSON, a matching command, and a non-matching command, and parse stdout with a Zod schema of AGY's per-event output contract.

**D4 Condensed rules file.**
- Files: `agy/rules/AGENTS.md` (new).
- Change: hand-author the AGY rules from `AGENTS.md`: the eight hard constraints, the Agent Mail rules, the bead lifecycle, the pre-completion quality gate, the NTM mandate, and pointers (repo-relative paths) to the long sections instead of their text.
- Invariants: at most 24,000 bytes (checked by D1), plain markdown with no frontmatter (AGY rules don't support it), and every hard constraint from `AGENTS.md`'s "Hard Constraints" list appears verbatim (a test extracts the numbered list from both files and compares).

#### Track E: vendored pstack

**E1 Vendor the upstream tree with provenance.**
- Files: `skills/<name>/` for each vendored skill, `skills/PSTACK_VENDOR.json` (new), `THIRD_PARTY_NOTICES.md` (new), `scripts/check-pstack-vendor.mjs` (new), `mcp-server/src/__tests__/scripts/pstack-vendor.test.ts` (new).
- Scope: the skills the brainstorm names (`poteto-mode` with its 23 playbooks and `references/`, the 24 `principle-*` skills, `how`, `why`, `sharpen`, `architect`, `arena`, `create-verification-skill`, `create-formal-verification-skill`, `maintain-verification-skill`, `no-comments`, `interrogate`, `blast-radius`, `unslop`, `correct`, `show-me-your-work`, `setup-pstack`, `swarm`, `tdd`, `technical-writing`, `typescript-best-practices`), plus `agents/comment-sicko.md` and `agents/poteto-agent.md` under `agents/`. Excluded: `poteto-mode/scripts/watch-pr/`, `bootstrap.ts`, `bun.lock`, `package.json`, `orch/` (its semantics are reimplemented in B1), `automations/`, `assets/`.
- `PSTACK_VENDOR.json` (`version: 1`): `upstream` (`cursor/plugins`, path `pstack`, version `0.15.29` from its `plugin.json`, and the upstream commit when the clone has one), `files[]` with `path` and `sha256` as vendored, and `patches[]` with `path`, `reason`, and the post-patch `sha256`.
- Invariants: no vendored skill name collides with an existing `skills/` entry (the repo has none of these names today; the check keeps it that way); every vendored skill sits directly under `skills/` because `poteto-mode` resolves siblings as `../<name>/SKILL.md` and the bundle builder only walks one level; every file listed matches its recorded hash; counts asserted from the vendored tree are 24 principles, 23 playbooks, 33 unslop rules, 8 red-flag headings, and 4 lead-judgment buckets in `interrogate/SKILL.md`.
- Acceptance: `node scripts/check-pstack-vendor.mjs` exits 0, and editing one vendored byte without recording a patch makes it exit 1.

**E2 Harness translation patches.** Depends on E1.
- Files: the specific vendored files that name Cursor-only mechanisms, recorded in `PSTACK_VENDOR.json` `patches[]`.
- Change: `setup-pstack` writes `.pi-flywheel/pstack-models.json` (validated by a `PstackModelsConfigSchema` that A1 exports) instead of `~/.cursor/rules/pstack-models.mdc`, and detects models through `flywheel_pi_models` and `agy models` instead of Cursor's model list; `AskQuestion` becomes `AskUserQuestion`; references to `cursor-team-kit` skills (`deslop`, `control-ui`, `control-cli`) point at the flywheel equivalents (`/flywheel-...` or `de-slopify`) or are marked unavailable; `Task` with `environment: "cloud"` is described as unavailable.
- Invariants: each patch is the smallest edit that makes the instruction executable in this harness, and the patch list is the complete diff from upstream (the vendor check recomputes it).

**E3 Plan validators.** Depends on E1.
- Files: `skills/poteto-mode/scripts/check-plan.mjs` (vendored verbatim in E1), `scripts/check-bead-verify.mjs` (new), `scripts/__fixtures__/check-bead-verify/{pass,fail-*}.md` (new), `mcp-server/src/__tests__/scripts/check-bead-verify.test.ts` (new).
- Change: `check-bead-verify.mjs <plan.md>` validates the flywheel shape: every bead section (an `###` heading inside an implementation-phase `##`) has `Verify, unit.`, `Verify, live.`, and `Verify, perf.` sub-blocks; each opens with pstack's rule sentence ("Tests alone are not sufficient verification. ..."); `Verify, live.` names at least one command or artifact; `Verify, perf.` lists `Metric.`, `Probe.`, `Baseline.`, `Rule.` in that order or opens with `None.` and a reason. It reuses `check-plan.mjs`'s fence tracking so text inside code fences is ignored, but it does not enforce pstack's prose rules (long dashes, curly quotes, colons), which every existing flywheel plan violates.
- Invariants: a missing argument exits 2 with usage (same as upstream); a file with zero bead sections exits 1 with "no bead sections" rather than 0, so an empty or mis-headed plan can't pass vacuously.
- Acceptance: the pass fixture exits 0, each fail fixture exits 1 with the expected message, and `node skills/poteto-mode/scripts/check-plan.mjs skills/poteto-mode/__fixtures__/program.md` passes on a pstack-shaped fixture so the verbatim copy is exercised.

#### Track F: operators and templates

**F1 Operator registry and lint.**
- Files: `mcp-server/src/operators.ts` (new), `mcp-server/src/lint/rules/oper001.ts` (new), `mcp-server/src/lint/rules/index.ts` (registration; check the actual registry file name before editing), `mcp-server/src/__tests__/lint/oper001.test.ts` (new).
- Change: `COGNITIVE_OPERATORS = ['plan-first-expansion', 'competing-plan-triangulation', 'overshoot-mismatch-hunt', 'plan-to-beads-transfer-audit', 'convergence-polish-loop', 'fresh-eyes-reset', 'fungible-swarm-launch', 'feedback-to-infrastructure-closure'] as const` with each operator's trigger, failure mode, and expected output from the guide's Operator Library. `OPER001` flags any `[OPERATOR: x]` in a skill file whose `x` isn't registered.
- Invariants: exactly eight ids, in the guide's order (a test asserts the list against the guide's `[OPERATOR: ...]` lines in a checked-in excerpt fixture, because the guide itself lives outside the repo).
- Acceptance: lint tests pass, and `npm run lint:skill` stays at or under the tone baseline.

**F2 Playbook bead templates.**
- Files: `mcp-server/src/bead-templates.ts`, `mcp-server/src/types.ts` (`BeadTemplate.verificationFloor?`), `mcp-server/src/__tests__/bead-templates.test.ts`.
- Change: add `hillclimb`, `runtime-forensics`, `trace-forensics`, and `bug-fix-scientific` at version 1, each with placeholders, acceptance criteria, `filePatterns`, `estimatedEffort`, and `verificationFloor` (`VerificationFloor = 'type-check-only' | 'unit-test-verified' | 'live-ui-verified'`, optional, default `unit-test-verified`). The forensics templates' deliverable is a diagnosis, so their acceptance names a written diagnosis artifact and their floor is `type-check-only`; `hillclimb` requires a decision-trail slug placeholder and a baseline number; `bug-fix-scientific` requires a reproduction command that fails before the fix and passes after.
- Invariants: `validateTemplateIntegrity(listTemplates())` returns `[]` (it only logs today, so the test asserts the returned array); existing template ids and versions are unchanged, so `flywheel_calibrate` keeps grouping old beads; the id `fix-bug` stays and the new one is a distinct id rather than a version bump, because a version bump would change what `Template: fix-bug` means for in-flight beads.
- Acceptance: template tests and `flywheel_calibrate` tests pass.

### Wave 2: integration (parallel where files allow)

**W2.1 Gate ids and the review loop.** Depends on F1 (operator ids appear in gate prompts) and B2.
- Files: `mcp-server/src/gates.ts`, `mcp-server/src/tools/review.ts`, `mcp-server/src/types.ts` (state fields), `mcp-server/src/state.ts` if defaults live there, `mcp-server/src/__tests__/gates.test.ts`, the review tests, `mcp-server/src/__tests__/migration.test.ts` plus a frozen v3.25 checkpoint fixture.
- Change: section 3.7. `runGates` reads `GATE_DEFINITIONS` (id, title, prompt builder). The Random Exploration prompt is the guide's text; the Cross-Agent prompt is the guide's text; the review-loop transitions run when the current gate is either of them. The Interrogate gate dispatches two reviewers on different model families (from `PSTACK_ROLE_DEFAULTS['interrogate reviewers']`), each applying `interrogate/references/rubric.md` and `code-quality-review.md`, plus the `comment-sicko` agent over the diff, and asks the coordinator to sort findings into the four buckets with the raising model named on each. `looks-good` on the Interrogate gate requires a findings file in which every `Act on` item is resolved.
- Invariants: a v3.25 checkpoint at `currentGateIndex: 3` resumes on `documentation`; `consecutiveClean >= gateChecks.length` becomes "every gate id passed once in this circuit" tracked as a set, so changing the gate count can't shorten the circuit; the alternation never issues the same kind twice in a row; the loop terminates (property test: any sequence of clean and dirty results ends in pass or `create_fix_beads` within a bounded number of rounds, given at most 4 dirty rounds).
- Acceptance: tests pass, `flywheel_review` responses keep their existing `kind: 'review_gate'` shape with an added `gateId`.

**W2.2 Verification in `verify-beads` and `advance-wave`.** Depends on B1, B2, F2.
- Files: `mcp-server/src/tools/verify-beads.ts`, `mcp-server/src/tools/advance-wave.ts`, their tests.
- Change: `flywheel_verify_beads` adds `verification[]` with each closed bead's `VerificationStatus`; `flywheel_advance_wave` consults it after the attestation check. Stage 1 is warn-only (`needsVerification: true` plus counts in the text), and `FW_VERIFICATION_REQUIRED=1` turns `missing`, `stale`, `failed`, `blocked`, and `insufficient` into `verification_missing`, `verification_stale`, or `verification_failed` envelopes.
- Invariants: the swarm-host pull runs before verification reads (it already runs before attestation); a bead without a completion report is reported once, under attestation, not twice; patch-id computation is bounded (one exec per commit, 5 s timeout each, all inside the tool's existing budget) and a timeout yields `patch_id_unavailable`.
- Acceptance: tests with a temporary git repo for carry-forward and with `createMockExec()` for the rest.

**W2.3 Verifier dispatch prompt.** Depends on B1, A3.
- Files: `mcp-server/src/adapters/verifier-prompt.ts` (new), its test, and the call site in `advance-wave.ts` (coordinate with W2.2: same bead, or W2.3 after W2.2 commits).
- Change: after a bead closes, the coordinator gets one verifier prompt per bead, addressed to a lane whose family differs from the implementer's (pstack's "run a unit's verifier on a different model family"). The prompt embeds a `VerificationRecordSchemaV1`-generated example (same technique as `completion-attestation-prompt.ts`, parsing the example through the schema so the example can't drift) and the exact output path.
- Invariants: when only one family is available, the prompt says so and the record's `verifier.provider` equals the implementer's, and `evaluateVerification` reports a `sameFamily` warning instead of failing.

**W2.4 Brief injection.** Depends on B0, A3.
- Files: `mcp-server/src/adapters/claude-prompt.ts`, `mcp-server/src/adapters/codex-prompt.ts`, `mcp-server/src/adapters/agy-prompt.ts`, `mcp-server/src/adapters/implementer-dispatch.ts`, prompt snapshot tests.
- Change: every adapter prepends `renderOrchBrief` output when `briefFromBead` succeeds, followed by the principles index (the 24 names with their one-line triggers, generated from the vendored `poteto-mode/SKILL.md` Principles section at build time, not pasted by hand).
- Invariants: the brief appears exactly once per prompt; prompt budget stays under the limit `scripts/prompt-budget.ts` enforces (run it and record the delta); the principles index is generated, so a test fails when the vendored index and the generated text disagree.

**W2.5 Swarm spawn for agy.** Depends on W0.1 and A1–A3.
- Files: `mcp-server/src/swarm-spawn.ts`, `mcp-server/src/__tests__/swarm-spawn.test.ts`, `mcp-server/src/lint/rules/pane001.ts` only if W0.1 didn't already cover agy.
- Change: `--agy=N[:<base>@<effort>]` (for example `--agy=2:gemini-4-argon@high`), resolved through `resolveAgySlug` before `ntm spawn` runs, failing with the list of available slugs when nothing resolves; a readiness probe that `ntm spawn --help` mentions `--agy` (cached per process), failing with a clear message when it doesn't.
- Invariants: no model string with whitespace reaches ntm; the printed pane JSON reports the resolved slug, not the requested base.

**W2.6 Doctor checks.** Depends on A2, D2, E1.
- Files: `mcp-server/src/tools/doctor.ts`, `mcp-server/src/checks/*` as structured there, doctor tests, `mcp-server/src/types.ts` if `DoctorCheck` names are an enum.
- Change: `agy_cli` (green when `agy` is on PATH and `agy models` resolves `gemini-4-argon` at some effort; green with `disabled: true` when `lanes.agy: false`), `agy_plugin_sync` (runs `scripts/sync-agy.sh --check` with a 20 s timeout; yellow on drift or `[LOCAL]`, green when the target directory doesn't exist and the user never synced), `pstack_vendor` (runs `scripts/check-pstack-vendor.mjs`; yellow on unrecorded drift).
- Invariants: every probe has a timeout and the abort signal; the doctor's total budget still holds (tests use `createMockExec()` per the known pitfall); the doctor count in docs is updated and asserted.

**W2.7 Antigravity platform adapter.** Depends on D1 (manifest names the env value).
- Files: `mcp-server/src/adapters/platform/AntigravityAdapter.ts` (new), `detect.ts`, `index.ts`, tests.
- Change: `PlatformId = 'claude-code' | 'antigravity'`; `detectPlatform()` returns `'antigravity'` only when `process.env.FLYWHEEL_PLATFORM === 'antigravity'` (set by the rendered `mcp_config.json`), and an unknown value logs a warning and falls back to `'claude-code'`. `pluginRoot()` returns `CLAUDE_PLUGIN_ROOT` from the same env block; `installedPluginManifestPath()` returns the AGY target's `plugin.json`; `validateHooks()` checks that `hooks.json` sits at the plugin root, parses, and names only AGY events.
- Invariants: `getAdapter` stays exhaustive over `PlatformId` (a `never` default).

**W2.8 Skill text changes.** Depends on F1 (operator lint) and E1. Split into one bead per file so reservations don't collide:
- `skills/start/_beads.md`: the eight `[OPERATOR: ...]` tags at the steps where the guide applies them, and the overshoot mismatch hunt (the "at least 80" prompt) in the plan-to-beads audit step.
- `skills/start/_planning.md` (after W0.1 lands): synthesis writes a `git diff --no-index` of each planner's plan against the synthesized plan and a three-tier agreement report (all planners, two of three, one), each claim citing its planners.
- `skills/start/_implement.md` (after W0.1 lands): stack-aware verify commands from `flywheel_profile` languages, `rch exec -- <cmd>` only when `command -v rch` succeeds and only for the cargo commands the guide names, and the existing "confirm the check examined more than zero items" rule applied to each command.
- `skills/flywheel-refine-skill/SKILL.md`: `cass search` with a timeout and a "cass unavailable" branch.
- `skills/flywheel-research/SKILL.md`: Phase 3 inversion analysis prompt from the guide.
- Invariants: `npm run lint:skill` passes with the baseline not raised; every `AskUserQuestion` call site still lints.

**W2.9 Post-compaction reminder hook (Claude side).**
- Files: `hooks/hooks.json`, `hooks/post-compact-reminder.js` (new), `mcp-server/src/__tests__/hooks-guard-wiring.test.ts` (extend).
- Change: a `SessionStart` entry with matcher `compact` that prints a short instruction to re-read `AGENTS.md`, wrapped with `_run-hook.sh` like the startup hook.
- Invariants: the hook exits 0 when `AGENTS.md` is missing, prints at most 2 KB, and fires only on the `compact` source (test the matcher against `startup`, `resume`, `clear`, `compact` payloads).
- The OpenCode manifest's hook coverage check (`checkHookCoverage`) will flag the new hook; add it to `opencode/manifest.json` in the same bead with its OpenCode disposition.

### Wave 3: docs, enforcement, and release

**W3.1 AGENTS.md.**
- Files: `AGENTS.md`.
- Change: a "v3.26.0" version-sliced section and quick-reference entries for every new tool field and env knob (`FW_VERIFICATION_REQUIRED`, `FW_ORCH_BRIEF_REQUIRED`, `lanes.agy`), the agy lane in the NTM pane priority section and the substitution ladder (`gmi → agy → pi → cod → cc` for the Gemini seat), the corrected ntm statement (capability-probed, not "1.36.1 has no pi lane"), the "OpenCode port is a derived artifact" paragraph extended to the AGY mirror, and the `/correct` Rule Enforcement Table: one row per enforced rule naming its mechanism in pstack's order (architecture, type, lint, test, docs) and the test or lint id that proves it fails on a real past mistake.
- Invariants: existing contradiction tests (`swarm-text-contradictions.test.ts`, `plugin-agents-md-gate.test.ts`, PANE001's `parseCanonicalFromAgentsMd`) still parse the canonical rule; the doctor-check count and MCP tool count match the code.

**W3.2 OpenCode manifest and README.**
- Files: `opencode/manifest.json`, `README.md`, `docs/agy.md` (new, operator workflow mirroring `docs/opencode.md`), `CHANGELOG.md`.
- Invariant: the new pstack skill dirs don't match the OpenCode `skillDirPattern` (`^(flywheel-.+|start)$`), so they stay outside its ownership boundary; `scripts/sync-opencode.sh --check` must still exit as it did at baseline.

**W3.3 Build, bundle, and release check.**
- Files: `mcp-server/dist/**`, `mcp-server/dist/skills.bundle.json`, version files via `npm run version-sync`.
- Acceptance: section 6 in full.

---

## 5. Testing strategy

Behavior tests come first, with each bead's tests named against a defect they would catch (pstack's "test behavior, not implementation").

- **Unit tests (vitest, `mcp-server/src/__tests__/`).** Schemas get table tests of valid and invalid inputs from real data (bead ids from `.beads/`, SHAs from `git log`, `agy models` output captured from this host into a fixture). Pure functions (`clampEffort`, `splitBeadsByProvider`, `resolveCurrentGate`, review-loop transitions) get exhaustive or property tests where the input space is small enough to enumerate.
- **Real-git tests.** The patch-id rule is tested against a temporary repository with real commits, rebases, merges, and interleaved authors, because a mocked `git patch-id` would only test the mock.
- **Script tests.** `scripts/agy/*.mjs`, `scripts/check-bead-verify.mjs`, and `scripts/check-pstack-vendor.mjs` are imported or spawned from vitest with temp directories as targets, never `~/.gemini`.
- **Fault injection.** The AGY sync is killed between journal write and rename; hook wrappers receive empty and malformed stdin; `agy models` and `ntm spawn --help` time out; the decision writer races 50 appends.
- **Migration.** A frozen v3.25 checkpoint fixture loads, resumes the right gate, and round-trips without losing fields.
- **Doc-count tests.** Counts stated in `AGENTS.md`, `README.md`, and skill text are asserted against code and vendored files.
- **Live checks (manual, recorded in the bead's completion report).** `agy plugin validate ~/.gemini/config/plugins/agent-flywheel --strict --json` after a real `--write`; one `ntm spawn` with `--agy=1:gemini-4-argon@high` in a throwaway session, confirming the pane runs the resolved slug; one AGY session confirming the `agent-flywheel` MCP server lists its tools and the `PreToolUse` guard denies `am doctor repair`.

Known pitfalls to apply in every test bead: doctor tests pass `{ exec: createMockExec() }`; the `/fake/cwd` profile-cache stderr noise is expected; a fresh worktree needs `npm ci` before tsc or vitest.

---

## 6. Acceptance criteria

The goal is met when all of these pass on one commit, with outputs recorded in the final bead's completion report:

1. `cd mcp-server && npx tsc --noEmit` exits 0, and `npx tsc --noEmit --listFiles | wc -l` is above 0 and at least the W0.2 baseline.
2. `npm run build` exits 0 and `git status --porcelain mcp-server/dist` is empty afterward (no dist drift).
3. `npm test` exits 0 with no fewer test files than the baseline plus the new files listed in this plan.
4. `npm run check:skills-bundle` exits 0, and `flywheel_get_skill({ name: "agent-flywheel:poteto-mode" })` returns `source: "bundle"`.
5. `npm run lint:skill` and `npm run verify:error-meta` exit 0.
6. `scripts/sync-agy.sh --check --target <fresh tmp dir>` exits 1, then `--write --target <same>` exits 0, then `--check --target <same>` exits 0; when `agy` is on PATH, the run reports `agy plugin validate` with zero errors.
7. `scripts/sync-opencode.sh --check` matches its baseline result.
8. `node scripts/check-bead-verify.mjs scripts/__fixtures__/check-bead-verify/pass.md` exits 0 and every `fail-*.md` fixture exits 1; `node skills/poteto-mode/scripts/check-plan.mjs skills/poteto-mode/__fixtures__/program.md` exits 0.
9. `node scripts/check-pstack-vendor.mjs` exits 0.
10. The rendered `rules/AGENTS.md` is at most 24,000 bytes, and the rendered `plugin.json` has only AGY-recognized fields.
11. A v3.25 checkpoint resumes on the gate it was on.

---

## 7. Risks and mitigations

| Risk | Failure it causes | Mitigation in this plan |
|---|---|---|
| Rules truncation in AGY | Agents in AGY follow a third of the hard constraints | D4 byte budget, D1 check, verbatim hard-constraint test |
| Silent `plugin.json` field drop | Metadata the sync thinks it set never takes effect | D1 exact-field validation, `agy plugin validate --strict` |
| Hook output contract mismatch | AGY ignores or misreads a hook; a deny-on-parse-error bricks sessions | D3 wrappers, JSON-on-every-path tests, allow on malformed input |
| Effort-suffixed agy slugs | Panes start on a nonexistent or default model | 3.3 resolution, W2.5 spawn-time failure listing available slugs |
| Concurrent edits to WIP files | Lost work, reservation conflicts | W0.1 owner hand-off before W2.5 and W2.8 |
| Gate index remap | Review resumes on the wrong gate, circuit ends early | 3.7 ids, legacy map, set-based circuit completion |
| Path traversal through ids | Writes outside `.pi-flywheel/` | W0.3 `safeJoinUnder` before B1 and C1 |
| Interleaved TSV appends | Corrupt decision rows | 3.5 `O_EXCL` header, single sub-4 KB write per row |
| Patch-id false carry-forward | A verdict survives a changed diff | per-commit multiset match, null patch id never matches, real-git tests |
| `ratio` reshaped | Doctor and docs misreport the swarm mix | `ratio` frozen at three fields, `ratioByLane` added |
| pstack upstream drift | Vendored skills silently diverge, counts change | E1 hashes and recorded patches, count tests, `pstack_vendor` doctor check |
| check-plan run on flywheel plans | False failures, or a vacuous pass on an empty file | E3 separate flywheel validator, "no bead sections" exits 1 |
| ntm version string ordering | A dirty build reports a version that compares wrong | W2.5 probe `ntm spawn --help` for `--agy` |
| SSH exec lacks stdin | Offloaded waves compute empty patch ids | W0.3 forward `input` or throw a typed error, with a test |
| Prompt size growth from brief and principles | Prompts exceed budget, panes truncate | W2.4 collapse rule, `prompt-budget.ts` delta recorded |
| Bundle growth from ~60 vendored skills | Slower `flywheel_get_skill` load, larger dist | measure `skills.bundle.json` size before and after in W3.3 and record it; the bundle already lazy-loads per process |

---

## 8. Decisions this plan makes (for synthesis to confirm or overturn)

1. **agy fills the Gemini seat as a second transport rather than a fourth primary lane.** This keeps the three-family diversity invariant and the three-field `ratio`. If synthesis wants agy as a fourth primary, `ratioByLane` has to replace `ratio` in every reader first, in its own bead, before the routing change.
2. **The verification ledger is one JSON file per `(beadId, headSha)`, not a shared TSV.** One writer per file removes the lock orch needs, and the TSV view is derivable for humans.
3. **`FW_VERIFICATION_REQUIRED` and `FW_ORCH_BRIEF_REQUIRED` start warn-only,** matching how attestation shipped in v3.11.0, so existing swarms don't hard-stop on the first wave after upgrade.
4. **`check-plan.mjs` is vendored verbatim and not run on flywheel plans;** the flywheel gets its own validator for the bead verify fields.
5. **The AGY sync imports OpenCode's transaction engine** instead of copying it, so a fix to locking or recovery lands in both mirrors.

---

## Appendix A: future direction (out of scope for v1)

- A single `scripts/sync-harness.mjs` that drives OpenCode and AGY from one manifest format with per-harness transform profiles.
- Flip `FW_ATTESTATION_REQUIRED`, `FW_VERIFICATION_REQUIRED`, and `FW_ORCH_BRIEF_REQUIRED` to required by default once a release cycle shows no false blocks.
- A `/correct` loop that turns a recurring review finding into an `OPER`/`RESERVE`-style lint rule automatically, with the failing past commit as its fixture.
- Native AGY tool-name discovery for MCP hooks, so the `flywheel_approve_beads` post-hook can be ported once a real session records the tool's AGY name.
