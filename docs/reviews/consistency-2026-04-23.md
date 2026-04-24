# Consistency review — 2026-04-23

Reviewer scope: conventions only (not correctness) for the 19-commit wave `dfc8c51..HEAD` (+18672/-512).
Read-only pass. Evidence cited as `file:line`.

## Summary

**Yellow, leaning green.** The wave is internally consistent on the big axes: every new MCP tool follows `flywheel_<verb>[_<noun>]`, every new `FlywheelErrorCode` is `snake_case` and participates in the `DEFAULT_RETRYABLE` map, all 19 commits are Conventional-Commits form, and the new `utils/` and `adapters/` directories use kebab-case filenames matching the pre-existing repo style. The main drift is (a) a small number of `throw new FlywheelError(...)` sites that were added/left without a `hint:` argument after the bead-478 contract, (b) adapter modules vary a lot in export count (2–9) with no stated convention, and (c) the README got three new H2 sections from three different beads that sit at three different abstraction levels without a shared rhythm. No blocking issues; a handful of small follow-ups.

## Inconsistencies (ranked)

1. **FlywheelError throw sites added without `hint:`** — `mcp-server/src/coordination.ts:273,281,305` and `mcp-server/src/lint/parser.ts:750`
   - Bead 478 (`afd29a0 feat(errors): actionable hint on every FlywheelErrorCode`) established the contract that every `throw new FlywheelError({...})` carries a `hint:` argument. Five remaining sites do not:
     - `coordination.ts:273` (`wave_collision_detected` throw — bead iy4)
     - `coordination.ts:281, 305` (same module, collision-detection paths)
     - `lint/parser.ts:750`
     - `errors.ts:146` is a pass-through re-throw in `makeFlywheelErrorResult`, which is fine — hint comes from the caller.
   - Severity: **Medium**. The two new error codes added after 478 (`wave_collision_detected`, `review_mode_gate_failed`, `review_headless_findings`) should be spot-checked against the contract too.
   - Suggested fix: add a one-sentence hint to each of the four construction sites, matching the style set by 478 (e.g., `wave_collision_detected` → "Another agent in the wave modified overlapping files; re-run `br ready --json` and re-plan the wave").

2. **README H2 sections added in this wave are at mismatched abstraction levels** — `README.md:43, 164, 172`
   - `## Triage chain: which diagnostic do I run?` (line 43) — user-facing, decision-oriented.
   - `## Using agent-flywheel with Codex` (line 164) — runtime-integration, single-tool scope.
   - `## Debugging` (line 172) — contributor-facing, knob reference.
   - Severity: **Low**. All three are useful but they arrived via separate beads (tgm, zbx, tgm) without a unifying table of contents. Triage sits between Quick start and Command reference (right spot); Codex and Debugging sit after Contributing (buried).
   - Suggested fix: on the next docs pass, consider promoting Debugging into the Command reference area and grouping Codex/Debugging under a single `## Operating` H2.

3. **Adapter modules vary widely in export count with no stated shape** — `mcp-server/src/adapters/*.ts`
   - `claude-prompt.ts` exports 2, `gemini-prompt.ts` 2, `codex-prompt.ts` 3, `agent-names.ts` 6, `model-diversity.ts` 9.
   - Severity: **Low (convention, not correctness)**. There is no written rule saying adapters are one-export-per-file; `model-diversity.ts` reads more like a service than an adapter. A contributor adding a fourth prompt adapter will not know what shape to match.
   - Suggested fix: either (a) rename `model-diversity.ts` to reflect its service role and move it out of `adapters/`, or (b) add a one-line comment in `adapters/README` or in each `*-prompt.ts` header documenting the "one render function + one context type" contract the three prompt adapters already follow.

4. **`utils/` one-helper-per-file rule is half-followed** — `mcp-server/src/utils/`
   - `text-normalize.ts` exports 1 (clean). `path-safety.ts` 10, `clone-safety.ts` 8, `fs-safety.ts` 10.
   - Severity: **Low**. The multi-export `*-safety.ts` modules are coherent (each exports its whole safety API), but the mix with a single-export `text-normalize.ts` is stylistically uneven. The original ask was "one exported-helper-per-file" and that is not what landed.
   - Suggested fix: accept the multi-export safety modules as the real convention (they are well-scoped) and either (a) fold `text-normalize.ts` into an existing utils module if it stays 1-export, or (b) leave it but note in `utils/` that the module is a container, not a namespace.

5. **`as any` and implicit-any leaked into new code** — `mcp-server/src/refresh-learnings.ts:372`
   - `Array(n).fill(null as any)` — the only new-in-this-wave production `as any` (others in `session-state.ts`, `beads.ts`, `parsers.ts`, `gates.ts` predate the wave).
   - Severity: **Low**. Tests contain more `as any`, which is fine.
   - Suggested fix: replace with `Array<OverlapScore[] | null>(n).fill(null)` or a typed sentinel — the cast is avoidable.

6. **`_template/SKILL.md` landed but its frontmatter shape is not enforced** — `skills/_template/SKILL.md`
   - The CONTRIBUTING.md three-step loop points at the template as the source of truth for new skills, but the new SKILL files in this wave (`flywheel-compound-refresh`, and the pre-existing doctor/setup/healthcheck which were edited) were not re-aligned to the template's frontmatter ordering. Without a lint pass, the template's authority is aspirational.
   - Severity: **Low**. Follow-up: either add a frontmatter-shape lint rule or a CI check that new skills round-trip against `_template`.

