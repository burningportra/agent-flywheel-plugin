---
name: flywheel-mine-patterns
description: >-
  Mine cass session history for recurring workflows and propose them as new
  skills, refinements to existing skills, or flywheel pipeline tweaks. Use when
  "what should we automate next?", "find repeated rituals", or after a long
  stretch of agent work to harvest tacit knowledge into beads.
---

# flywheel-mine-patterns

> Your repeated prompts and tool sequences ARE your methodology. Mine them, classify them, codify them.

Mine the last N days of `cass`-indexed session transcripts to surface recurring
patterns: repeated tool sequences, error→fix loops, prompts typed 5+ times.
Classify each as (a) new skill scaffold, (b) refinement to an existing skill,
or (c) flywheel pipeline tweak. Present a numbered candidate list. User picks
→ `br create` lands beads with clear scope. Hands off to `/agent-flywheel:flywheel-refine-skill`
or `claude-md-synthesizer` for actual codification.

`$ARGUMENTS` may include `--days N` (default 7), `--workspace <path>` (default
cwd), or `--limit M` (default 50 hits per query).

## When to invoke

- **End of a flywheel sprint** — a wave just merged; harvest the rituals that emerged before they fade.
- **"What should I automate next?"** — explicit request for skill ideas grounded in real usage, not speculation.
- **After repeated friction** — the same error class keeps reappearing across sessions; surface the fix loop and codify it.
- **Skill-refinement triage** — `/agent-flywheel:flywheel-refine-skills` flagged a skill as "no evidence found" — mine to find the missing evidence.
- **Onboarding a new project** — months of agent history exist; the goldmine has never been swept.

Do NOT invoke for: one-off questions ("find that prompt"), single-session
search (use `/agent-flywheel:cass` directly), or auto-creating skills without
review (this skill always asks).

## Step 1: Bootstrap cass

This skill does not re-implement cass — it invokes the existing `/agent-flywheel:cass`
tooling. Verify cass is healthy before mining.

```bash
cass status --json | jq '.index.fresh'   # Should be true
cass index --json                         # Refresh if stale
```

If cass is unavailable or the workspace has zero indexed sessions, STOP and
report. Do not fabricate patterns from thin data — the whole skill depends on
real session evidence.

Reference: `/agent-flywheel:cass` skill for the full command reference and
workflow recipes. Do not re-implement search logic here.

## Step 2: Mine three pattern types in parallel

Run these three queries against the cass index. The `--workspace` and
`--limit` flags come from `$ARGUMENTS`; default to cwd and 50.

### 2a. Repeated user prompts (ritual detection)

User prompts live at `line_number <= 3`. Group by normalized title, count
occurrences. Prompts repeated 5+ times are rituals worth codifying.

Note: do NOT pass `--fields minimal` here — it strips `title`, which is what
we group on. The default field set is what you want; pay the token cost.

```bash
cass search "*" --workspace "$WORKSPACE" --json --limit 2000 \
  | jq '[.hits[]
      | select(.line_number <= 3)
      | .title[0:120]]
    | group_by(.)
    | map({prompt: .[0], count: length})
    | sort_by(-.count)
    | map(select(.count >= 5))
    | .[0:20]'
```

If a busy workspace returns <5 ritual hits at threshold 5, drop the threshold
to 3 — small workspaces still surface real patterns at lower counts. Note the
threshold used in the candidate evidence so reviewers can calibrate.

### 2b. Repeated tool sequences

Export recent sessions with `--include-tools` and look for tool n-grams that
recur. A tool trigram (e.g., `Read → Edit → Bash`) appearing across 5+ distinct
sessions is a procedural ritual.

```bash
cass search "*" --workspace "$WORKSPACE" --json --fields minimal --limit 200 \
  | jq -r '.hits[].source_path' | sort -u > /tmp/3po-sessions.txt

# For each session, export tool calls; mine n-grams offline.
while read -r path; do
  cass export "$path" --format json --include-tools -o "/tmp/3po-$(basename "$path").json"
done < /tmp/3po-sessions.txt
```

Extract trigrams from the exported JSONs. Heuristic: any trigram appearing in
≥5 distinct session files is a candidate sequence.

### 2c. Error → fix loops

Search for failure markers immediately followed by a successful retry.

```bash
cass search "Error\|failed\|FAIL\|panic" --workspace "$WORKSPACE" \
  --json --fields minimal --limit 100 --mode lexical \
  | jq '[.hits[] | {path: .source_path, line: .line_number, title: .title[0:100]}]'
```

For each hit, `cass expand <path> --line <N> --context 5` to see whether the
next 1-3 messages contain a retry that worked. Repeated error-class →
recovery-prompt pairs are prime candidates for skills.

## Step 3: Classify each candidate

For every pattern surfaced in Step 2, decide one of three buckets:

| Bucket | Trigger | Target |
|---|---|---|
| **(a) New skill scaffold** | The pattern crosses ≥3 distinct projects/contexts AND no existing skill covers it | `skills/<new-name>/SKILL.md` (new file) |
| **(b) Refinement to existing skill** | The pattern matches an existing skill's domain but the skill missed the case (evidence: skill was loaded but user still hand-rolled the workflow) | Existing `skills/<name>/SKILL.md` (handoff to `/agent-flywheel:flywheel-refine-skill`) |
| **(c) Flywheel pipeline tweak** | The pattern is procedural glue (e.g., "always run X before Y", "add Z to checkpoint") that belongs in the orchestrator, not a standalone skill | `skills/start/SKILL.md` or AGENTS.md (handoff to `/claude-md-synthesizer`) |

