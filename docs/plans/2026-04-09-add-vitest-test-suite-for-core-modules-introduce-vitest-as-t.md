# Plan: Add Vitest Test Suite for Core Modules

**Goal:** Introduce Vitest as the test framework and write unit tests for the 7 MCP tool handlers (profile, discover, select, plan, approve, review, memory), core state machine transitions, checkpoint read/write, and bead lifecycle. Zero automated coverage currently creates high regression risk.

**Date:** 2026-04-09  
**Author:** orchestrate skill (standard plan)

---

## 1. Executive Summary

The `claude-orchestrator` MCP server has zero automated test coverage across 46 TypeScript source files. Every fix or feature ships with no regression safety net — a single broken import or state-machine edge case can silently corrupt sessions. This plan introduces Vitest as the test framework (chosen for native ESM + TypeScript support without a compilation step) and delivers unit tests for the three highest-risk layers:

1. **Pure utility functions** — `checkpoint.ts`, `beads.ts`, `types.ts` (deterministic, zero I/O, ideal for unit tests)
2. **State machine** — `state.ts` + phase transition logic in tool handlers
3. **Tool handlers** — all 7 MCP tools tested with mocked `ExecFn` and state

Total target: **≥ 80 test cases** covering the critical paths, edge cases, and error branches that have caused real regressions.

---

## 2. Architecture

### 2.1 Test Framework Selection

**Vitest** is chosen over Jest because:
- Native ESM support — no `ts-jest` or Babel transform needed
- Works with TypeScript source files directly via esbuild
- Handles the `.js` import extension convention required by `NodeNext` (Vitest's resolver maps `foo.js` → `foo.ts`)
- Fast parallel test execution

### 2.2 Module Layout

```
mcp-server/
├── src/
│   ├── __tests__/           ← new test directory
│   │   ├── checkpoint.test.ts
│   │   ├── beads.test.ts
│   │   ├── state.test.ts
│   │   ├── types.test.ts
│   │   ├── tools/
│   │   │   ├── profile.test.ts
│   │   │   ├── discover.test.ts
│   │   │   ├── select.test.ts
│   │   │   ├── plan.test.ts
│   │   │   ├── approve.test.ts
│   │   │   ├── review.test.ts
│   │   │   └── memory-tool.test.ts
│   │   └── helpers/
│   │       └── mocks.ts     ← shared ExecFn mock factory
│   └── ... (existing source)
├── vitest.config.ts         ← new
└── package.json             ← add vitest devDep + test script
```

### 2.3 Key Design Decisions

**ExecFn mock pattern:** All tool handlers receive `exec: ExecFn` via `ToolContext`. Tests inject a mock that returns controlled output without shelling out. This gives full control over success/failure paths without spawning real processes.

**Filesystem isolation:** `checkpoint.ts` tests write to `os.tmpdir()` sub-directories, never to the project root. Each test gets a fresh unique temp dir via `mkdtempSync`.

**State factory:** Tests use `createInitialState()` from `types.ts` as the baseline, mutating fields as needed per test case. No shared mutable state between tests.

**No dist compilation needed:** Vitest imports `.ts` source files directly. The `npm run build` step is separate and is only needed for production. Tests run against source.

---

## 3. Implementation Phases

### Dependency Graph

```
T1 (vitest setup)
  └── T2 (pure function tests: checkpoint, beads, types)
        └── T3 (state machine tests)
              └── T4 (tool handler tests: profile, discover, select)
                    └── T5 (tool handler tests: plan, approve, review, memory)
```

- **T1** — no deps
- **T2** depends on T1 (vitest must be installed first)
- **T3** depends on T2 (builds on the same pattern, needs vitest working)
- **T4** depends on T3 (ExecFn mock pattern established in T3)
- **T5** depends on T4 (same mocking pattern, more complex handlers)

---

## 4. File-Level Changes

### Phase 1: Vitest Setup (T1)

**`mcp-server/package.json`** — add:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.0.0"
  }
}
```

**`mcp-server/vitest.config.ts`** — new file:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
});
```

Note: Vitest's module resolver handles the NodeNext `.js` → `.ts` extension mapping automatically when importing TypeScript source files.

---

### Phase 2: Pure Function Tests (T2)

#### `src/__tests__/checkpoint.test.ts`

Tests for `checkpoint.ts` — entirely pure or uses real fs in tmpdir:

