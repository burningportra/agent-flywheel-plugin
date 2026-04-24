# Research Proposal — EveryInc/compound-engineering-plugin

**Date:** 2026-04-23
**Repo studied:** <https://github.com/EveryInc/compound-engineering-plugin>
**Mode:** Research-only (Phases 1–7). Integration Phases 8–12 not run.
**Our version context:** agent-flywheel-plugin v3.4.0 @ `dfc8c51`

---

## What this repo is

A Claude Code plugin that converts Claude Code agents/skills into the native formats of 6 other AI editors (Cursor, Copilot, Codex, Droid, Kiro, OpenCode). Canonical Claude Code format (YAML frontmatter + Markdown body) is the single source of truth; pluggable per-target converters produce the foreign dialects. It also bundles a "compound engineering" workflow loop (`brainstorm → plan → work → review → compound`) delivered as 7 standalone slash commands.

## Pipeline outputs (full corpus)

| Phase | Report | Focus |
|-------|--------|-------|
| 1 | [compound-engineering-phase1-explore.md](docs/research/compound-engineering-phase1-explore.md) | Architecture, entry points, testing approach |
| 2 | [compound-engineering-phase2-deep.md](docs/research/compound-engineering-phase2-deep.md) | Target registry, frontmatter parser, subprocess shimming |
| 3 | [compound-engineering-phase3-invert.md](docs/research/compound-engineering-phase3-invert.md) | Anti-patterns: orphan converters, 1356-LOC allow-list, 20 empty catches |
| 4 | [compound-engineering-phase4-blunders.md](docs/research/compound-engineering-phase4-blunders.md) | 12 concrete bugs (3 P0) |
| 5 | [compound-engineering-phase5-workflow.md](docs/research/compound-engineering-phase5-workflow.md) | Their `brainstorm→plan→work→review→compound` loop vs ours |
| 6a | [compound-engineering-apply.md](docs/research/compound-engineering-apply.md) | What to apply (8 proposals + 5 rejects, opus synthesis) |
| 6b | [compound-engineering-ergonomics.md](docs/research/compound-engineering-ergonomics.md) | Developer ergonomics (8 ideas, sonnet synthesis) |

---

## Top actionable takeaways (ranked)

### P0 — Ship before next release

1. **Durable `docs/solutions/` learning store alongside CASS.** Extend `draftPostmortem()` in `mcp-server/src/episodic-memory.ts` to emit a sibling markdown file with YAML frontmatter; write it in `_wrapup.md` Step 10.55 right after telemetry flush. Gives us a greppable, PR-reviewable, tool-portable mirror of CASS. See apply-proposal 1.
2. **Actionable `hint` on every `FlywheelErrorCode` throw site.** One-sentence recovery note co-located with each `throw` (e.g. `missing_prerequisite` → "Run /flywheel-setup"). Mechanical pass over `mcp-server/src/errors.ts` + 26 call sites. See ergonomics-idea 1.
3. **Audit our path handling against CE's three P0s.** CE's `sanitizePathName` lets `../` through; `git clone` has no SHA pinning; `forceSymlink` unlinks user files. Grep our MCP tools and `/flywheel-research` clone path for the same footguns. See phase4-blunders.

### P1 — Next cycle

4. `/flywheel-compound-refresh` sweep + `flywheel_refresh_learnings` MCP tool to prune stale `docs/solutions/` entries (depends on P0 #1).
5. Actual-modified-files collision detection in `coordination.ts` wave orchestration — reconcile via `git diff --name-only` per worker, replace declared-`Files:` trust.
6. Brainstorm step between discover and plan — AskUserQuestion-driven 3-question pressure-test, skippable when discover confidence ≥ 0.8.
7. Line-ending normalization at every file read — avoid the CRLF-BOM class of bugs CE hits in `frontmatter.ts`.
8. Ownership-guarded destructive I/O — fail-loud when touching files we don't own in doctor/cleanup paths.
9. `CONTRIBUTING.md` + `skills/_template/SKILL.md` scaffold — 30-minute onboarding for new skills.
10. Triage chain docs: `doctor` (read-only) → `setup` (fix) → `healthcheck` (audit). Collapse the naming ambiguity.

### P2 — Nice-to-have

11. Review-mode matrix on `flywheel_review` (autofix/report-only/headless/interactive).
12. Warn on unclosed frontmatter fence in SKILL.md loader.
13. `FW_LOG_LEVEL=debug` README section + doctor hint.
14. Bead template `@version` in `flywheel-status` output.
15. Structured post-mortem table in `flywheel-swarm-status`.

---

## What NOT to copy

- **Converter/target registry pattern.** Our single-platform (Claude Code) focus is a feature. A converter matrix would 5–10× complexity for zero user benefit.
- **Manual user-initiated `/compound` step.** Our auto-prompt + telemetry-driven post-mortem draft beats their discipline-reliant workflow.
- **Temperature-from-regex inference** (`claude-to-opencode.ts:321`) — magic-string inference on prose is a correctness trap.
- **1,356-LOC hand-maintained allow-list** (`legacy-cleanup.ts`) — content-hash fingerprinting is fine; hand-edited drift lists are not.
- **Skip-brainstorm-on-repeat-goal heuristic** — too easy to misfire; better to always surface the question and let the user skip.

## What we already do better (preserve)

- **End-to-end orchestration** — `skills/start/SKILL.md` drives the full loop with mandatory gates. CE's loop is 7 manually-sequenced slash commands.
- **CASS / telemetry** — machine-readable learning store. CE has markdown only.
- **flywheel-doctor + hotspot + post-mortem** (v3.4.0 observability bundle) — CE's debugging story is "read the 730-line `legacy-cleanup.ts`".
- **Smaller cohesive files** — CE has a 1874-LOC `cli.test.ts` and 616-LOC `codex.ts`; we don't.
- **Swarm + Agent Mail coordination** — CE has no parallel-worker story.

---

## Agent Mail lesson (meta)

Three research agents in this session had their `send_message` rejected: Agent Mail enforces adjective+noun names (e.g. `CoralDune`), not descriptive role names (e.g. `research-coordinator`). On-disk report files carried the work through. Saved to memory: `feedback_agent_mail_naming.md`.

---

## Recommended next actions

Pick one of:

- **Cut beads from P0 + P1** — use `/start` with this doc as the goal; it has 10 shippable proposals with file:line anchors.
- **Audit-only sprint** — run the 3 P0 path-handling audits against our repo first (read-only, no code change), then decide on P0 #1 and #2.
- **Shelve for later** — commit the research corpus, revisit on next cycle.
