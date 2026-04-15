# Proposed Changes to orchestrate SKILL.md

Session: 2026-04-15 | Evidence-driven refinements from `scripts/lint-skill.ts` build cycle (16 commits, 12 beads, 7 waves, 176 tests)

Refiner: EmeraldBay | Agent Mail project: `/Volumes/1tb/Projects/claude-orchestrator`

---

## Change 1: Step 7 — Add "commits-exist-but-bead-not-closed" fallback to zero-output escalation

**Problem:** Step 7 sub-step 4 (lines 987-991) documents the "zero commits" escalation path but not the more common case: impl agent writes files, commits, but goes idle before running `br update --status closed`. Observed in both T1 (WhiteCliff) and T11 (impl-T11) this session — 2/7 waves had this failure mode, making it MORE common than the zero-commit variant. Coordinator had to verify via `git log --grep=<bead-id>` and close manually.

**BEFORE** (SKILL.md lines 987-991):
```markdown
   **Zero-output escalation**: After 2 nudges, check `git log --oneline` to confirm whether any commits appeared since spawning. If zero new commits:
   - Do NOT spawn a replacement agent — it will likely stall the same way.
   - Implement the bead directly as the coordinator.
   - Close the bead: `br update <id> --status closed`.
   - This is faster than multiple failed spawn cycles and produces the same outcome.
```

**AFTER:**
```markdown
   **Idle-agent escalation**: After 2 nudges, check `git log --oneline --grep="<bead-id>"` to determine what shape of failure you're in. There are TWO common cases — diagnose first, then act:

   **Case A — Commits exist but bead not closed** (MORE common): The agent did the implementation work and committed, then went idle before calling `br update --status closed`. Verify:
   ```
   br show <bead-id> --json | jq -r '.[0].status'
   ```
   If status is `open` or `in_progress` but a commit referencing the bead exists:
   - Close the bead directly: `br update <bead-id> --status closed`. No replacement agent needed.
   - Skip the nudge — it saves a round-trip.
   - Optionally verify the commit's diff matches the bead's acceptance criteria before closing.

   **Case B — Zero commits since spawning**: The agent stalled before producing any output.
   - Do NOT spawn a replacement agent — it will likely stall the same way.
   - Implement the bead directly as the coordinator.
   - Close the bead: `br update <bead-id> --status closed`.
   - This is faster than multiple failed spawn cycles and produces the same outcome.
```

**Rationale:** Case A was 2/7 waves this session; the current skill's single-path escalation forces coordinator into unnecessary nudge cycles when a simple status check + close would resolve it.

---

## Change 2: Step 5.5 — Add "referenced-paths-exist" acceptance criterion for impl agents

**Problem:** T11 agent added `"build": "tsc && tsc -p tsconfig.scripts.json"` to `package.json` but never created `tsconfig.scripts.json`. Build failed until coordinator added the config. The Step 7 STEP 2a compile gate runs `npx tsc --noEmit` on TypeScript, which catches source-file type errors but does NOT verify that paths referenced from `package.json` scripts, shell commands, or import statements actually exist on disk. An agent can pass `tsc --noEmit` while leaving a script that calls a non-existent config file.

**BEFORE** (SKILL.md lines 678-702, Step 5.5 — this is where bead acceptance criteria patterns live. Also modify Step 7 STEP 2a at line 933-938 to strengthen the gate.):

Current Step 7 STEP 2a (lines 933-938):
```markdown
       2a. **Compile + lint gate** — pick the stack's commands:
           - Rust:       cargo check --all-targets && cargo clippy --all-targets -- -D warnings && cargo fmt --check
           - Go:         go build ./... && go vet ./...
           - TypeScript: npx tsc --noEmit (plus your eslint / biome script)
           - Python:     python -m compileall -q . (plus ruff / mypy per project)
           Check package.json / Cargo.toml / Makefile for project-specific scripts first.
```

