---
name: grill-with-docs
description: >-
  Relentless goal/design interview that sharpens framing and writes durable
  docs (brainstorm artifact, ADRs, glossary) as decisions crystallize. Use when
  refining a flywheel goal, pressure-testing scope, or "grill with docs".
---

# grill-with-docs

> Adversarial goal framing for the flywheel. Interview hard. Write docs as you go.
> Exit with artifacts the planner already knows how to consume.

## When to use

- Goal is ambiguous, contested, or architectural
- Domain language is fuzzy and will leak into beads
- You need durable ADRs so later cycles do not re-litigate the same choice
- Flywheel Step 0e / "Set a goal" offered **Grill (with docs)** and the operator picked it

## When NOT to use

- Concrete bugfix / one-file chore (use Light Phase 0.5 or skip framing)
- Operator already has a detailed multi-paragraph goal (≤300 chars is not required — if scope + constraints + success criteria are already explicit, skip)
- You need a full product design spec with mockups → use `/brainstorming` instead
- You need competing scored idea lists → use `/idea-wizard` or `/flywheel-duel`

## Hard gates

1. **No plan / beads / code / implementation skills** until the Goal Card is approved.
2. **Every operator decision uses `AskUserQuestion`** (2–4 labeled options). Free-text walls of questions are bugs. The "Other" field absorbs custom answers.
3. **One load-bearing decision per turn.** Do not batch five unrelated choices into one question.
4. **Do not invent a full implementation plan.** That is Step 5 (`flywheel_plan`). Grill ends at framing + docs.

## Inputs

Expect these from the caller (orchestrator / start skill):

| Input | Source | Required |
|-------|--------|----------|
| `RAW_GOAL` | USER_INPUT or "Set a goal" Other field | yes |
| `CWD` | project root | yes |
| `GOAL_SLUG` | slugify(raw goal) — lowercase, hyphens, strip non-alphanumerics, max 80 | derive if missing |
| `TODAY` | `YYYY-MM-DD` | derive if missing |

## Process

### 0. Resume check

Before interviewing, look for prior framing:

```bash
ls docs/brainstorms/${GOAL_SLUG}-*.md 2>/dev/null | tail -1
ls docs/adr/*${GOAL_SLUG}* 2>/dev/null | head
test -f CONTEXT.md && echo has-context || test -f docs/glossary.md && echo has-glossary || true
```

If a brainstorm for this slug exists and contains `## Framing synthesis` **and** `## Scope floor` **and** `## Ambition ceiling`:

```
AskUserQuestion(questions: [{
  question: "Found prior grill/brainstorm at <path>. How to proceed?",
  header: "Resume",
  options: [
    { label: "Reuse as-is (Recommended)", description: "Skip interview; re-emit enriched goal from the existing artifact" },
    { label: "Grill deltas only", description: "Load prior answers; only re-open contested or missing decisions" },
    { label: "Start fresh", description: "Ignore prior artifact and run a full grill" }
  ],
  multiSelect: false
}])
```

- **Reuse as-is** → jump to Step 6 (handoff) using the existing file.
- **Grill deltas only** → load prior answers into working memory; only ask questions whose prior answers are missing or marked contested.
- **Start fresh** → continue from Step 1.

### 1. Context skim (silent)

Read, without dumping raw output to the user:

1. `AGENTS.md` / `README.md` (if present) — project constraints
2. `CONTEXT.md` or `docs/glossary.md` (if present) — domain terms
3. Recent `docs/adr/*.md` (top 5 by mtime) — settled decisions to avoid re-litigating
4. `git log --oneline -10` — hot paths

If the raw goal spans multiple independent subsystems, **stop and decompose first**:

```
AskUserQuestion(questions: [{
  question: "This goal looks multi-subsystem. Grill which slice first?",
  header: "Decompose",
  options: [
    { label: "Slice A first", description: "<name the first independent subsystem>" },
    { label: "Slice B first", description: "<name the second>" },
    { label: "Keep as one cycle", description: "Accept the wide scope (risky — only if truly inseparable)" }
  ],
  multiSelect: false
}])
```

Narrow `RAW_GOAL` to the chosen slice before continuing.

