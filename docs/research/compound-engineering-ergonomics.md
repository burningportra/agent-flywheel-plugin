# Compound Engineering — Phase 6b: Developer Ergonomics

**Agent:** BrassRiver (sonnet)
**Date:** 2026-04-23
**Focus:** What ideas would improve developer ergonomics in agent-flywheel-plugin?

---

## Ranked Ideas (impact / effort)

### Idea 1 — Actionable `hint` field on every FlywheelErrorCode throw site

**Effort:** S | **Impact on DX:** High

**Current pain point:** `mcp-server/src/errors.ts` defines 26 `FlywheelErrorCode` values and the `FlywheelError` class threads tagged errors through call frames. The SKILL.md orchestrator branches correctly on `result.data.error.code`, but the human-readable `message` at most sites is a raw TypeScript exception string — e.g., `exec_timeout` surfaces as "Command timed out after 30000ms" with no next-step hint. A contributor debugging a stuck swarm sees the code, not guidance.

**Their pattern:** `src/utils/frontmatter.ts` (lines ~45–50) in compound-engineering. When YAML parse fails, the thrown error appends: `\nTip: quote values containing colons (e.g. description: "foo: bar")`. One targeted sentence co-located with the `throw` eliminates a user round-trip. The "colons-in-values" note is cited in Phase 2 as "the #1 real-world YAML bug."

**Proposed change:** Add an optional `hint` field to `FlywheelError` (or inline in the `message`). Do a mechanical pass over all 26 `FlywheelErrorCode` construction sites and add a one-sentence recovery action to each — e.g., `missing_prerequisite` → "Run /flywheel-setup to install missing deps"; `concurrent_write` → "Another agent holds the lock; wait or run /flywheel-cleanup." The Zod envelope already carries the error object; adding `hint` is non-breaking.

---

### Idea 2 — `CONTRIBUTING.md` + `skills/_template/SKILL.md` scaffold

**Effort:** S | **Impact on DX:** High

**Current pain point:** `README.md` covers the "Install from source" path (four shell commands) but says nothing about adding a skill. A contributor must infer: create `skills/<name>/SKILL.md`, also create `commands/<name>.md` with the matching namespace prefix, understand the `agent-flywheel:` prefix convention, rebuild `mcp-server/dist/`, commit dist in the same PR. None of this is in one place. The `dist-drift` CI job will fail silently if the contributor doesn't know about it.

**Their pattern:** compound-engineering's `src/utils/files.ts` auto-discovers skills by glob (`SKILL.md` presence), with no manifest to update — which means adding a skill is genuinely one-file. Our repo does the same glob-discovery, but the parallel `commands/` directory requirement and the dist-rebuild step are invisible until the CI fails.

**Proposed change:** Add `CONTRIBUTING.md` documenting the three-step skill-add loop (skills dir + commands dir + rebuild). Add `skills/_template/SKILL.md` with the required frontmatter stubs, a step-skeleton, and inline comments explaining the `agent-flywheel:` namespace prefix. A new contributor can copy the template, fill in the gaps, and have a working skill in under 30 minutes without reading existing skills for hints.

---

### Idea 3 — Collapse `flywheel-setup` / `flywheel-doctor` / `flywheel-healthcheck` into a clear triage chain

**Effort:** M | **Impact on DX:** High

**Current pain point:** The `commands/` directory lists all three commands with near-identical descriptions. `README.md` describes `flywheel-setup` as "Check and install prerequisites," `flywheel-doctor` as "One-shot diagnostic of toolchain deps," and `flywheel-healthcheck` as "Full dependency and codebase health check." A first-time user experiencing a setup problem faces genuine ambiguity: which do I run first? CE has no equivalent — their debugging story is "read the 730-line legacy-cleanup.ts" — so we're ahead, but the entry point is muddled.

**Their pattern:** CE's `flywheel_doctor` (v3.4.0) diagnoses 11 toolchain dependencies in one sweep (Phase 2, Architecture section). Single command, full picture. We have that in `flywheel-doctor`, but we've also distributed the function across two siblings.

**Proposed change:** Establish and document a canonical triage chain: `doctor` = read-only snapshot (run first, always safe); `setup` = apply fixes for what `doctor` found (run second if doctor reports problems); `healthcheck` = deep ongoing codebase audit (run periodically, not for setup problems). Surface this 3-sentence hierarchy in the README command table and in the Step 0 banner's degraded-mode messages (currently `0f` only mentions `/flywheel-setup`).

---

### Idea 4 — Warn (not silently succeed) on unclosed frontmatter fence in SKILL.md files

**Effort:** S | **Impact on DX:** Medium

**Current pain point:** compound-engineering Phase 4 blunder #4 (`frontmatter.ts:22-25`) shows that an unclosed `---` fence returns `{data: {}, body: raw}` — the entire file including YAML lines becomes the prompt body. We inherit the same pattern in our skill-loading path. A contributor who forgets the closing `---` gets a skill that installs with no name and no tools, and the error surfaces only downstream as an obscure missing-field failure.

**Their pattern:** The Phase 4 report recommends: "A `---` on line 1 is a strong intent signal. If the closing fence is missing, throw with a helpful hint ('frontmatter started at line 1 but never closed — add `---`')." CE's own `frontmatter.ts` is the negative example here — we should do it correctly.

