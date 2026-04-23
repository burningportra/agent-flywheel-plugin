---
name: flywheel-compound-refresh
description: Sweep docs/solutions/ to consolidate, replace, or archive stale and duplicate learnings — never auto-deletes.
---

Run a compound-engineering refresh sweep over the durable `docs/solutions/` learning store.

## Why this skill exists

The `docs/solutions/` store accumulates monotonically. Without periodic pruning it produces contradictory guidance for components that have been rewritten: an old "use sync exec" lesson sits alongside a fresh "we now use async exec" lesson and nothing flags the drift. This sweep ports CE's Phase 1.75 5-vector scoring rubric to surface those collisions and archive the losers — never deletes.

## Hard rules

- **Never auto-delete.** Delete classifications ALWAYS require an `AskUserQuestion` confirmation before action. The default mode (no flags) only acts on Keep / Update / Consolidate / Replace.
- **Archive, don't `rm`.** Anything pruned moves to `docs/solutions/_archive/<original-relative-path>`. Use `git mv` so history is preserved.
- **Rename detection before stale.** Before believing a component is gone, run `git log --follow -- <component-hint-path>` and check whether the file was renamed. A rename is NOT staleness.
- **Read-only first run.** On first invocation, ALWAYS render the report without asking permission to act. The user opts in to mutation in a second prompt.

## Steps

1. **Bootstrap Agent Mail.** `macro_start_session(human_key: cwd, program: "claude-code", model: your-model, task_description: "Compound refresh sweep")`. Use a `<adjective><noun>` identity (e.g. `CoralDune`); the mail server rejects descriptive role names.

2. **Locate the learning store.** Check that `docs/solutions/` exists. If not, output `No docs/solutions/ corpus yet — run /flywheel-start to seed one via Step 10.55.` and stop.

3. **Run the scorer.** Use the `flywheel_memory` MCP tool with `operation: "refresh_learnings"`. The tool reads every `docs/solutions/**/*.md` (skipping `_archive/`), parses frontmatter via the schema in `mcp-server/src/solution-doc-schema.ts`, groups by `(problem_type, component)`, and returns a `RefreshReport` with per-group decisions.

   If the MCP tool is unavailable in the current harness, fall back to invoking the algorithm directly via `tsx mcp-server/src/refresh-learnings.ts` from a small wrapper — but prefer the MCP path so error envelopes flow through the standard `hint` channel (bead 478 contract).

4. **Run rename detection (optional but recommended).** Before classifying anything as stale, for each unique `frontmatter.component` value, run:
   ```
   git log --follow --name-only --pretty=format: -- "**/<component>*"
   ```
   Pass the result as the `staleProbe` callback when re-running the sweep with mutation intent. Without `staleProbe`, the algorithm refuses to emit Delete or Replace.

5. **Render the report.** Group output by classification:
   ```
   Keep:        N entries (singletons, no overlap)
   Update:      N groups (related but low overlap — flag for manual merge)
   Consolidate: N groups → archive M entries, keep primary
   Replace:    N groups → archive M stale entries, keep fresh primary
   Delete:     N entries (REQUIRES CONFIRMATION below)
   Unparseable: N files (frontmatter malformed — review by hand)
   ```
   For each non-Keep decision, print:
   - The primary path (the one being kept).
   - Each archive candidate path with the per-dimension overlap score.
   - The decision `reason`.

6. **AskUserQuestion gate (Consolidate / Replace).** Ask:
   ```
   Apply N Consolidate + M Replace decisions? Archives go to docs/solutions/_archive/.
   - yes      apply all
   - review   walk through one by one
   - no       skip mutation, report only
   ```

7. **AskUserQuestion gate for Delete (mandatory, separate prompt).** For EACH Delete candidate, ask explicitly:
   ```
   Archive `<path>`? Component "<component>" appears stale (score: X.XX).
   Files referenced: <files from body>
   - archive  move to docs/solutions/_archive/
   - keep     leave it (false positive — make a note)
   - skip     defer to next sweep
   ```
   NEVER batch Delete confirmations. NEVER default to "archive".

8. **Apply mutations.** For each approved archive candidate:
   ```bash
   mkdir -p docs/solutions/_archive/<category>
   git mv docs/solutions/<category>/<file> docs/solutions/_archive/<category>/<file>
   ```
   Stage all moves, then surface the diff for review before committing.

9. **Report.** Output:
   ```
   Refresh sweep complete.
   Archived: N entries → docs/solutions/_archive/
   Consolidated: M groups (kept primaries)
   Updated (manual review needed): K groups
   Unparseable: P (review by hand)
   Elapsed: X.X seconds
   ```

10. **Shutdown agent-mail identity.** `deregister_agent` and exit cleanly.

## Don'ts

- **DO NOT** call `rm`, `git rm`, or `fs.unlink` on any docs/solutions entry. Always `git mv` to `_archive/`.
- **DO NOT** batch Delete confirmations into a single prompt. Each Delete is its own decision.
- **DO NOT** lower thresholds without telling the user. The defaults (0.75 / 0.85 / 0.9) match CE's published rubric; deviations need an audit trail.
- **DO NOT** classify entries inside `docs/solutions/_archive/` — the algorithm already skips them, but a manual `rg` over `docs/solutions` will surface them; remember to filter.
- **DO NOT** skip the rename probe for repos that move files frequently. False-positive Delete is the failure mode the bead spec explicitly calls out.