### 2. Relentless interview (AskUserQuestion loop)

Run **4–8 rounds**. Stop early when answers stop changing scope (see Step 3).

Prefer this question bank order. Skip any question already answered by prior artifacts or by `RAW_GOAL` itself.

#### Q1 — Problem (why now)

```
AskUserQuestion(questions: [{
  question: "What problem does '<RAW_GOAL>' solve that is painful *right now*?",
  header: "Problem",
  options: [
    { label: "Broken / failing path", description: "Something that should work does not" },
    { label: "Missing capability", description: "Users cannot do X at all today" },
    { label: "Friction / cost", description: "Works but is slow, error-prone, or expensive" },
    { label: "Strategic bet", description: "Not painful yet; we want the option" }
  ],
  multiSelect: false
}])
```

Record as answer id `problem-now`.

#### Q2 — Scope floor (smallest shippable)

```
AskUserQuestion(questions: [{
  question: "What is the SMALLEST version that is still worth shipping this cycle?",
  header: "Floor",
  options: [
    { label: "Core-only slice", description: "Load-bearing primitive only; skip every nice-to-have" },
    { label: "Happy-path MVP", description: "80% case end-to-end; defer edges and polish" },
    { label: "Time-boxed prototype", description: "Whatever lands in one cycle; throwaway OK" },
    { label: "Other (describe)", description: "Specify the floor in Other" }
  ],
  multiSelect: false
}])
```

Record as `scope-floor` (also feeds Phase 0.5 "Smallest version").

#### Q3 — Ambition ceiling (10x / not-this-cycle)

```
AskUserQuestion(questions: [{
  question: "What is the 10x version we are *not* building this cycle?",
  header: "Ceiling",
  options: [
    { label: "Breadth expansion", description: "Same pattern across every related surface" },
    { label: "Depth expansion", description: "One surface, radically smarter / automated" },
    { label: "Platform play", description: "Reusable infrastructure others build on" },
    { label: "Other (describe)", description: "Specify the ceiling in Other" }
  ],
  multiSelect: false
}])
```

Record as `ambition-ceiling`.

#### Q4 — Non-goals

```
AskUserQuestion(questions: [{
  question: "What must we explicitly NOT do this cycle?",
  header: "Non-goals",
  options: [
    { label: "No UI / UX changes", description: "Backend or tooling only" },
    { label: "No schema / data migration", description: "Keep storage shape stable" },
    { label: "No new dependencies", description: "Use what is already in-tree" },
    { label: "Other (describe)", description: "Name the non-goal in Other" }
  ],
  multiSelect: true
}])
```

Record each as `non-goal-*` / `exclude-*` / `avoid-*` so `synthesizeGoal` buckets them correctly.

#### Q5 — Success criteria (must be falsifiable)

```
AskUserQuestion(questions: [{
  question: "How will we know this goal *failed*?",
  header: "Success",
  options: [
    { label: "Tests / CI gate", description: "Named suite must stay green / reach coverage X" },
    { label: "User-visible behavior", description: "A concrete path a human can exercise" },
    { label: "Metric threshold", description: "Latency, error rate, or cost bound" },
    { label: "Other (describe)", description: "Write a falsifiable criterion in Other" }
  ],
  multiSelect: false
}])
```

Record as `success-criteria`. Reject vague answers like "it feels better" — re-ask once with a stricter prompt if needed.

#### Q6 — Constraints that kill options

```
AskUserQuestion(questions: [{
  question: "Which hard constraint would kill otherwise-good designs?",
  header: "Constraints",
  options: [
    { label: "Compatibility", description: "Must not break existing callers / checkpoints / schemas" },
    { label: "Security / privacy", description: "AuthZ, secrets, or data-handling constraints" },
    { label: "Performance budget", description: "Latency, memory, or CPU ceiling" },
    { label: "Other (describe)", description: "Name the killer constraint in Other" }
  ],
  multiSelect: true
}])
```

Record as `constraint-*`.

#### Q7 — Irreversible decision (ADR candidate)

Only ask when the interview surfaced a real fork:

```
AskUserQuestion(questions: [{
  question: "We chose <A> over <B> because <reason>. Record as an ADR?",
  header: "ADR",
  options: [
    { label: "Yes, write ADR (Recommended)", description: "Load-bearing; future explorers should not re-suggest B casually" },
    { label: "No — preference only", description: "Reversible or time-local; skip ADR" },
    { label: "Revisit the choice", description: "I am not sure — re-open the fork" }
  ],
  multiSelect: false
}])
```

If **Yes**, write `docs/adr/YYYY-MM-DD-<short-slug>.md` immediately (Step 5a). If **Revisit**, re-ask the fork with sharper options.

#### Q8 — What would make this the wrong goal?

```
AskUserQuestion(questions: [{
  question: "What evidence would prove we framed the *wrong goal*?",
  header: "Kill criteria",
  options: [
    { label: "Users want a different job", description: "Underlying job-to-be-done is elsewhere" },
    { label: "Already solved in-tree", description: "Existing path covers it; we should pick it up, not rebuild" },
    { label: "Wrong layer", description: "Should be docs / process / config, not code" },
    { label: "None — framing is solid", description: "Proceed; no kill signal known" }
  ],
  multiSelect: false
}])
```

If the operator picks anything other than "None", either reframe `RAW_GOAL` or abort back to the start menu with an explicit note.

### 3. Stop rule

Stop the interview when **any** of:

1. 8 questions asked, or
2. Last 2 answers did not change scope floor / non-goals / success criteria, or
3. Operator says framing is solid on Q8

Then present the Goal Card (Step 4).

### 4. Goal Card approval

Synthesize a short Goal Card in chat (not a file yet):

```markdown
## Goal Card
- **Goal:** <one sentence>
- **Floor:** <smallest shippable>
- **Ceiling (deferred):** <10x not-this-cycle>
- **Non-goals:** <bullets>
- **Success:** <falsifiable criterion>
- **Constraints:** <bullets>
- **ADRs this cycle:** <paths or "none">
```

```
AskUserQuestion(questions: [{
  question: "Goal Card ready. Approve framing?",
  header: "Approve",
  options: [
    { label: "Approve (Recommended)", description: "Write brainstorm (+ ADRs/glossary) and hand off to flywheel_select" },
    { label: "Tweak floor/ceiling", description: "Re-open Q2/Q3 only" },
    { label: "Tweak non-goals / success", description: "Re-open Q4/Q5 only" },
    { label: "Abort", description: "Discard; return to caller without writing artifacts" }
  ],
  multiSelect: false
}])
```

Loop until **Approve** or **Abort**. On Abort, return `{ status: "aborted" }` to the caller — do not write files.

### 5. Write durable docs

#### 5a. ADR(s) — only load-bearing

For each approved ADR candidate, write:

`docs/adr/YYYY-MM-DD-<short-slug>.md`

```markdown
# ADR: <title>

**Date:** <YYYY-MM-DD>
**Status:** accepted
**Goal slug:** <GOAL_SLUG>

## Context
<what forced the decision>

## Decision
<what we chose>

## Alternatives considered
- <B> — rejected because <reason>

## Consequences
- <positive>
- <negative / follow-ups>
```

Skip ADRs for ephemeral "not now" preferences.

#### 5b. Glossary — only new terms

If the interview named a domain concept not in `CONTEXT.md` (preferred) or `docs/glossary.md`:

- Create the file lazily if missing
- Append a one-line definition under a `## Terms` heading
- Do not rewrite existing entries without operator approval

#### 5c. Brainstorm artifact (required)

Write with the **Write** tool (not bash heredoc):

`docs/brainstorms/<GOAL_SLUG>-<TODAY>.md`

**Required shape** (planner + Phase 0.5 skip both depend on these headings):