Disambiguation rule: if a candidate could plausibly be (a) OR (b), prefer (b).
Refining an existing skill compounds; spawning a new one fragments.

## Step 4: Present the candidate list

Render candidates as a numbered Markdown list. Each entry MUST include all
five fields below. Drop any candidate missing evidence — speculation is not
allowed in this list.

```
### Candidate 1 — [bucket: (a) new skill | (b) refine | (c) pipeline]

- **Pattern**: <one-line summary, e.g., "User runs `npm run build && npm test` then greps for 'FAIL' across 14 sessions">
- **Evidence**: <2-3 cass excerpts with source_path:line citations>
  - `~/.claude/projects/foo/abc.jsonl:3` — "run the build and check for failures"
  - `~/.claude/projects/foo/def.jsonl:2` — "build, test, find failures"
  - … (≥3 distinct sessions for rituals; ≥2 distinct error→fix pairs for loops)
- **Proposed action**: <new skill | refine existing | pipeline tweak — exact action verb>
- **Target file**: `skills/<name>/SKILL.md` (or specific section of an existing file)
- **Acceptance criteria**: <2-3 bullets the bead should require>
```

Display all candidates in one batch. Limit the list to the top 10 by
evidence-strength (frequency × distinct-sessions). If <3 candidates survive
the evidence bar, output the available ones and note: "Only N candidates met
the ≥3-session evidence bar. Consider widening `--days` or skipping codification."

## Step 5: User picks → create beads

Present an `AskUserQuestion` with the numbered list and let the user pick
which candidates to land as beads. NEVER auto-create beads — the user always
chooses.

For each selected candidate, create one bead via `br create`:

```bash
br create "<one-line title from candidate>" -p 2 -t task --body "$(cat <<'EOF'
## Pattern (mined by /agent-flywheel:flywheel-mine-patterns)

<full candidate text from Step 4 — pattern, evidence, proposed action, target file>

## Acceptance criteria

<bullets from candidate>

## Handoff

After implementation, run /agent-flywheel:flywheel-refine-skill <name>  (bucket b)
                       OR /claude-md-synthesizer                         (bucket c)
                       OR scaffold a new skill from skills/_template/    (bucket a)

Mined-from: <short cass citation, e.g., "14 occurrences across 7 sessions, last 7 days">
EOF
)"
```

After creating each bead, print `✓ Created <bead-id>: <title>`. Do not chain
dependencies automatically — let the user run `/agent-flywheel:idea-wizard`
or wire dependencies manually if needed.

## Step 6: Optional handoff

After beads are created, ask once via `AskUserQuestion`:

```
"Hand off any of these to a codification skill now?"
- "Yes — refine an existing skill" → invoke /agent-flywheel:flywheel-refine-skill <name>
- "Yes — synthesize CLAUDE.md / AGENTS.md updates" → invoke /claude-md-synthesizer
- "No — leave them as beads for later"
```

If the user picks a codification path, invoke the named skill via the `Skill`
tool with the relevant bead ID(s). Otherwise stop — the beads are the deliverable.

## Anti-patterns (DO NOT)

| Don't | Do |
|---|---|
| Auto-write SKILL.md files from mined patterns | Always create beads first; let `/agent-flywheel:flywheel-refine-skill` or a human author the file |
| Modify existing SKILL.md files directly | That is `/agent-flywheel:flywheel-refine-skill`'s job — hand off |
| Inline cass search logic | Reference `/agent-flywheel:cass` and call its commands |
| Inline `cm` / memory logic | Reference `/agent-flywheel:memory` |
| Pre-create beads for hypothetical candidates | Candidates only land as beads after user picks |
| Fabricate evidence to fill the list | Drop candidates that lack ≥3 distinct sessions |
| Extend cass itself if a query is missing | STOP and report — do not reshape cass |
| Mine across all-time on first run | Default to last 7 days; widen only if the user asks |

## Notes

- Read-only over the cass index; mutates state only via `br create` and only on user confirmation.
- Idempotent: re-running on the same window will surface the same candidates. Beads are deduped by title — `br create` rejects duplicates.
- Runtime: a 7-day mine on a busy workspace takes 30-60s of cass queries plus offline n-gram extraction.
- If `cass status --json` reports `index.fresh: false`, run `cass index --json` first — stale index produces stale candidates.

## See also

- `/agent-flywheel:cass` — the underlying session search engine (this skill calls it)
- `/agent-flywheel:memory` — long-term rule storage; complementary, not a substitute
- `/agent-flywheel:flywheel-refine-skill` — codifies bucket-(b) candidates into existing SKILL.md edits
- `/claude-md-synthesizer` — codifies bucket-(c) candidates into CLAUDE.md / AGENTS.md
- `/agent-flywheel:idea-wizard` — operationalizes the resulting beads with dependencies and tests
- `skills/_template/SKILL.md` — scaffold for bucket-(a) brand-new skills