| Test | What it covers |
|------|---------------|
| `validateCheckpoint` with valid envelope | happy path |
| `validateCheckpoint` with wrong schemaVersion | returns `valid: false` |
| `validateCheckpoint` with bad writtenAt | ISO date validation |
| `validateCheckpoint` with tampered stateHash | hash mismatch detection |
| `validateCheckpoint` with missing phase | state.phase check |
| `computeStateHash` determinism | same state → same hash |
| `computeStateHash` sensitivity | one field change → different hash |
| `writeCheckpoint` success | file written, returns true |
| `writeCheckpoint` atomic write | tmp file removed after rename |
| `readCheckpoint` returns null when no file | missing file |
| `readCheckpoint` returns null on corrupt JSON | moves to .corrupt |
| `readCheckpoint` returns null on hash mismatch | tampered state |
| `readCheckpoint` returns warnings when stale (>24h) | staleness check |
| `clearCheckpoint` removes file | idempotent |
| `cleanupOrphanedTmp` removes .tmp file | orphan cleanup |

#### `src/__tests__/beads.test.ts`

Tests for `beads.ts` pure functions (no exec calls):

| Test | What it covers |
|------|---------------|
| `isValidBeadId` valid patterns | `abc-123`, `z9g-0` |
| `isValidBeadId` invalid patterns | `123`, `BD-123` (uppercase), empty |
| `findNonStandardIds` filters correctly | mixed valid/invalid list |
| `auditPlanToBeads` empty plan | returns empty sections |
| `auditPlanToBeads` plan with headings | sections extracted |
| `auditPlanToBeads` bead title token matching | score > 0 for matching tokens |
| `auditPlanToBeads` uncoveredSections | sections with no bead matches |
| `auditPlanToBeads` weakMappings | sections with score < 0.35 |
| `extractArtifacts` with Files: section | paths extracted |
| `extractArtifacts` with bullet file paths | `- src/foo.ts` detected |
| `extractArtifacts` empty description | returns [] |
| `getBeadsSummary` empty beads | "no beads tracked" |
| `getBeadsSummary` mixed statuses | correct counts per status |

#### `src/__tests__/types.test.ts`

| Test | What it covers |
|------|---------------|
| `createInitialState` shape | all required fields present |
| `createInitialState` phase | starts as "idle" |
| `createInitialState` constraints | empty array |
| `createInitialState` counters | all zeros |

---

### Phase 3: State Machine Tests (T3)

#### `src/__tests__/state.test.ts`

Tests `state.ts` + checkpoint round-trip using real temp directories:

| Test | What it covers |
|------|---------------|
| `loadState` fresh dir | returns initial state |
| `loadState` with idle checkpoint | returns initial state (not loaded) |
| `loadState` with active checkpoint | restores state |
| `loadState` with complete checkpoint | returns initial state |
| `saveState` → `loadState` round-trip | checkpoint persisted and restored |
| `clearState` removes checkpoint | loadState returns initial after clear |
| `saveState` handles write errors gracefully | no throw |

#### `src/__tests__/tools/shared.test.ts`

Tests `tools/shared.ts` utilities that don't require exec:

| Test | What it covers |
|------|---------------|
| `computeConvergenceScore` with 0 rounds | returns 0 |
| `computeConvergenceScore` with stable rounds | returns value approaching 1 |
| `slugifyGoal` trims and lowercases | "Add Foo Bar" → "add-foo-bar" |
| `slugifyGoal` handles special chars | strips non-alphanumeric |

---

### Phase 4: Tool Handler Tests — Profile, Discover, Select (T4)

#### `src/__tests__/helpers/mocks.ts`

Shared ExecFn mock factory:

```typescript
import type { ExecFn } from '../../exec.js';

export interface ExecCall {
  cmd: string;
  args: string[];
  result: { code: number; stdout: string; stderr: string };
}

/**
 * Creates a mock ExecFn that returns pre-programmed responses.
 * Unmatched commands return { code: 1, stdout: '', stderr: 'not mocked' }.
 */
export function createMockExec(calls: ExecCall[]): ExecFn {
  return async (cmd, args, _opts) => {
    const match = calls.find(c => c.cmd === cmd && args.join(' ').startsWith(c.args.join(' ')));
    return match?.result ?? { code: 1, stdout: '', stderr: 'not mocked' };
  };
}

export function makeState() {
  return createInitialState();
}
```

#### `src/__tests__/tools/profile.test.ts`

