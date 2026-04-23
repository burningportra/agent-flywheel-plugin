# Path-Traversal Audit — agent-flywheel-plugin

**Date:** 2026-04-23
**Bead:** `agent-flywheel-plugin-mq3`
**Reference:** CE phase-4 blunder #1 (`sanitizePathName` strips only colons) — `docs/research/compound-engineering-phase4-blunders.md`
**Sibling P0 audits:** `agent-flywheel-plugin-016` (clone safety) · `agent-flywheel-plugin-8tf` (fs safety)

## 1. Scope

Audit every `path.join` / `path.resolve` / `fs.writeFile*` / `fs.mkdir*` /
`fs.rename*` / `fs.rm*` / `fs.unlink*` / `fs.appendFile*` / `fs.createWriteStream`
call site in:

- `mcp-server/src/**/*.ts` (excluding `__tests__`)
- `skills/**/*.{ts,js,cjs,sh,py}`

Trace every path input back to its source and flag anything that originates
from:

- MCP tool arguments (`goal`, `planFile`, `beadId`, `skillName`, …)
- Remote input (git clone URLs, GitHub repo names supplied to `/flywheel-research`)
- `AskUserQuestion` "Other" free-text answers
- Parsed model output that later flows into a filesystem path

## 2. Method

```sh
# MCP server surface
grep -rnE 'path\.(join|resolve)|fs\.(writeFile|mkdir|rename|rm|unlink|appendFile|createWriteStream)' \
  mcp-server/src/ --include='*.ts' | grep -v __tests__

# Skills surface
grep -rnE 'path\.(join|resolve)|fs\.(writeFile|mkdir|rename|rm|unlink|appendFile)' skills/
```

Call sites were grouped by (a) the *source* of the path input and (b) whether
the path ends up at a writer or a reader. Read-only call sites were recorded
but not treated as P0 unless they could trigger a TOCTOU into a later write.

## 3. Findings

### 3.1 P0 — `flywheel_plan.planFile` MCP arg flows into `resolve(cwd, userInput)`

**File:** `mcp-server/src/tools/plan.ts:69-80` (pre-fix line numbers)

```ts
if (args.planFile) {
  const absPath = resolve(cwd, args.planFile);   // ← raw user input
  if (!existsSync(absPath)) { … }
  const content = readFileSync(absPath, 'utf8'); // ← read any file on disk
  …
}
```

**Source:** `args.planFile` is declared in the MCP tool schema at
`mcp-server/src/server.ts` (`planFile: { type: 'string', description: 'Path (relative to cwd) …' }`)
— it crosses the tool boundary with no validation.

**Impact:** `node:path.resolve(cwd, "../../../etc/passwd")` escapes `cwd`, and
`resolve(cwd, "/etc/passwd")` silently ignores `cwd` because the second arg is
absolute. An attacker (or a benign hallucination from a planning agent) could
exfiltrate any file readable by the MCP process into the returned payload as
"plan content", then have the server persist that path into checkpoint state
for later re-use.

**Fix:** call `assertSafeRelativePath(args.planFile, { root: cwd, allowAbsoluteInsideRoot: true })`
before `resolve`. Absolute paths that *happen* to resolve inside `cwd` are
still permitted so pre-existing callers that supply `docs/plans/<file>.md`
after a prior `resolve()` keep working. Anything that escapes `cwd` now
returns a structured `invalid_input` error with `reason` in the details.

### 3.2 P0 — `saveToolFeedback` splices attacker-controlled `toolName` into a file path

**File:** `mcp-server/src/feedback.ts:309-318` (pre-fix line numbers)