```markdown
# Brainstorm — <goal title>

**Date:** <YYYY-MM-DD>
**Goal slug:** <GOAL_SLUG>
**Source:** grill-with-docs (skills/grill-with-docs)

## Framing synthesis

<2–4 sentences: what we are building, what we are NOT building, ambition ceiling deferred.>

## Scope floor

- **Selected:** <label>
- **Detail:** <description + Other text>

## Ambition ceiling

- **Selected:** <label>
- **Detail:** <description + Other text>

## Adjacent asks

- **Selected:** <label or "Nothing adjacent">
- **Detail:** <detail or n/a>

## Non-goals

- <bullet>

## Success criteria

- <falsifiable criterion>

## Constraints

- <bullet>

## ADRs

- <path> — <one-line decision>
- (none)

## Glossary updates

- <term>: <definition>
- (none)

## User answers

### problem-now
- **Selected:** <label>
- **Detail:** <…>

### scope-floor
…

## Planner instructions

Planner agents: read this file FIRST. Anchor the plan's scope to the Scope floor.
Reserve Ambition ceiling as a "future direction" appendix, not a v1 requirement.
Honor Non-goals and Constraints literally. Treat ADRs as settled unless the plan
explicitly reopens one with new evidence.
```

Also keep a `## Smallest version (scope floor)` / `## 10x version (ambition ceiling)` / `## Adjacent asks (scope creep radar)` mirror block if you want byte-for-byte Phase 0.5 compatibility — optional when the headings above are present.

### 6. Handoff to flywheel

Build an enriched goal string. Prefer the pure helper if the MCP server is available:

```ts
// ids MUST use the bucket keywords from goal-refinement.ts:
// scope|target|layer → Scope
// constraint → Constraints
// non-goal|exclude|avoid|value no-|avoid- → Non-Goals
// success|criteria|quality|test → Success Criteria
// else → Implementation Notes
import { synthesizeGoal } from 'mcp-server/src/goal-refinement.ts'; // conceptual
const enrichedGoal = synthesizeGoal(RAW_GOAL, answers);
```

If you cannot import the helper, format the same markdown sections by hand:

```markdown
## Goal
<one-sentence goal>

## Scope
- <floor>

## Constraints
- …

## Non-Goals
- …

## Success Criteria
- …

## Implementation Notes
- **problem-now**: …
- **ambition-ceiling**: …
- **brainstorm**: docs/brainstorms/<slug>-<date>.md
- **adrs**: <paths or none>
```

Then:

1. Call `flywheel_select({ cwd, goal: enrichedGoal })` **only if the caller asked you to** (start skill does this itself after the skill returns — see integration contract below).
2. Print a one-line summary:

```text
Grill complete → brainstorm=docs/brainstorms/<slug>-<date>.md adrs=<N> glossary=<N> status=approved
```

3. Return control to the caller. **Do not** call `flywheel_plan` or create beads.

## Integration contract (for `skills/start`)

When the start skill invokes this skill:

| Caller responsibility | This skill responsibility |
|----------------------|---------------------------|
| Capture `RAW_GOAL` | Interview + docs |
| Invoke skill / follow this body | Write brainstorm (+ optional ADRs/glossary) |
| Call `flywheel_select` after approve | Provide enriched goal text in the completion summary |
| Load `_planning.md` Step 4.5 / 5 | Phase 0.5 skip when brainstorm has required headings |
| Never double-interview | Stop after Goal Card approval |

Completion summary MUST include:

```text
GRILL_STATUS=approved|aborted
GRILL_BRAINSTORM=docs/brainstorms/<slug>-<date>.md   # if approved
GRILL_ENRICHED_GOAL=<<EOF
…markdown…
EOF
```

## Anti-patterns

| Don't | Do |
|-------|-----|
| Freeform multi-question essays | `AskUserQuestion` one decision at a time |
| Write ADRs for "not this week" | ADR only when future agents would re-suggest the rejected option |
| Produce `docs/plans/*` here | Hand off; planner owns plans |
| Re-run Phase 0.5 after a full grill | Skip 0.5 when brainstorm has floor + ceiling + framing |
| Chain brainstorm + grill + 0.5 | One framing path per goal |
| Inline-paste huge repo dumps into questions | Skim silently; ask about decisions |

## Done when

- [ ] Goal Card approved (or explicit abort)
- [ ] `docs/brainstorms/<slug>-<date>.md` written with required headings (if approved)
- [ ] Load-bearing ADRs written (if any)
- [ ] Glossary updated only for new terms (if any)
- [ ] Completion summary includes `GRILL_STATUS` + enriched goal
- [ ] No plan/bead/code side effects