| Test | What it covers |
|------|---------------|
| Happy path: detects TypeScript | language detection from extensions |
| Happy path: detects vitest in package.json | `hasTests: true` |
| Happy path: detects GitHub Actions | `hasCI: true` |
| Happy path: git log parsing | recentCommits populated |
| Missing origin remote | falls back to directory name |
| No key files | keyFiles empty, no crash |
| `runProfile` sets phase to `discovering` | state transition |
| `runProfile` saves state | saveState called |
| `runProfile` with goal arg | sets selectedGoal |
| Foundation gap: no AGENTS.md | warning in output |

#### `src/__tests__/tools/discover.test.ts`

| Test | What it covers |
|------|---------------|
| `runDiscover` with valid ideas | stores candidateIdeas, returns list |
| `runDiscover` without prior profile | returns error or handles gracefully |
| `runDiscover` sets phase | state updated |
| Ideas sorted by score | top tier before honorable |

#### `src/__tests__/tools/select.test.ts`

| Test | What it covers |
|------|---------------|
| `runSelect` with valid goal | sets selectedGoal, transitions phase |
| `runSelect` without profile | error returned |
| Phase transition: discovering → planning | correct phase after select |
| Returns workflow options | output contains plan option text |

---

### Phase 5: Tool Handler Tests — Plan, Approve, Review, Memory (T5)

#### `src/__tests__/tools/plan.test.ts`

| Test | What it covers |
|------|---------------|
| `runPlan` mode=standard | returns planning prompt |
| `runPlan` mode=deep | returns agent configs |
| `runPlan` without selectedGoal | returns error |
| `runPlan` with planFile | reads file, transitions to bead creation |
| `runPlan` with planContent | stores plan, transitions phase |

#### `src/__tests__/tools/approve.test.ts`

| Test | What it covers |
|------|---------------|
| `runApprove` without selectedGoal | returns error |
| `runApprove` action=start | transitions to implementing |
| `runApprove` action=reject | clears state |
| `runApprove` action=polish | increments polishRound |
| Convergence score surfaced | output contains score |

#### `src/__tests__/tools/review.test.ts`

| Test | What it covers |
|------|---------------|
| `runReview` action=looks-good | marks bead result success |
| `runReview` action=hit-me | returns agent task specs |
| `runReview` without active bead | handles gracefully |
| Review pass count incremented | beadReviewPassCounts updated |

#### `src/__tests__/tools/memory-tool.test.ts`

| Test | What it covers |
|------|---------------|
| `runMemory` operation=store | writes session learnings |
| `runMemory` operation=recall | reads prior memories |
| `runMemory` operation=clear | removes memory file |
| Missing cwd | error returned |

---

## 5. Testing Strategy

### Unit vs Integration

All tests in this plan are **unit tests** — they mock external I/O:
- `ExecFn` is mocked via `createMockExec()`
- Filesystem tests for `checkpoint.ts` use real fs in `os.tmpdir()` (these are integration-lite but fast and self-cleaning)

No tests call real `br`, `git`, or `claude` CLIs. That's a separate integration test phase.

### Mocking Strategy

**ExecFn:** Injected via `ToolContext`. Tests control every shell call response.

**Filesystem:** Use Node's built-in `mkdtempSync(join(tmpdir(), 'orch-test-'))` for checkpoint tests. Each test gets its own temp dir. Cleanup via `afterEach` with `rmSync(dir, { recursive: true })`.

**Module state:** Some modules use module-level caches (e.g., `_bvAvailable` in `beads.ts`, `_lastBeadSnapshot` in `approve.ts`). Tests call the provided reset functions (`resetBvCache()`) or import modules fresh via dynamic import with cache-bust where needed.

### Coverage Targets

| Module | Target | Priority |
|--------|--------|----------|
| `checkpoint.ts` | 90%+ | Critical |
| `beads.ts` (pure fns) | 85%+ | High |
| `types.ts` | 95%+ | High |
| `state.ts` | 90%+ | High |
| `tools/profile.ts` | 75%+ | High |
| `tools/approve.ts` | 70%+ | Medium |
| All other tools | 60%+ | Medium |

---

## 6. Acceptance Criteria

### Phase 1 (Vitest Setup)
- [ ] `npm test` runs successfully in `mcp-server/` directory
- [ ] `npm run build` still passes after vitest config added
- [ ] Vitest config correctly includes `src/**/*.test.ts`
- [ ] Coverage report generates via `npm run test -- --coverage`