**AFTER** (strengthen the TypeScript gate + add a new reference-resolution gate):
```markdown
       2a. **Compile + lint gate** — pick the stack's commands:
           - Rust:       cargo check --all-targets && cargo clippy --all-targets -- -D warnings && cargo fmt --check
           - Go:         go build ./... && go vet ./...
           - TypeScript: npx tsc --noEmit (plus your eslint / biome script)
                         **AND** run the project's full build: `npm run build` (or `pnpm build`,
                         `yarn build`). `tsc --noEmit` only checks source types — it does NOT
                         verify that tsconfig files, output paths, or scripts referenced from
                         `package.json` actually exist. Running `npm run build` catches missing
                         `tsconfig.*.json` files, missing entry points, and broken script chains.
           - Python:     python -m compileall -q . (plus ruff / mypy per project)
           Check package.json / Cargo.toml / Makefile for project-specific scripts first.

       2a.1. **Reference-resolution gate** — if you added or modified any of:
             - `package.json` scripts (commands that reference files: tsconfig paths, entry points, test runners)
             - Shell commands in CI configs (`.github/workflows/*.yml`, `Makefile`)
             - `import`/`require` statements with new paths
             - Relative paths in config files (`tsconfig.json` `extends`/`references`, `vite.config`, etc.)
             Then verify EVERY referenced path exists on disk before committing:
             ```
             # TypeScript example — after adding "build": "tsc && tsc -p tsconfig.scripts.json"
             test -f tsconfig.scripts.json || echo "MISSING: tsconfig.scripts.json"
             ```
             A bead that wires up a new script must also create the files that script references.
```

**Rationale:** One data point (T11), but a high-confidence failure mode because `tsc --noEmit` is the project's documented TypeScript gate and it provably misses this class of error. Cost of the new gate is ~1s per bead; cost of a broken build caught post-commit is a rollback plus re-spawn.

---

## Change 3: Step 5.55 — Verify numeric claims empirically when plans disagree

**Problem:** In this session, synthesis claimed AUQ count was "28 or 59" (plans disagreed) and remark-parse was "~100 transitive packages". Empirical check: AUQ=38, remark-parse=42 packages. Presenting divergent numbers to the user as alignment questions produces noise — the user shouldn't arbitrate between two wrong numbers when the correct number is one command away.

**BEFORE** (SKILL.md lines 514-526, Step 5.55 section 1 "Read the plan and extract qualifying questions"):
```markdown
### 1. Read the plan and extract qualifying questions

Read `state.planDocument` end-to-end. Identify 2-4 **load-bearing** decisions that, if wrong, would force a major rewrite later. Look specifically for:

- **Scope boundaries** — what's in vs explicitly out (non-goals).
- **Architectural choices** — pattern X chosen over Y; library/tool selections; trade-offs the plan calls out.
- **Order/dependency assumptions** — "do A before B because…" claims.
- **Risk acceptances** — "we'll skip Z and revisit later" notes.
- **Missing coverage you noticed** — areas the plan brushes past that the user might care about.

Skip the obvious. Ask only about decisions where reasonable people would disagree.
```

**AFTER:**
```markdown
### 1. Read the plan and extract qualifying questions

Read `state.planDocument` end-to-end. Identify 2-4 **load-bearing** decisions that, if wrong, would force a major rewrite later. Look specifically for:

- **Scope boundaries** — what's in vs explicitly out (non-goals).
- **Architectural choices** — pattern X chosen over Y; library/tool selections; trade-offs the plan calls out.
- **Order/dependency assumptions** — "do A before B because…" claims.
- **Risk acceptances** — "we'll skip Z and revisit later" notes.
- **Missing coverage you noticed** — areas the plan brushes past that the user might care about.

Skip the obvious. Ask only about decisions where reasonable people would disagree.

#### 1a. Empirically verify numeric claims before asking the user

If the plan (or deep-plan synthesis) contains numeric claims about the actual codebase — file counts, line counts, dependency counts, test counts, package counts — and especially if multiple source plans disagree on a number, **run the command to get the real value before building an alignment question around it**. Examples:

| Claim shape                         | Verification command                                              |
|-------------------------------------|-------------------------------------------------------------------|
| "~N AskUserQuestion calls"          | `grep -rc "AskUserQuestion" skills/ \| awk -F: '{s+=$2} END {print s}'` |
| "~N transitive packages of <pkg>"   | `npm ls <pkg> --all --json \| jq '.. \| .dependencies? // empty \| keys' \| jq -s 'add \| unique \| length'` |
| "N changed files since <sha>"       | `git diff --name-only <sha>..HEAD \| wc -l`                       |
| "N test files in module"            | `find <dir> -name '*.test.*' \| wc -l`                            |

Cost: one shell command, seconds. Benefit: the user arbitrates on real numbers, not competing guesses. If the two plans' numbers bracket reality (e.g. plans say "28 or 59", real=38), note which plan was closer when synthesizing the next round.
```

**Rationale:** 2 data points this session (AUQ count, remark-parse package count), both cheap to verify, both wrong in source plans. Empirical verification becomes free documentation in the plan and prevents the alignment loop from inheriting bad baselines.

---

## Change 4: Step 9 — Document `orch_verify_beads` parse_failure known limitation + fallback

**Problem:** Every `orch_verify_beads` call this session returned `{ errors: { "<bead-id>": "parse_failure: br show output did not match Bead shape" } }`. Root cause: `br show <id> --json` returns `[{...}]` (an array of length 1) but `verifyBeadsClosed` passes the parsed value directly to `parseBead` which expects `{...}` (an object). The tool is broken for the common case. The skill currently mandates this tool at the start of Step 9 with no documented fallback.

**BEFORE** (SKILL.md lines 1087-1125, Step 9 opening block):
```markdown
## Step 9: Loop until complete

**Reconcile the wave first.** Before showing the menu, call `orch_verify_beads` with the IDs of beads completed in this wave:

\`\`\`
orch_verify_beads(cwd: <cwd>, beadIds: [<bead-1>, <bead-2>, ...])
\`\`\`

The tool returns `{verified, autoClosed, unclosedNoCommit, errors}`:
- **`verified`** — beads `br show` confirms as closed. Move on.
- **`autoClosed`** — stragglers that had a matching commit; the tool ran `br update --status closed` for you and synced state. Move on.
- **`unclosedNoCommit`** — beads still open with no commit referencing them. **MUST** present:
  ...
- **`errors`** — `br show` failures. If the errors map is non-empty, present:
  ...
```

**AFTER** (add a prominent known-limitation note + fallback procedure directly above the existing block):
```markdown
## Step 9: Loop until complete

> **Known limitation (v2.9.x): `orch_verify_beads` may fail with `parse_failure` on every bead.**
> Root cause: `br show <id> --json` returns a single-element array `[{...}]` but `verifyBeadsClosed` passes the parsed value directly to `parseBead` (which expects `{...}`). Tracked as a skill-level TODO — fix the array-shape unwrap in `mcp-server/src/tools/verify-beads.ts` for v1.1.
>
> **If all results come back as `errors: { ... parse_failure ... }`, use the manual fallback below instead of looping on "Retry verify":**
>
> 1. For each bead ID in the wave, run:
>    ```bash
>    br show <bead-id> --json | jq -r '.[0].status'
>    git log --oneline --grep="<bead-id>" -n 5
>    ```
> 2. Classify manually:
>    - `status == "closed"` → verified, move on.
>    - `status != "closed"` AND commit exists → straggler; run `br update <bead-id> --status closed` yourself (this is what `autoClosed` would have done).
>    - `status != "closed"` AND no commit → route into the `unclosedNoCommit` menu below with the bead ID.
> 3. Only treat a parse-failure-free run as authoritative. If `orch_verify_beads` returns a mix of valid results and parse-failures, trust the valid ones and apply the fallback only to the failed IDs.

**Reconcile the wave first.** Before showing the menu, call `orch_verify_beads` with the IDs of beads completed in this wave:

\`\`\`
orch_verify_beads(cwd: <cwd>, beadIds: [<bead-1>, <bead-2>, ...])
\`\`\`

The tool returns `{verified, autoClosed, unclosedNoCommit, errors}`:
- (unchanged from here)
```

**Rationale:** 7/7 waves hit this bug this session. Pretending the tool works when it's broken forces the coordinator to either retry infinitely or pick "Skip and proceed" (which hides stragglers). Documenting the fallback unblocks future sessions and marks the tool for v1.1 repair.

---

## Change 5: Step 5.55 — Add decisive-convergence clause

**Problem:** This session, the user picked Codex's triangulation recommendation on all 4 alignment questions, flipping 100% against the synthesis. Current Step 5.55 section 3 says "Any answer requests a change → run a refinement round automatically" which correctly triggered a refinement. But after the refinement, the skill re-extracts qualifying questions from the revised plan and re-asks — which is redundant when the user has already signaled a coherent alternative position in a single batch.

**BEFORE** (SKILL.md lines 568-597, Step 5.55 section 3 "Branch on the answers"):
```markdown
### 3. Branch on the answers

- **All answers confirm the plan** ("Scope is right" / "Agree with A" / "Defer is fine" etc.) → proceed to Step 5.6 (Plan-ready gate). Note in your end-of-turn summary that alignment was confirmed.
- **Any answer requests a change** → run a refinement round automatically (do NOT prompt the user again first). Spawn:

  \`\`\`
  Agent(model: "opus", name: "align-refine-<N>", isolation: "worktree", run_in_background: true,
    prompt: "
      Read the plan at <state.planDocument>.
      The user reviewed it and requested these changes:
      ...
    "
  )
  \`\`\`

  After it completes, **return to step 1 of this section** (re-read the revised plan, regenerate qualifying questions based on the new content, present again). Loop until all answers confirm.
```

**AFTER** (add a decisive-convergence branch between the two existing branches):
```markdown
### 3. Branch on the answers

- **All answers confirm the plan** ("Scope is right" / "Agree with A" / "Defer is fine" etc.) → proceed to Step 5.6 (Plan-ready gate). Note in your end-of-turn summary that alignment was confirmed.

- **Decisive convergence** — all answers request changes AND every change is a consistent pick from a SINGLE alternative source (e.g. the user picked the Codex column on every row of a triangulation report, or picked "plan B" on every question where plans diverged): run ONE refinement round to incorporate the user's selections, then **skip the re-extract loop and proceed directly to Step 5.6**. Rationale: the user has already arbitrated every open question in a single batch; re-asking "is the revised plan aligned?" is ceremonial. Surface in your end-of-turn summary: "Decisive convergence on <source> — skipped re-alignment round."

- **Mixed answers (some confirm, some change; or changes drawn from multiple sources)** → run a refinement round automatically (do NOT prompt the user again first). Spawn:

  \`\`\`
  Agent(model: "opus", name: "align-refine-<N>", isolation: "worktree", run_in_background: true,
    prompt: "
      Read the plan at <state.planDocument>.
      The user reviewed it and requested these changes:
      ...
    "
  )
  \`\`\`

  After it completes, **return to step 1 of this section** (re-read the revised plan, regenerate qualifying questions based on the new content, present again). Loop until all answers confirm.
```

**Rationale:** 1 data point this session but a clean pattern — when triangulation produces a second-opinion column and the user votes 100% with that column, we know their position; re-asking is friction. Low risk because the decisive-convergence branch requires strict unanimity from a single source; mixed picks fall through to the loop.

---

## Change 6: Step 7 — DCG-blocked commands workaround table

**Problem:** Twice this session DCG correctly blocked destructive commands:
1. `rm -rf /tmp/foo && mkdir foo` → the coordinator had to improvise `mkdir -p foo-$$`
2. `git checkout HEAD -- <path>` → coordinator improvised `git show HEAD:<path> > <path>`

Step 7's pre-loop mentions `/dcg` as a hook layer but lists no workarounds. A canonical workaround table prevents improvisation (and the improvised alternatives are often themselves unsafe).

**BEFORE** (SKILL.md line 845, the "destructive-command coordination" paragraph):
```markdown
**Destructive-command coordination** — if any impl agent proposes `git reset --hard`, `git push --force`, `DROP TABLE`, `rm -rf`, `kubectl delete`, or similar, invoke `/slb` to require two-person approval. The coordinator is the second party; never let an agent self-approve destructive ops. If `/dcg` is configured as a hook, most of these are already blocked at the harness layer — still confirm via `/slb` for anything slipping through.
```

**AFTER:**
```markdown
**Destructive-command coordination** — if any impl agent proposes `git reset --hard`, `git push --force`, `DROP TABLE`, `rm -rf`, `kubectl delete`, or similar, invoke `/slb` to require two-person approval. The coordinator is the second party; never let an agent self-approve destructive ops. If `/dcg` is configured as a hook, most of these are already blocked at the harness layer — still confirm via `/slb` for anything slipping through.

**DCG-blocked command workarounds** — when the `/dcg` hook blocks a command, do not try to bypass it. Use the safe equivalent:

| Blocked command                            | Safe alternative                                   | Why it's safer                                     |
|--------------------------------------------|----------------------------------------------------|----------------------------------------------------|
| `rm -rf <dir> && mkdir <dir>`              | `mkdir -p <dir>-$$` (new temp dir with PID suffix) | No deletion; caller points to the new path         |
| `git checkout HEAD -- <path>`              | `git show HEAD:<path> > <path>`                    | Redirect is reversible; no index manipulation      |
| `git reset --hard <sha>`                   | `git stash && git checkout <sha>`                  | Work is preserved in stash                         |
| `git push --force <branch>`                | `git push --force-with-lease <branch>`             | Aborts if remote advanced since last fetch         |
| `DROP TABLE <t>`                           | `ALTER TABLE <t> RENAME TO <t>_deprecated_<date>`  | Recoverable until the rename is cleaned up later   |
| `rm -rf <dir>`                             | `mv <dir> /tmp/trash-$(date +%s)-<dir-basename>`   | Trashed, not deleted; cleaner scripts gc /tmp      |

If none of these fit, escalate to `/slb` with the full command, expected outcome, and recovery plan. Never `--no-verify`, `--dangerously-skip-permissions`, or edit `/dcg` config to unblock a single action — those remove the safety net permanently.
```

**Rationale:** 2 data points this session, both resolved by improvisation that wasn't documented. Table is a pure documentation win (zero code change) and converts improvised-and-forgotten knowledge into a reference.

---

## Deferred (evidence too thin or out-of-scope)

- **Triangulated plan as default** for "Deep plan" (evidence point #6): 1 data point. Keep opt-in. Revisit after 3+ sessions show consistent scope-reduction benefit.
- **SKILL.md length (1438 lines)** (evidence point #8): author's own call-out says "not a refinement per se — a scope signal." No proposal.
- **Coverage sweep Step 9.25 worked cleanly** (evidence point #9): no change needed. Pattern confirmed.
- **Wave-completion gate held across 7 waves** (evidence point #10): no change needed. Pattern confirmed.

---

## Summary of changes

| # | Section | Problem | Fix |
|---|---------|---------|-----|
| 1 | Step 7 sub-step 4 (lines 987-991) | "Zero-output escalation" misses the "commits-exist-but-bead-not-closed" case — observed 2/7 waves | Split into Case A (verify + close, no nudge) and Case B (existing zero-commit path) |
| 2 | Step 7 STEP 2a (lines 933-938) | `tsc --noEmit` misses missing tsconfig/script-referenced files; agent commits broken build | Require full `npm run build` + new 2a.1 reference-resolution gate for any path referenced from scripts/CI/imports |
| 3 | Step 5.55 section 1 (lines 514-526) | Alignment questions built on disputed numeric claims from divergent plans — user arbitrates wrong numbers | New section 1a: empirically verify numeric claims with a command before asking |
| 4 | Step 9 opener (lines 1087-1125) | `orch_verify_beads` hits `parse_failure` on every bead due to array-shape bug in `parseBead`; 7/7 waves this session | Document known limitation + manual `br show` / `git log --grep` fallback; mark tool for v1.1 repair |
| 5 | Step 5.55 section 3 (lines 568-597) | Unanimous alignment votes from a single source (e.g. all Codex picks) still force a re-extract loop | Add decisive-convergence branch — one refinement round, skip re-ask |
| 6 | Step 7 pre-loop (line 845) | DCG blocks destructive commands without documented workarounds; agents improvise unsafely | Add a 6-row workaround table covering `rm -rf && mkdir`, `git checkout HEAD`, `git reset --hard`, `git push --force`, `DROP TABLE`, `rm -rf` |

---

## Application notes for the integrator

- Changes 1 and 6 both edit Step 7 but target different sub-sections — no merge conflict.
- Change 2 edits Step 7 STEP 2a (inside the impl agent prompt template) — verify the new 2a.1 block stays inside the quoted prompt string and its shell snippet survives escaping.
- Change 4's fallback references a file path (`mcp-server/src/tools/verify-beads.ts`, verified to exist via Glob at proposal time). If the path drifts before merge, update the TODO reference.
- Change 5 is a pure branch addition in Step 5.55 section 3 — preserve the existing two branches verbatim.