```ts
export function saveToolFeedback(cwd: string, feedback: ToolFeedback): void {
  const dir = join(cwd, ".pi-flywheel-feedback", "tools");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${feedback.toolName}.jsonl`); // ← direct splice
  appendFileSync(file, …);
}
```

**Source:** `feedback.toolName` is populated in `parseToolFeedback` from model
output — a parsed JSON block emitted by the agent after running a tool. If the
agent hallucinates or is prompt-injected, `toolName = "../../../etc/cron.d/runme"`
gets joined straight into an `appendFileSync` target and creates a
`.jsonl`-suffixed file outside the feedback dir.

**Fix:** `assertSafeSegment(feedback.toolName)` before the splice. On rejection
we log at `warn` with `code: "invalid_input"` and skip the write entirely
rather than falling back to a default name — the correct policy for an
attacker-controlled identifier is to drop it, not normalize it.

### 3.3 P1 — `runDeepPlanAgents` splices `agent.name` into temp filenames

**File:** `mcp-server/src/deep-plan.ts:85-86` (pre-fix line numbers)

```ts
const taskFile = join(resolvedOutputDir, `${agent.name}-task.md`);
const outputFile = join(resolvedOutputDir, `${agent.name}-output.md`);
```

**Source:** `agent.name` comes from the `DeepPlanAgent` array. Today the names
are hard-coded in `tools/plan.ts` (`correctness`, `robustness`, `ergonomics`,
`fresh-perspective`) so the immediate exploit path is not reachable. But the
synthesis workflow documented in `tools/plan.ts` and the future template-hint
path in this same file (`parseTemplateHint`) both open the door to a synthesizer
agent emitting names — which *would* be attacker-influencible.

**Fix:** `assertSafeSegment(agent.name)` before splicing. On rejection we
return a `(AGENT FAILED …)` sentinel the existing `filterViableResults` already
treats as non-viable — fails closed without poisoning the rest of the run.

### 3.4 Noted, no action needed

- **`mcp-server/src/tools/shared.ts:slugifyGoal`** — user's `goal` string is
  already collapsed to `[a-z0-9-]+` via a character-class replace before it
  touches any path. Safe; treat as the reference implementation for future
  user-label-to-path conversions.
- **`mcp-server/src/checkpoint.ts` / `state.ts`** — all paths are built from
  hardcoded constants and `cwd`. Owned by other beads; do not modify here.
- **`mcp-server/src/errors.ts`** — `sanitizeCause` is redaction, not
  path-safety, and is owned by bead 478. Not modified.
- **`mcp-server/src/worktree.ts`** — paths are derived from integer
  `stepIndex` and hardcoded `.pi-flywheel/worktrees`. Not attacker-controlled.
- **`mcp-server/src/feedback.ts:saveFeedback`** — filename is
  `feedback-${Date.now()}.json`. Not attacker-controlled.
- **`mcp-server/src/deep-plan.ts:writeProfileSnapshot`** — filename is the
  constant `profile-snapshot.json`. Safe.
- **`skills/brainstorming/scripts/server.cjs:147`** — uses
  `path.basename(fileName)` which already strips traversal segments. The
  brainstorming session dir is a separate trust domain and is **out of scope**
  for the MCP-server path-safety module — tracked as a follow-up below.

## 4. Shared sanitizer

New module: **`mcp-server/src/utils/path-safety.ts`**

Public API:

| Function | Purpose |
|----------|---------|
| `assertSafeRelativePath(input, { root, maxLength?, allowAbsoluteInsideRoot? })` | For path-shaped MCP tool args that are later `resolve`d against `cwd`. Rejects empty/non-string/control-char/null-byte/over-length/absolute-when-relative/`..`-segment/escapes-root. Returns a normalized relative path on success. |
| `assertSafeSegment(input, { maxLength?, rejectLeadingDot? })` | For single-segment identifiers spliced into a filename. Rejects empty/non-string/control-char/null-byte/separator/backslash/**colon** (CE-blunder canary)/reserved `.`/`..`/over-length. |
| `requireSafeRelativePath`, `requireSafeSegment` | Throwing variants for pure helpers with no graceful fallback. |

Both check functions return a **`SafePathResult`** discriminated union
(`{ ok: true, value }` or `{ ok: false, reason, message, rawPreview }`) so MCP
call sites can return a structured `invalid_input` error rather than throwing
across the MCP boundary.

Design notes:

- The `:` rejection in `assertSafeSegment` is the direct lesson from CE's
  blunder #5 (`opencode.ts:106` spread `name.split(":")` straight into
  `path.join`). We do not currently `split(":")` anywhere, but the canary stops
  future regressions.
- `assertSafeRelativePath` does **two** checks: a syntactic scan for `..`
  segments and a `resolve + relative` containment check. Either alone is
  insufficient — the resolve check catches inputs whose `..` segments are
  disguised by encoding, and the syntactic check catches some inputs that
  `resolve` would happen to canonicalize into-root (e.g. `a/../b` → `b`,
  harmless for the filesystem but a sign of attacker-shaped input worth
  rejecting loudly).
- Control chars rejected: the Latin-1 control block `U+0000`–`U+001F` plus
  `U+007F`. Tests cover tab (`\t`) and null byte.

## 5. Sanitizer applications (boundaries ≥ 3)

| # | File | Boundary | Function | Sanitizer used |
|---|------|----------|----------|----------------|
| 1 | `mcp-server/src/tools/plan.ts` | MCP arg `args.planFile` → `resolve(cwd, …)` → `readFileSync` | `runPlan` | `assertSafeRelativePath(args.planFile, { root: cwd, allowAbsoluteInsideRoot: true })` |
| 2 | `mcp-server/src/feedback.ts` | Parsed model output `feedback.toolName` → `join(dir, "${name}.jsonl")` → `appendFileSync` | `saveToolFeedback` | `assertSafeSegment(feedback.toolName)` |
| 3 | `mcp-server/src/deep-plan.ts` | `agent.name` spawn-config field → `join(resolvedOutputDir, "${name}-…")` → `writeFileSync` | `runDeepPlanAgents` | `assertSafeSegment(agent.name)` |

## 6. Tests

**`mcp-server/src/__tests__/utils/path-safety.test.ts`** covers:

- `'../foo'` → rejected with `parent_traversal`
- `'/etc/passwd'` → rejected with `absolute_when_relative_expected`
- `'foo\u0000bar'` → rejected with `null_byte`
- `'foo:bar'` → rejected with `colon` (CE-blunder canary)
- `'..:..:etc:passwd'` → rejected with `colon` (exact CE repro shape)
- Nested `a/../../b`, control chars, over-length, leading `/`, backslash,
  segment-with-`/`, reserved `..`/`.`, `allowAbsoluteInsideRoot` toggling
  in-root vs out-of-root behaviour.

## 7. Out of scope / follow-ups

- **`skills/brainstorming/scripts/server.cjs`** uses `path.basename(fileName)`
  on HTTP-path-derived names. The brainstorming server is a separate process,
  untrusted already by design, and uses `basename` which strips traversal. Not
  a regression of CE blunder #1. Consider a follow-up bead to adopt a named
  sanitizer even here for consistency.
- **Git clone URLs in `/flywheel-research`** — the SKILL.md extracts a
  `<repo-slug>` from a GitHub URL and feeds it into agent/team names, not
  directly into paths. Clone-safety (URL allow-list, SHA pinning) is the
  scope of sibling bead `agent-flywheel-plugin-016`.
- **`fs.writeFile` ownership + symlink checks** — out of scope here, covered
  by sibling bead `agent-flywheel-plugin-8tf` (CE blunder #3, `forceSymlink`
  unlinking a regular file).
