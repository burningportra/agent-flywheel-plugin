# `docs/solutions/` — durable learning store

> **No corpus yet.** This directory is the navigation shell only. Solution entries land here as flywheel sessions write paired post-mortems via `flywheel_memory operation: "draft_solution_doc"`. If you are reading this and the directory contains only this README, the corpus is empty by design.

## Why it exists

Post-mortems persisted only in CASS are opaque — queryable through the `cm` CLI but not visible in PRs, not greppable across the tree, not survivable across CASS schema migrations. A sibling markdown file under `docs/solutions/` with YAML frontmatter is:

- **Greppable.** `rg 'problem_type: flaky_test' docs/solutions/` finds every prior occurrence.
- **Reviewable.** Diff-visible knowledge capture — solution entries land in PRs alongside the code that prompted them.
- **Portable.** Plain markdown + YAML; no proprietary store.
- **Resilient.** Survives CASS DB corruption / schema migrations; reconcilable via `entry_id`.

See `mcp-server/src/solution-doc-schema.ts` for the canonical Zod schema and `mcp-server/src/refresh-learnings.ts` for the sweep algorithm.

## Frontmatter contract

Every entry carries YAML frontmatter validated by `SolutionDocFrontmatter` (Zod). Required keys:

```yaml
---
entry_id: "<CASS entry id from `cm add` of the paired post-mortem>"   # required
problem_type: "<short tag, e.g. flaky_test, stale_checkpoint, db_lock>"   # required
component: "<subsystem touched, e.g. episodic-memory, worktree-pool>"   # required
category: "<build|test|runtime|tooling|coordination|docs|refactor|general>"   # default: general
tags: []   # free-form; empty array OK
---
```

The sweep groups entries by `(problem_type, component)` to detect duplicates and contradictions; component is also the key for stale-file rename detection (`git log --follow -- '**/<component>*'`).

## Category taxonomy

From `SOLUTION_CATEGORIES` in `solution-doc-schema.ts` (deliberately small; `general` is the fallback):

| Category | What goes here |
|----------|----------------|
| `build` | Build / compile / type-check failures |
| `test` | Flaky tests, coverage gaps, test infra |
| `runtime` | Production / runtime behaviour |
| `tooling` | CLI ergonomics, dev-loop, editor integration |
| `coordination` | Multi-agent / swarm / agent-mail |
| `docs` | Doc rot, skill refinement, README |
| `refactor` | Architecture, extract, rename |
| `general` | Fallback when nothing fits |

Downstream code accepts any non-empty string for `category` — the list above is the canonical set, not a hard constraint.

## Layout

```
docs/solutions/
├── README.md          ← this file
├── _archive/          ← demoted entries (created on first sweep; never auto-deleted)
└── <category>/        ← optional per-category subdirs (free-form)
    └── <problem_type>--<component>--<entry_id-prefix>.md
```

Filenames are unenforced; the canonical key is the frontmatter `entry_id`. A reasonable default is `<problem_type>--<component>--<entry_id-prefix>.md` so the filename itself is greppable.

## Search commands

Find by problem type, component, or category:

```bash
rg --type md 'problem_type: flaky_test' docs/solutions/
rg --type md 'component: episodic-memory' docs/solutions/
rg --type md 'category: coordination' docs/solutions/
```

Find every solution that mentions a given symptom in body text:

```bash
rg --type md 'lock contention' docs/solutions/
```

## Refresh / consolidation

Run `/agent-flywheel:flywheel-compound-refresh` (skill at `skills/flywheel-compound-refresh/SKILL.md`) to sweep the corpus and classify entries Keep / Update / Consolidate / Replace / Delete:

- **Read-only first run.** The skill renders a report without acting; the user opts in to mutation in a second prompt.
- **Never auto-deletes.** Delete classifications always require explicit confirmation. Default mode acts only on Keep / Update / Consolidate / Replace.
- **Archive, don't `rm`.** Demoted entries move to `docs/solutions/_archive/<original-relative-path>` via `git mv` so history is preserved.
- **Rename detection before stale.** Before believing a component is gone, the skill runs `git log --follow -- <component-hint-path>` to check whether the file was renamed.

The skill emits `No docs/solutions/ corpus yet — run /flywheel-start to seed one via Step 10.55.` and stops if it finds only this README. Adding entries lifts that gate.

## How entries land here

Entries are written by `flywheel_memory operation: "draft_solution_doc"` (`mcp-server/src/tools/memory-tool.ts`) — typically called from `skills/start/_wrapup.md` post-implementation. The tool returns the synthesized markdown body + frontmatter; the caller writes it to disk and pairs it with a CASS `cm add` entry whose id flows into `entry_id`.

Do **not** generate fake or template entries to "seed" the corpus. The store gains value only from real session learnings.