**Proposed change:** In our skill-loading path, detect `---` on line 1 with no closing `---` and throw (or at minimum emit a loud warning with the file path) rather than silently treating the whole file as body. One conditional, one error string.

---

### Idea 5 — Opt-in `FW_LOG_LEVEL=debug` documentation in README

**Effort:** S | **Impact on DX:** Medium

**Current pain point:** `mcp-server/src/logger.ts` already implements `createLogger` with `FW_LOG_LEVEL` controlling verbosity (JSON lines to stderr). This is documented only in the Architecture section of README under a bullet. A contributor debugging why a bead implementation failed has no discoverable path to "turn on verbose output."

**Their pattern:** CE has no opt-in verbose mode — their debugging story is reading large source files. We're ahead here, but only in implementation. The Phase 3 report notes: "CE has no equivalent of `flywheel-doctor`. Their debugging story is 'read the 730-line legacy-cleanup.ts.'" Our advantage is wasted if users don't know the knob exists.

**Proposed change:** Add a "Debugging" section to README (3–5 lines) explaining `FW_LOG_LEVEL=debug claude ...` and what each log level produces. Also surface it in the `flywheel-doctor` output when a run has errors — append "Tip: set FW_LOG_LEVEL=debug for full trace."

---

### Idea 6 — Bead template `@version` surfaced in `flywheel-status` output

**Effort:** S | **Impact on DX:** Medium

**Current pain point:** `mcp-server/src/bead-templates.ts` pins `@version` on all 16 bead templates. But `flywheel-status` output (described as "Show bead progress, inbox messages, next steps") doesn't show template version or which template was used for each bead. A contributor refining a bead body can't tell whether the bead was created before or after a template update.

**Their pattern:** CE uses versioned skill manifests and content-hashes for "ce-owned vs foreign" detection (Phase 3, 1.2). Explicit versioning at the artifact level prevents silent drift.

**Proposed change:** Include the template name and `@version` in the `flywheel-status` bead row (compact form, e.g., `[tpl:feature-dev@2]`). This is a read-path change only — no state migration needed since `bead-templates.ts` already emits the version into the bead body.

---

### Idea 7 — Structured "failure state inventory" after a partial swarm failure

**Effort:** M | **Impact on DX:** Medium

**Current pain point:** When a `flywheel-swarm` run fails mid-way (some agents complete, some are killed by SwarmTender), the user is left with partial worktrees, some beads committed and some not. `flywheel-cleanup` removes orphaned worktrees, but there is no command that answers: "which beads succeeded, which failed, what files did each touch?" CE's Phase 4 blunder #6 shows the failure mode of concurrent cleanup races — we avoid those with mutex locking, but the *user-facing* recovery story is still "run cleanup and re-run."

**Their pattern:** CE's legacy-cleanup uses content-hash fingerprinting to classify what state was left behind. That's too complex for us, but the concept — enumerate what state exists after a partial failure — is right.

**Proposed change:** Extend `flywheel-swarm-status` (or add a `flywheel-swarm-status --post-mortem` flag) to emit a structured table: bead ID, agent name, last known state (committed/partial/killed), worktree path if still alive, last error code. This transforms "something went wrong" into "here are the three beads that need to be re-run."

---

### Idea 8 — Consistent `agent-flywheel:` prefix enforcement at install time

**Effort:** S | **Impact on DX:** Low–Medium

**Current pain point:** Commands in `commands/` are named `flywheel-*.md` and exposed as `/agent-flywheel:flywheel-*` — so the word "flywheel" appears twice in every command name (`/agent-flywheel:flywheel-doctor`). Skills in `skills/` that are not part of the flywheel core (e.g., `brainstorming`, `ui-polish`, `frontend-design`) have no `flywheel-` prefix but still carry the `agent-flywheel:` namespace. The naming is inconsistent: some skills are conceptually "flywheel ops" and some are "general purpose," but nothing in the file structure signals the distinction.

**Their pattern:** CE's converter registry (`src/targets/index.ts`) uses a clean `name` field per target — naming is deliberate and manifest-driven. Phase 1 notes "tool name translation" as an explicit first-class concern.

**Proposed change:** Introduce a naming convention documented in `CONTRIBUTING.md`: flywheel-operation skills use `flywheel-` prefix; general-purpose utility skills (brainstorming, ui-polish) do not. Optionally, reorganize `skills/` into `skills/flywheel/` and `skills/utils/` to make the boundary visible in the directory tree. Low risk to existing users since slash-command names are plugin-namespaced.

---

## Summary Table

| # | Title | Effort | DX Impact |
|---|-------|--------|-----------|
| 1 | Actionable `hint` on FlywheelErrorCode throw sites | S | High |
| 2 | CONTRIBUTING.md + skills template scaffold | S | High |
| 3 | Triage chain: doctor → setup → healthcheck | M | High |
| 4 | Warn on unclosed frontmatter fence | S | Medium |
| 5 | Document FW_LOG_LEVEL=debug in README | S | Medium |
| 6 | Bead template @version in flywheel-status | S | Medium |
| 7 | Structured post-mortem after partial swarm failure | M | Medium |
| 8 | Naming convention: flywheel-ops vs utility skills | S | Low–Medium |

---

### Critical Files for Implementation
- `mcp-server/src/errors.ts`
- `skills/start/SKILL.md`
- `commands/flywheel-doctor.md`
- `README.md`
- `mcp-server/src/bead-templates.ts`