### Phase 2 (Pure Function Tests)
- [ ] All `validateCheckpoint` edge cases have dedicated test cases
- [ ] `computeStateHash` determinism verified
- [ ] `writeCheckpoint` + `readCheckpoint` round-trip passes in tmpdir
- [ ] Corrupt checkpoint file correctly moves to `.corrupt`
- [ ] `isValidBeadId` covers ≥ 5 valid and ≥ 5 invalid patterns
- [ ] `auditPlanToBeads` verifies section extraction and scoring
- [ ] `extractArtifacts` handles Files: section and bullet paths

### Phase 3 (State Machine)
- [ ] `loadState` ignores idle/complete checkpoints
- [ ] `loadState` restores active phase checkpoints
- [ ] Full save → load round-trip verified

### Phase 4 (Tool Handlers: Profile/Discover/Select)
- [ ] `runProfile` correctly detects TypeScript, hasTests, hasCI
- [ ] `runProfile` state transition to `discovering` verified
- [ ] `runDiscover` stores ideas and transitions phase
- [ ] `runSelect` sets goal and transitions to `planning`

### Phase 5 (Tool Handlers: Plan/Approve/Review/Memory)
- [ ] `runPlan` returns correct output for standard and deep modes
- [ ] `runApprove` action=start transitions to implementing
- [ ] `runReview` action=looks-good marks bead success
- [ ] `runMemory` store/recall/clear all work
- [ ] Total passing test count ≥ 80

### Overall
- [ ] `npm test` exits 0 with all tests passing
- [ ] No test writes to the project root `.pi-orchestrator/`
- [ ] No test spawns real `br`, `git`, or `claude` processes
- [ ] Test suite completes in < 30 seconds

---

## 7. Risk & Mitigation

### Risk 1: NodeNext `.js` extension resolution in Vitest

**Problem:** Source files import siblings as `'./checkpoint.js'` (required by NodeNext). Vitest must resolve these to `.ts` files.

**Status:** Vitest handles this via its built-in resolver — it tries `.ts` when `.js` is not found as a compiled file. This is well-documented behavior for Vitest + NodeNext projects.

**Mitigation:** If resolution fails, add to `vitest.config.ts`:
```ts
resolve: { alias: { '.js': '.ts' } }
```
Or install `vite-tsconfig-paths` and enable it in the config.

### Risk 2: Module-level mutable state in source files

**Problem:** `beads.ts` has `_bvAvailable` cache, `approve.ts` has `_lastBeadSnapshot`. These persist between tests in the same module instance.

**Mitigation:** 
- Call exported reset functions (`resetBvCache()`) in `beforeEach`
- Use `vi.resetModules()` for modules without reset functions
- Isolate snapshot state by re-importing `approve.ts` per test group

### Risk 3: `execSync` in `checkpoint.ts` (getGitHead)

**Problem:** `writeCheckpoint` calls `execSync('git rev-parse HEAD')` internally. This will fail in tmpdir contexts.

**Mitigation:** This is wrapped in `try/catch` and returns `undefined` on failure — the test will still pass. The `gitHead` field will just be `undefined` in the envelope, which is acceptable.

### Risk 4: Circular dependencies in tool handler imports

**Problem:** Some tool handlers transitively import heavy modules (prompts.ts is ~1600 lines). This may cause slow test initialization.

**Mitigation:** Vitest esbuild transform is fast. If startup is slow (> 5s), add `test.pool: 'forks'` to the config for process isolation. Each test file gets its own module graph.

### Risk 5: `approve.ts` internal state between action types

**Problem:** `runApprove` has complex branching across multiple action types, with phase guards. Tests need to carefully set up the right phase before calling.

**Mitigation:** Each test case explicitly sets `state.phase`, `state.selectedGoal`, and `state.activeBeadIds` before calling `runApprove`. Use a fresh `createInitialState()` per test case.

---

## 8. Implementation Notes

### Vitest Version

Use Vitest `^2.0.0` — it has stable ESM support and the `.js` → `.ts` resolution behavior. Avoid `^1.x` which has known NodeNext quirks.

### Test Naming Convention

Use `describe` blocks that mirror the source module name:
```ts
describe('checkpoint', () => {
  describe('validateCheckpoint', () => {
    it('accepts a valid envelope', () => { ... });
    it('rejects unknown schemaVersion', () => { ... });
  });
});
```

### Shared Test Helpers Location

Put shared helpers in `src/__tests__/helpers/` — not in `src/` itself, to keep the test utilities separate from source. The `vitest.config.ts` exclude pattern prevents them from being counted in coverage source.

### Running Tests

```bash
cd mcp-server
npm test              # run all tests once
npm run test:watch    # watch mode
npm test -- --coverage  # with coverage report
npm test -- checkpoint.test.ts  # single file
```