## Verified-consistent parts

- **MCP tool names — clean.** `flywheel_emit_codex` (zbx) and `flywheel_refresh_learnings` (operation under `flywheel_memory`, bve) follow `flywheel_<verb>_<noun>`. `orch_*` deprecation aliasing in `server.ts:256-263` was not re-introduced for the new tools, matching the stated deprecation plan.
- **FlywheelErrorCode additions — clean.** `wave_collision_detected` (iy4), `review_mode_gate_failed`, `review_headless_findings` (f0j) are `snake_case` and participate in the `DEFAULT_RETRYABLE` map and the Zod enum in `errors.ts` (sectioned with a `// bead <slug>` comment, matching the existing style for earlier codes like `tool_expansion_failed`, `telemetry_store_failed`).
- **Type names — clean.** `ReviewModeSchema`, `ReviewActionSchema`, `RescuePacket`, `EmitCodexReport`, `RefreshReport`, `SolutionDocFrontmatter` are PascalCase, consistent with `FlywheelToolErrorSchema` and the prior `state.ts` schema exports.
- **File names — clean.** All new `.ts` files are kebab-case (`codex-prompt.ts`, `model-diversity.ts`, `refresh-learnings.ts`, `solution-doc-schema.ts`, `codex-handoff.ts`, `text-normalize.ts`, `fs-safety.ts`, `clone-safety.ts`, `path-safety.ts`), matching the pre-existing repo style (`session-state.ts`, `deep-plan.ts`, `space-detector.ts`).
- **Commit messages — clean.** All 19 are Conventional Commits with informative scopes: `feat(security)`, `feat(errors)`, `feat(review)`, `feat(emit)`, `feat(memory)`, `feat(rescue)`, `feat(coordination)`, `feat(planning)`, `feat(swarm)`, `fix(io)`, `fix(loader)`, `fix(release-gate)`, `docs(debug)`, `docs(triage)`, `docs(contrib)`, `chore(dist)`, `chore(plugin)`. Bodies are imperative-mood and link bead slugs via `closes agent-flywheel-plugin-<id>` or `bead agent-flywheel-plugin-<id>` — matches the prior repo log.
- **`agent-flywheel:` / `flywheel-` prefix guidance — applied.** CONTRIBUTING.md (ioa) documents the rule and README now explains "flywheel" appearing twice in `/agent-flywheel:flywheel-doctor`. The Skill() invocations in the new commands/slash-command files use the qualified form.
- **Codex emit round-trip — documented and tested.** `emit/codex.ts` refuses to ship on malformed frontmatter (lines 167, 177, 182), consistent with the `o7b` loader-warning fix. The hand-rolled `FRONTMATTER_RE` has an explicit "don't pull gray-matter" comment — a legitimate WHY comment.
- **Test density — high.** Every new non-trivial module has a test peer (`refresh-learnings.test.ts`, `solution-doc-schema.test.ts`, `codex-handoff.test.ts`, `adapters/model-diversity.test.ts`, `utils/fs-safety.test.ts`, `clone-safety.test.ts`, `path-safety.test.ts`, `error-contract.test.ts`). No test was named in drift from the source file name.

## Style drift

1. **Comment-density creep in `errors.ts` and `telemetry.ts`** — `mcp-server/src/errors.ts`, `mcp-server/src/telemetry.ts`
   - SKILL guidance is "default to writing no comments." These two files carry long WHY-block headers (telemetry.ts header is ~20 lines). In this case the comments are genuinely WHY (re-entrancy guard rationale, v3.4.1 P1-2/P1-3 fix context), not WHAT, so the drift is acceptable — but the pattern will tempt contributors to narrate every new module. Suggested: leave these, but do not adopt the pattern in `adapters/` or `emit/`.

2. **`// bead <slug>` comment convention is inconsistent in `errors.ts`.**
   - Some new codes are tagged with `// bead <slug>` (`wave_collision_detected`, `review_mode_gate_failed`), others in the same file predating this wave are not. Pick one: either tag all codes with their origin bead or none.

3. **Mixed emdash / hyphen use in new prose.**
   - README's Triage chain uses an actual em-dash (U+2014); `## Using agent-flywheel with Codex` uses a regular hyphen minus. This is the "em-dash overuse" signal flagged by the docs-de-slopify sweep (`skills/start/_wrapup.md`). The de-slop pass was not run on the README additions this wave.

4. **Skill frontmatter consistency not audited.**
   - `_template/SKILL.md` landed as the canonical shape but no programmatic check enforces it against `skills/*/SKILL.md`. Recommend adding that as a one-line `br` lint in a follow-up bead.

---

Bead sources referenced: 478 (hint contract), iy4 (collision detection), f0j (review-mode matrix), zbx (codex emit), bve (compound-refresh), ioa (CONTRIBUTING + template), tgm (triage / debugging docs), 1qn (rescue), mq3 (path-safety), 016 (clone-safety), o7b (frontmatter loader warn), 6qj (release-gate P1-2/P1-3/P1-4), m4g (triage chain), 6nx (Phase 0.5 brainstorm), p55 (telemetry).
