# Beads-Compliance Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the standalone `/beads-compliance-and-completion-verification` skill into the agent-flywheel as a default-on Step 9 wave-completion gate that hard-blocks wrap-up on false-closed beads.

**Architecture:** New MCP tool `flywheel_compliance_audit` wraps the standalone skill via `execa` subprocess and consumes a structured `passes/<UTC>/result.json` (added in this plan). On failure, the tool reopens beads via `br update --status open`, comments scorecards, bumps `compliance_false_closed` telemetry, and persists per-bead scores to CASS. `_review.md` Step 9 calls the tool after `flywheel_verify_beads` and routes a new failure menu.

**Tech Stack:** TypeScript + Vitest + Zod (mcp-server), Markdown SKILL.md (skill repo), execa for subprocess, `cm` CLI for CASS, `br` CLI for beads.

**Spec:** `docs/superpowers/specs/2026-05-08-beads-compliance-integration-design.md` (commit bd96eef).

**Two-repo work:** This plan touches both:
- `/Volumes/1tb/Projects/agent-flywheel/` — primary repo (this one)
- `/Users/kevtrinh/.claude/skills/beads-compliance-and-completion-verification/` — standalone skill repo

---

## Dependency graph

```
T1 ───► T2 ─────────────────────────────┐
                                         │
T3 ────────┐                             │
           ├──► T5 ──► T6 ──► T7 ──┬─► T8 (integration test)
T4 ────────┘                       │
                                   └─► T9 ──► T10 ──► T11 ──► T12
```

**Parallelizable batches** (when using subagent-driven-development):
- **Batch 1** (no deps): T1, T3, T4
- **Batch 2** (T1, T3, T4 done): T2, T5
- **Batch 3** (T2, T5 done): T6
- **Batch 4** (T6 done): T7
- **Batch 5** (T7 done): T8, T9 in parallel
- **Batch 6** (T9 done): T10
- **Batch 7** (T10 done): T11
- **Batch 8** (T11 done): T12

---

## Task 1: Add `--mode flywheel-gate` shorthand to standalone skill

**depends_on:** []

**Files:**
- Modify: `~/.claude/skills/beads-compliance-and-completion-verification/SKILL.md`

- [ ] **Step 1: Open the skill file and locate the "Modes" section.**

```bash
grep -n '^## Modes' ~/.claude/skills/beads-compliance-and-completion-verification/SKILL.md
```

Expected: a single line number for the `## Modes` header. If the section is absent, search for `single-bead`, `triage`, `comprehensive`, `tripwire` to find the mode list.

- [ ] **Step 2: Append the new mode entry under `## Modes`.**

Insert after the last existing mode entry. Verbatim text to add:

```markdown
### `flywheel-gate`

Shorthand for `--mode single-bead --parallelism 5 --remediation report-only --threshold 700`. Used by the agent-flywheel's Step 9 wave-completion gate (see `mcp-server/src/tools/compliance-audit.ts` in the agent-flywheel repo).

`remediation=report-only` is deliberate: in flywheel-gate mode, the calling MCP tool owns bead reopens, not the skill. Standalone callers using `--mode flywheel-gate` outside the flywheel get a report without reopens.

When `flywheel-gate` is active, the skill MUST emit `passes/<UTC>/result.json` (see "Structured output for programmatic callers" below) in addition to the usual markdown artifacts.
```

- [ ] **Step 3: Add the "Structured output for programmatic callers" section.**

Append at the end of the SKILL.md file:

```markdown
## Structured output for programmatic callers

When invoked with `--mode flywheel-gate` (or any mode that programmatic tooling drives), the skill MUST write `<project>/beads_compliance_audit/passes/<UTC>/result.json` alongside the existing markdown artifacts. Schema:

```json
{
  "schema_version": 1,
  "pass_utc": "2026-05-08T19:14:22Z",
  "mode": "flywheel-gate",
  "threshold": 700,
  "beads": [
    {
      "id": "agent-flywheel-XXX",
      "score": 850,
      "passed": true,
      "scorecard_path": "beads/agent-flywheel-XXX/scorecard.md",
      "rubric_breakdown": {
        "impl_completeness": "260/300",
        "tests_meaningful": "230/250",
        "anti_theater": "150/150",
        "test_depth": "120/150",
        "docs_telemetry_migrations": "70/100",
        "cross_bead_integration": "20/50"
      }
    }
  ],
  "session_id": "<value of FW_SESSION_ID env at skill spawn time, optional>"
}
\```

Programmatic callers parse `result.json` to determine pass/fail. The markdown REPORT.md is for humans.
```

- [ ] **Step 4: Verify the file is syntactically valid markdown.**

Run:
```bash
head -20 ~/.claude/skills/beads-compliance-and-completion-verification/SKILL.md
wc -l ~/.claude/skills/beads-compliance-and-completion-verification/SKILL.md
```

Expected: line count increased by ~50 lines vs pre-edit; no parse errors when loading the skill.

- [ ] **Step 5: Commit (skill repo).**

```bash
cd ~/.claude/skills/beads-compliance-and-completion-verification
git add SKILL.md
git commit -m "feat: add --mode flywheel-gate shorthand + result.json contract"
```

---

## Task 2: Update scorer.md subagent to emit result.json

**depends_on:** [T1]

**Files:**
- Modify: `~/.claude/skills/beads-compliance-and-completion-verification/subagents/scorer.md`
- Test: manual fixture run (no automated test — skill is prompt-driven)

- [ ] **Step 1: Locate the scorer subagent's "Output" section.**

```bash
grep -n '## Output\|## Outputs\|## Artifacts' ~/.claude/skills/beads-compliance-and-completion-verification/subagents/scorer.md
```

Expected: at least one section header. Note the line range of the output description.

- [ ] **Step 2: Append result.json emission instructions.**

Add at the end of the existing Output section:

```markdown
### result.json (programmatic callers)

When invoked with `--mode flywheel-gate` OR when `FW_RESULT_JSON=1` is set in the environment, after writing per-bead scorecards, write `passes/<UTC>/result.json` with this exact shape:

\`\`\`json
{
  "schema_version": 1,
  "pass_utc": "<ISO 8601 UTC>",
  "mode": "<mode value>",
  "threshold": <integer>,
  "beads": [
    {
      "id": "<bead-id>",
      "score": <integer 0-1000>,
      "passed": <boolean — score >= threshold>,
      "scorecard_path": "<relative path from passes/<UTC>/>",
      "rubric_breakdown": { "impl_completeness": "...", "tests_meaningful": "...", ... }
    }
  ],
  "session_id": "<FW_SESSION_ID env if set, else null>"
}
\`\`\`

For FAILED beads (score < threshold), additionally include `"top_failures"` as an array of the 3 lowest-scoring rubric dimensions formatted as `"<dimension>:<got>/<max>"`.

This file is the source of truth for programmatic callers. Do NOT skip it when in flywheel-gate mode.
```

- [ ] **Step 3: Manual sanity test — run the skill against a tiny fixture.**

Pick any small project with `.beads/` and at least one closed bead. Run:

```bash
cd /path/to/test-project
claude --skill beads-compliance-and-completion-verification -- --mode flywheel-gate --beads <one-real-bead-id>
```

Expected: completes (may take 5-10 min), `beads_compliance_audit/passes/<UTC>/result.json` exists and is valid JSON matching the schema. If `result.json` is missing, return to step 2 and verify the instructions are reachable from the scorer subagent's prompt path.

- [ ] **Step 4: Validate result.json against the schema.**

```bash
PASS_DIR=$(ls -td /path/to/test-project/beads_compliance_audit/passes/* | head -1)
cat "$PASS_DIR/result.json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['schema_version'] == 1, 'wrong schema_version'
assert d['mode'] == 'flywheel-gate', 'wrong mode'
assert isinstance(d['threshold'], int)
assert isinstance(d['beads'], list)
for b in d['beads']:
    assert b['id'] and isinstance(b['score'], int)
    assert isinstance(b['passed'], bool)
    assert b['scorecard_path']
    assert 'rubric_breakdown' in b
    if not b['passed']:
        assert 'top_failures' in b and len(b['top_failures']) == 3
print('OK')
"
```

Expected output: `OK`. If anything fails, return to step 2.

- [ ] **Step 5: Commit (skill repo).**

```bash
cd ~/.claude/skills/beads-compliance-and-completion-verification
git add subagents/scorer.md
git commit -m "feat(scorer): emit passes/<UTC>/result.json for programmatic callers"
```

---

## Task 3: Add `compliance_false_closed` to FlywheelErrorCode enum

**depends_on:** []

**Files:**
- Modify: `mcp-server/src/errors.ts`
- Test: `mcp-server/src/__tests__/telemetry.test.ts` (add a new test case)

- [ ] **Step 1: Open `mcp-server/src/errors.ts` and locate the `FlywheelErrorCodeSchema` Zod enum.**

```bash
grep -n 'FlywheelErrorCodeSchema\|compliance_' mcp-server/src/errors.ts
```

Expected: at least one match for `FlywheelErrorCodeSchema`. Note the existing enum members (e.g. `cli_failure`, `exec_timeout`, `not_found`).

- [ ] **Step 2: Write a failing test in `telemetry.test.ts`.**

Add this test near the other `recordErrorCode` test cases:

```typescript
it('records compliance_false_closed without throwing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fw-tel-comp-'));
  try {
    process.env.PI_FLYWHEEL_DIR = join(tmp, '.pi-flywheel');
    _resetTelemetryForTest();
    recordErrorCode('compliance_false_closed', { hashable: 'bead-XXX' });
    flushTelemetry({ cwd: tmp });
    const counts = JSON.parse(readFileSync(join(tmp, '.pi-flywheel/error-counts.json'), 'utf8'));
    expect(counts['compliance_false_closed']).toBe(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.PI_FLYWHEEL_DIR;
  }
});
```

- [ ] **Step 3: Run the test to verify it fails.**

```bash
cd mcp-server
npx vitest run src/__tests__/telemetry.test.ts -t 'compliance_false_closed'
```

Expected: FAIL with a Zod validation error like `Invalid enum value. Expected '...' got 'compliance_false_closed'`.

- [ ] **Step 4: Add `compliance_false_closed` to the enum.**

In `mcp-server/src/errors.ts`, add `'compliance_false_closed'` to the array passed to `z.enum([...])`. Place it alphabetically with the other codes:

```typescript
export const FlywheelErrorCodeSchema = z.enum([
  // ... existing entries
  'compliance_false_closed',
  // ... existing entries
]);
```

- [ ] **Step 5: Run the test to verify it passes.**

```bash
cd mcp-server
npx vitest run src/__tests__/telemetry.test.ts -t 'compliance_false_closed'
```

Expected: PASS.

- [ ] **Step 6: Run the full telemetry test suite to confirm no regressions.**

```bash
cd mcp-server
npx vitest run src/__tests__/telemetry.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add mcp-server/src/errors.ts mcp-server/src/__tests__/telemetry.test.ts
git commit -m "feat(telemetry): add compliance_false_closed error code"
```

---

## Task 4: Create `cass-helpers.ts` with `storeComplianceScore`

**depends_on:** []

**Files:**
- Create: `mcp-server/src/cass-helpers.ts`
- Create: `mcp-server/src/__tests__/cass-helpers.test.ts`

- [ ] **Step 1: Write the failing test first.**

Create `mcp-server/src/__tests__/cass-helpers.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeComplianceScore } from '../cass-helpers.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('{"ok":true}')),
}));

import { execFileSync } from 'node:child_process';

describe('storeComplianceScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cm add with compliance_score kind and required tags', () => {
    storeComplianceScore('/tmp/proj', {
      beadId: 'agent-flywheel-001',
      score: 850,
      threshold: 700,
      passed: true,
      rubric: { impl_completeness: '260/300' },
      passUtc: '2026-05-08T19:14:22Z',
      sessionId: 'sess-abc',
      gitHead: 'baf8fda',
    });

    expect(execFileSync).toHaveBeenCalledOnce();
    const [bin, args] = (execFileSync as any).mock.calls[0];
    expect(bin).toBe('cm');
    expect(args).toContain('add');
    expect(args.join(' ')).toContain('compliance_score');
    expect(args.join(' ')).toContain('agent-flywheel-001');
    expect(args.join(' ')).toContain('score-850-1000');  // bucket
  });

  it('buckets score correctly', () => {
    const cases: Array<[number, string]> = [
      [100, 'score-0-499'],
      [499, 'score-0-499'],
      [500, 'score-500-699'],
      [699, 'score-500-699'],
      [700, 'score-700-849'],
      [849, 'score-700-849'],
      [850, 'score-850-1000'],
      [1000, 'score-850-1000'],
    ];
    for (const [score, expectedBucket] of cases) {
      vi.clearAllMocks();
      storeComplianceScore('/tmp/proj', {
        beadId: 'b', score, threshold: 700, passed: score >= 700,
        rubric: {}, passUtc: '2026-05-08T19:14:22Z', sessionId: null, gitHead: 'abc',
      });
      const args = (execFileSync as any).mock.calls[0][1];
      expect(args.join(' '), `score=${score}`).toContain(expectedBucket);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

```bash
cd mcp-server
npx vitest run src/__tests__/cass-helpers.test.ts
```

Expected: FAIL with "Cannot find module '../cass-helpers.js'".

- [ ] **Step 3: Create the helper module.**

Create `mcp-server/src/cass-helpers.ts`:

```typescript
import { execFileSync } from 'node:child_process';

export interface ComplianceScoreRecord {
  beadId: string;
  score: number;          // 0-1000
  threshold: number;
  passed: boolean;
  rubric: Record<string, string>;
  passUtc: string;        // ISO 8601
  sessionId: string | null;
  gitHead: string;
}

function scoreBucket(score: number): string {
  if (score < 500) return 'score-0-499';
  if (score < 700) return 'score-500-699';
  if (score < 850) return 'score-700-849';
  return 'score-850-1000';
}

export function storeComplianceScore(cwd: string, record: ComplianceScoreRecord): void {
  const tags = ['compliance', 'score', record.beadId, scoreBucket(record.score)];
  const body = JSON.stringify({
    kind: 'compliance_score',
    tags,
    body: record,
  });
  execFileSync('cm', ['add', '--kind', 'compliance_score', '--tags', tags.join(','), '--body', body], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes.**

```bash
cd mcp-server
npx vitest run src/__tests__/cass-helpers.test.ts
```

Expected: both tests PASS.

- [ ] **Step 5: Commit.**

```bash
git add mcp-server/src/cass-helpers.ts mcp-server/src/__tests__/cass-helpers.test.ts
git commit -m "feat(cass): add storeComplianceScore helper for score persistence"
```

---

## Task 5: Scaffold `compliance-audit.ts` MCP tool (validation + skip-env paths only)

**depends_on:** [T3, T4]

**Files:**
- Create: `mcp-server/src/tools/compliance-audit.ts`
- Modify: `mcp-server/src/server.ts` (register tool)
- Create: `mcp-server/src/__tests__/compliance-audit.test.ts`

- [ ] **Step 1: Write failing tests for input validation and skip-env.**

Create `mcp-server/src/__tests__/compliance-audit.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runComplianceAudit } from '../tools/compliance-audit.js';
import type { ToolContext } from '../tool-context.js';

const stubCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  exec: vi.fn(),
  state: {} as any,
  ...overrides,
} as any);

describe('runComplianceAudit', () => {
  beforeEach(() => {
    delete process.env.FW_COMPLIANCE_OVERRIDE;
  });

  it('returns ok with empty arrays when beadIds is empty', async () => {
    const result = await runComplianceAudit(stubCtx(), { cwd: '/tmp', beadIds: [] });
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.data?.status).toBe('ok');
    expect(result.structuredContent?.data?.passed).toEqual([]);
    expect(result.structuredContent?.data?.failed).toEqual([]);
  });

  it('returns skipped when FW_COMPLIANCE_OVERRIDE env is set', async () => {
    process.env.FW_COMPLIANCE_OVERRIDE = 'agent-flywheel-001,agent-flywheel-002';
    const result = await runComplianceAudit(stubCtx(), {
      cwd: '/tmp',
      beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
    });
    expect(result.structuredContent?.data?.status).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail.**

```bash
cd mcp-server
npx vitest run src/__tests__/compliance-audit.test.ts
```

Expected: FAIL with "Cannot find module '../tools/compliance-audit.js'".

- [ ] **Step 3: Create the tool module with stub implementation.**

Create `mcp-server/src/tools/compliance-audit.ts`:

```typescript
import type { ToolContext } from '../tool-context.js';
import type { McpToolResult } from '../types.js';
import { makeOkToolResult } from '../result-helpers.js';

export interface ComplianceAuditArgs {
  cwd: string;
  beadIds: string[];
  mode?: 'single-bead' | 'standard';
  threshold?: number;
  parallelism?: number;
  skipEnv?: string;
}

export interface ComplianceAuditOutcome {
  status: 'ok' | 'skipped' | 'error';
  passed: Array<{ beadId: string; score: number; reportPath: string }>;
  failed: Array<{ beadId: string; score: number; reportPath: string; reasons: string[] }>;
  passUtc: string | null;
  errors: Record<string, string>;
  durationMs: number;
}

export async function runComplianceAudit(
  ctx: ToolContext,
  args: ComplianceAuditArgs,
): Promise<McpToolResult> {
  const startedAt = Date.now();

  // Empty wave — no-op success.
  if (args.beadIds.length === 0) {
    return makeOkToolResult('flywheel_compliance_audit', 'reviewing', 'No beads to audit.', {
      kind: 'compliance_audit_outcome',
      status: 'ok',
      passed: [],
      failed: [],
      passUtc: null,
      errors: {},
      durationMs: Date.now() - startedAt,
    } satisfies ComplianceAuditOutcome & { kind: string });
  }

  // Skip-env override (emergency unblock).
  const overrideEnv = args.skipEnv ?? process.env.FW_COMPLIANCE_OVERRIDE;
  if (overrideEnv && overrideEnv.length > 0) {
    return makeOkToolResult(
      'flywheel_compliance_audit',
      'reviewing',
      `Compliance audit skipped via FW_COMPLIANCE_OVERRIDE=${overrideEnv}.`,
      {
        kind: 'compliance_audit_outcome',
        status: 'skipped',
        passed: [],
        failed: [],
        passUtc: null,
        errors: {},
        durationMs: Date.now() - startedAt,
      } satisfies ComplianceAuditOutcome & { kind: string },
    );
  }

  // TODO(Task 6): spawn skill, parse result.json
  // TODO(Task 7): side effects (br update, telemetry, CASS)
  throw new Error('not implemented — Task 6');
}
```

- [ ] **Step 4: Register the tool in `server.ts`.**

In `mcp-server/src/server.ts`, find the `flywheel_verify_beads` registration block and add this immediately after:

```typescript
{
  name: 'flywheel_compliance_audit',
  description:
    'Audit a wave of closed beads for compliance with their acceptance criteria via the standalone /beads-compliance-and-completion-verification skill. ' +
    'Returns per-bead scores; reopens false-closed beads; bumps telemetry; persists scores to CASS. ' +
    'Default mode is single-bead parallel (~5-10 min for 5 beads). Honors FW_COMPLIANCE_OVERRIDE env for emergency skip.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Project working directory' },
      beadIds: {
        type: 'array',
        description: 'Bead IDs in this wave to audit',
        items: { type: 'string' },
      },
      mode: { type: 'string', enum: ['single-bead', 'standard'], description: 'Audit mode (default: single-bead)' },
      threshold: { type: 'number', description: 'Score threshold below which a bead is false-closed (default: 700)' },
      parallelism: { type: 'number', description: 'Max parallel skill spawns (default: 5, max: 5)' },
      skipEnv: { type: 'string', description: 'Comma-separated bead IDs to skip; if any provided, audit is short-circuited' },
    },
    required: ['cwd', 'beadIds'],
  },
},
```

And in the runner map block (`server.ts:501` area), add:

```typescript
flywheel_compliance_audit: runComplianceAudit as ToolRunner,
```

Also add the import at the top of `server.ts`:

```typescript
import { runComplianceAudit } from './tools/compliance-audit.js';
```

- [ ] **Step 5: Run tests to verify they pass.**

```bash
cd mcp-server
npx vitest run src/__tests__/compliance-audit.test.ts
```

Expected: both tests PASS.

- [ ] **Step 6: Run a typecheck to verify the registration.**

```bash
cd mcp-server
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add mcp-server/src/tools/compliance-audit.ts mcp-server/src/server.ts mcp-server/src/__tests__/compliance-audit.test.ts
git commit -m "feat(mcp): scaffold flywheel_compliance_audit tool (validation + skip-env)"
```

---

## Task 6: Implement skill spawn + result.json parsing

**depends_on:** [T2, T5]

**Files:**
- Modify: `mcp-server/src/tools/compliance-audit.ts`
- Modify: `mcp-server/src/__tests__/compliance-audit.test.ts`
- Create: `mcp-server/src/__tests__/fixtures/compliance-result-pass.json`
- Create: `mcp-server/src/__tests__/fixtures/compliance-result-mixed.json`

- [ ] **Step 1: Create test fixtures.**

Create `mcp-server/src/__tests__/fixtures/compliance-result-pass.json`:

```json
{
  "schema_version": 1,
  "pass_utc": "2026-05-08T19:14:22Z",
  "mode": "flywheel-gate",
  "threshold": 700,
  "beads": [
    {
      "id": "agent-flywheel-001",
      "score": 850,
      "passed": true,
      "scorecard_path": "beads/agent-flywheel-001/scorecard.md",
      "rubric_breakdown": { "impl_completeness": "260/300" }
    }
  ],
  "session_id": null
}
```

Create `mcp-server/src/__tests__/fixtures/compliance-result-mixed.json`:

```json
{
  "schema_version": 1,
  "pass_utc": "2026-05-08T19:14:22Z",
  "mode": "flywheel-gate",
  "threshold": 700,
  "beads": [
    {
      "id": "agent-flywheel-001",
      "score": 850,
      "passed": true,
      "scorecard_path": "beads/agent-flywheel-001/scorecard.md",
      "rubric_breakdown": { "impl_completeness": "260/300" }
    },
    {
      "id": "agent-flywheel-002",
      "score": 420,
      "passed": false,
      "scorecard_path": "beads/agent-flywheel-002/scorecard.md",
      "rubric_breakdown": { "impl_completeness": "120/300" },
      "top_failures": ["impl_completeness:120/300", "test_depth:60/150", "anti_theater:30/150"]
    }
  ],
  "session_id": "sess-abc"
}
```

- [ ] **Step 2: Add failing tests for the parse path.**

Append to `mcp-server/src/__tests__/compliance-audit.test.ts`:

```typescript
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

function setupFakePassDir(cwd: string, fixtureName: string): string {
  const passUtc = '2026-05-08T19-14-22Z';
  const passDir = join(cwd, 'beads_compliance_audit', 'passes', passUtc);
  mkdirSync(passDir, { recursive: true });
  const fixturePath = join(__dirname, 'fixtures', fixtureName);
  writeFileSync(join(passDir, 'result.json'), readFileSync(fixturePath, 'utf8'));
  return passDir;
}

describe('runComplianceAudit — skill spawn + parse', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fw-comp-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('parses all-pass result and returns status=ok with passed[] populated', async () => {
    setupFakePassDir(tmp, 'compliance-result-pass.json');
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
    expect(result.structuredContent?.data?.status).toBe('ok');
    expect(result.structuredContent?.data?.passed).toHaveLength(1);
    expect(result.structuredContent?.data?.failed).toHaveLength(0);
  });

  it('parses mixed result and partitions passed/failed', async () => {
    setupFakePassDir(tmp, 'compliance-result-mixed.json');
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const result = await runComplianceAudit(ctx, {
      cwd: tmp,
      beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
    });
    expect(result.structuredContent?.data?.status).toBe('ok');
    expect(result.structuredContent?.data?.passed).toHaveLength(1);
    expect(result.structuredContent?.data?.failed).toHaveLength(1);
    expect(result.structuredContent?.data?.failed[0].beadId).toBe('agent-flywheel-002');
    expect(result.structuredContent?.data?.failed[0].reasons).toEqual([
      'impl_completeness:120/300',
      'test_depth:60/150',
      'anti_theater:30/150',
    ]);
  });

  it('returns status=error when result.json is missing', async () => {
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
    expect(result.structuredContent?.data?.status).toBe('error');
    expect(Object.keys(result.structuredContent?.data?.errors ?? {})).toContain('parse');
  });

  it('returns status=error when skill subprocess fails', async () => {
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'skill not found' }),
    });
    const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });
    expect(result.structuredContent?.data?.status).toBe('error');
    expect(Object.keys(result.structuredContent?.data?.errors ?? {})).toContain('spawn');
  });
});
```

- [ ] **Step 3: Run tests — verify they fail.**

```bash
cd mcp-server
npx vitest run src/__tests__/compliance-audit.test.ts
```

Expected: 4 new tests FAIL with "not implemented — Task 6".

- [ ] **Step 4: Implement skill spawn + parse.**

In `mcp-server/src/tools/compliance-audit.ts`, replace the `throw new Error('not implemented — Task 6')` line and surrounding logic with:

```typescript
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// (after the override-env check)

const mode = args.mode ?? 'single-bead';
const threshold = args.threshold ?? 700;
const parallelism = Math.min(args.parallelism ?? 5, 5);

// 1. Spawn the skill via execa.
let spawnOk = false;
try {
  const spawnResult = await ctx.exec('claude', [
    '--skill', 'beads-compliance-and-completion-verification',
    '--', '--mode', 'flywheel-gate',
    '--beads', args.beadIds.join(','),
    '--threshold', String(threshold),
    '--parallelism', String(parallelism),
  ], { cwd: args.cwd, timeout: 15 * 60 * 1000 });
  spawnOk = spawnResult.exitCode === 0;
  if (!spawnOk) {
    return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
      `Skill spawn failed (exit ${spawnResult.exitCode}): ${spawnResult.stderr.slice(0, 200)}`, {
      kind: 'compliance_audit_outcome',
      status: 'error',
      passed: [], failed: [], passUtc: null,
      errors: { spawn: `exit ${spawnResult.exitCode}: ${spawnResult.stderr.slice(0, 500)}` },
      durationMs: Date.now() - startedAt,
    } satisfies ComplianceAuditOutcome & { kind: string });
  }
} catch (e: any) {
  return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
    `Skill spawn threw: ${e?.message ?? String(e)}`, {
    kind: 'compliance_audit_outcome',
    status: 'error',
    passed: [], failed: [], passUtc: null,
    errors: { spawn: e?.message ?? String(e) },
    durationMs: Date.now() - startedAt,
  } satisfies ComplianceAuditOutcome & { kind: string });
}

// 2. Locate the latest passes/<UTC>/result.json.
const passesRoot = join(args.cwd, 'beads_compliance_audit', 'passes');
if (!existsSync(passesRoot)) {
  return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
    'Skill ran but produced no passes directory.', {
    kind: 'compliance_audit_outcome',
    status: 'error',
    passed: [], failed: [], passUtc: null,
    errors: { parse: `passes directory missing: ${passesRoot}` },
    durationMs: Date.now() - startedAt,
  } satisfies ComplianceAuditOutcome & { kind: string });
}

const subdirs = readdirSync(passesRoot)
  .map((name) => ({ name, mtime: statSync(join(passesRoot, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (subdirs.length === 0) {
  return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
    'No pass directories found.', {
    kind: 'compliance_audit_outcome',
    status: 'error',
    passed: [], failed: [], passUtc: null,
    errors: { parse: 'no pass dirs' },
    durationMs: Date.now() - startedAt,
  } satisfies ComplianceAuditOutcome & { kind: string });
}

const latestPassDir = join(passesRoot, subdirs[0].name);
const resultJsonPath = join(latestPassDir, 'result.json');

if (!existsSync(resultJsonPath)) {
  return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
    'result.json missing in latest pass.', {
    kind: 'compliance_audit_outcome',
    status: 'error',
    passed: [], failed: [], passUtc: null,
    errors: { parse: `result.json not found at ${resultJsonPath}` },
    durationMs: Date.now() - startedAt,
  } satisfies ComplianceAuditOutcome & { kind: string });
}

let parsed: any;
try {
  parsed = JSON.parse(readFileSync(resultJsonPath, 'utf8'));
} catch (e: any) {
  return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
    `result.json parse failed: ${e?.message}`, {
    kind: 'compliance_audit_outcome',
    status: 'error',
    passed: [], failed: [], passUtc: null,
    errors: { parse: e?.message ?? String(e) },
    durationMs: Date.now() - startedAt,
  } satisfies ComplianceAuditOutcome & { kind: string });
}

// 3. Partition into passed/failed.
const passed: ComplianceAuditOutcome['passed'] = [];
const failed: ComplianceAuditOutcome['failed'] = [];
for (const bead of parsed.beads ?? []) {
  const reportPath = join(latestPassDir, bead.scorecard_path);
  if (bead.passed) {
    passed.push({ beadId: bead.id, score: bead.score, reportPath });
  } else {
    failed.push({
      beadId: bead.id,
      score: bead.score,
      reportPath,
      reasons: bead.top_failures ?? [],
    });
  }
}

// TODO(Task 7): side effects — br update --status open, br comment, telemetry, CASS

return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
  `Compliance audit complete: ${passed.length} passed, ${failed.length} failed.`, {
  kind: 'compliance_audit_outcome',
  status: 'ok',
  passed,
  failed,
  passUtc: parsed.pass_utc ?? null,
  errors: {},
  durationMs: Date.now() - startedAt,
} satisfies ComplianceAuditOutcome & { kind: string });
```

- [ ] **Step 5: Run tests to verify they pass.**

```bash
cd mcp-server
npx vitest run src/__tests__/compliance-audit.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Run typecheck.**

```bash
cd mcp-server
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add mcp-server/src/tools/compliance-audit.ts mcp-server/src/__tests__/compliance-audit.test.ts mcp-server/src/__tests__/fixtures/compliance-result-pass.json mcp-server/src/__tests__/fixtures/compliance-result-mixed.json
git commit -m "feat(mcp): implement skill spawn + result.json parse for compliance audit"
```

---

## Task 7: Implement side effects (br reopen, telemetry, CASS)

**depends_on:** [T6]

**Files:**
- Modify: `mcp-server/src/tools/compliance-audit.ts`
- Modify: `mcp-server/src/__tests__/compliance-audit.test.ts`

- [ ] **Step 1: Add failing tests for side effects.**

Append to the test file:

```typescript
describe('runComplianceAudit — side effects', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fw-comp-side-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs br update --status open + br comment for each failed bead', async () => {
    setupFakePassDir(tmp, 'compliance-result-mixed.json');
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const ctx = stubCtx({ exec });

    await runComplianceAudit(ctx, {
      cwd: tmp,
      beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
    });

    const brCalls = exec.mock.calls.filter((c: any[]) => c[0] === 'br');
    const updateCall = brCalls.find((c: any[]) => c[1].includes('update') && c[1].includes('agent-flywheel-002'));
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toContain('--status');
    expect(updateCall![1]).toContain('open');

    const commentCall = brCalls.find((c: any[]) => c[1].includes('comment') && c[1].includes('agent-flywheel-002'));
    expect(commentCall).toBeDefined();
    expect(commentCall![1].join(' ')).toMatch(/score 420\/1000/);
  });

  it('does NOT run br update for passed beads', async () => {
    setupFakePassDir(tmp, 'compliance-result-pass.json');
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const ctx = stubCtx({ exec });

    await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });

    const updateCalls = exec.mock.calls.filter((c: any[]) =>
      c[0] === 'br' && c[1].includes('update') && c[1].includes('--status') && c[1].includes('open'));
    expect(updateCalls).toHaveLength(0);
  });

  it('continues when a single br update fails', async () => {
    setupFakePassDir(tmp, 'compliance-result-mixed.json');
    const exec = vi.fn().mockImplementation((bin: string, args: string[]) => {
      if (bin === 'br' && args.includes('update')) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'bead not found' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const ctx = stubCtx({ exec });

    const result = await runComplianceAudit(ctx, {
      cwd: tmp,
      beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
    });

    // Status remains ok — partial side-effect failure is non-fatal.
    expect(result.structuredContent?.data?.status).toBe('ok');
    expect(result.structuredContent?.data?.errors['agent-flywheel-002']).toMatch(/br update failed/);
  });
});
```

Also add a telemetry test using the real `recordErrorCode` (no mock):

```typescript
import { _resetTelemetryForTest, flushTelemetry } from '../telemetry.js';
import { readFileSync } from 'node:fs';

it('bumps compliance_false_closed telemetry once per failed bead', async () => {
  setupFakePassDir(tmp, 'compliance-result-mixed.json');
  process.env.PI_FLYWHEEL_DIR = join(tmp, '.pi-flywheel');
  _resetTelemetryForTest();

  const ctx = stubCtx({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) });
  await runComplianceAudit(ctx, {
    cwd: tmp,
    beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
  });

  flushTelemetry({ cwd: tmp });
  const counts = JSON.parse(readFileSync(join(tmp, '.pi-flywheel/error-counts.json'), 'utf8'));
  expect(counts['compliance_false_closed']).toBe(1);  // one failed bead in fixture

  delete process.env.PI_FLYWHEEL_DIR;
});
```

And a CASS test:

```typescript
import { storeComplianceScore } from '../cass-helpers.js';

vi.mock('../cass-helpers.js', () => ({
  storeComplianceScore: vi.fn(),
}));

it('persists compliance scores for all beads (passed + failed)', async () => {
  setupFakePassDir(tmp, 'compliance-result-mixed.json');
  const ctx = stubCtx({ exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) });
  await runComplianceAudit(ctx, {
    cwd: tmp,
    beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
  });

  expect(storeComplianceScore).toHaveBeenCalledTimes(2);
  const calls = (storeComplianceScore as any).mock.calls;
  expect(calls.map((c: any[]) => c[1].beadId).sort()).toEqual(['agent-flywheel-001', 'agent-flywheel-002']);
});
```

- [ ] **Step 2: Run tests — verify they fail.**

```bash
cd mcp-server
npx vitest run src/__tests__/compliance-audit.test.ts
```

Expected: 5 new tests FAIL.

- [ ] **Step 3: Implement side effects in `compliance-audit.ts`.**

Replace the `// TODO(Task 7): side effects` block with:

```typescript
import { recordErrorCode } from '../telemetry.js';
import { storeComplianceScore } from '../cass-helpers.js';
import { execSync } from 'node:child_process';

// 4. Side effects.
const errors: Record<string, string> = {};

// 4a. Reopen failed beads + comment scorecard.
for (const f of failed) {
  try {
    const updateRes = await ctx.exec('br', ['update', f.beadId, '--status', 'open'],
      { cwd: args.cwd, timeout: 10000 });
    if (updateRes.exitCode !== 0) {
      errors[f.beadId] = `br update failed: ${updateRes.stderr.slice(0, 200)}`;
      continue;
    }
    const commentBody = `Compliance audit reopened — score ${f.score}/1000. See ${f.reportPath}`;
    await ctx.exec('br', ['comment', f.beadId, commentBody],
      { cwd: args.cwd, timeout: 10000 });
  } catch (e: any) {
    errors[f.beadId] = `br update failed: ${e?.message ?? String(e)}`;
  }
}

// 4b. Telemetry — single bump regardless of failure count
//     (telemetry codes are events; per-bead detail lives in CASS).
if (failed.length > 0) {
  try {
    recordErrorCode('compliance_false_closed', { hashable: failed.map((f) => f.beadId).sort().join(',') });
  } catch {
    // never block on telemetry
  }
}

// 4c. CASS persistence — every bead, passed or failed.
const sessionId = process.env.FW_SESSION_ID ?? null;
let gitHead = '';
try {
  gitHead = execSync('git rev-parse HEAD', { cwd: args.cwd, encoding: 'utf8', timeout: 5000 }).trim();
} catch {
  gitHead = 'unknown';
}

for (const bead of parsed.beads ?? []) {
  try {
    storeComplianceScore(args.cwd, {
      beadId: bead.id,
      score: bead.score,
      threshold,
      passed: bead.passed,
      rubric: bead.rubric_breakdown ?? {},
      passUtc: parsed.pass_utc,
      sessionId,
      gitHead,
    });
  } catch (e: any) {
    // CASS is advisory — never block the gate
    errors[`cass-${bead.id}`] = e?.message ?? String(e);
  }
}
```

Also update the final `makeOkToolResult` call to include `errors`:

```typescript
return makeOkToolResult('flywheel_compliance_audit', 'reviewing',
  `Compliance audit complete: ${passed.length} passed, ${failed.length} failed.`, {
  kind: 'compliance_audit_outcome',
  status: 'ok',
  passed,
  failed,
  passUtc: parsed.pass_utc ?? null,
  errors,
  durationMs: Date.now() - startedAt,
} satisfies ComplianceAuditOutcome & { kind: string });
```

- [ ] **Step 4: Run tests to verify they pass.**

```bash
cd mcp-server
npx vitest run src/__tests__/compliance-audit.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run the full mcp-server test suite to confirm no regressions.**

```bash
cd mcp-server
npx vitest run
```

Expected: all pass.

- [ ] **Step 6: Run typecheck.**

```bash
cd mcp-server
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add mcp-server/src/tools/compliance-audit.ts mcp-server/src/__tests__/compliance-audit.test.ts
git commit -m "feat(mcp): implement compliance audit side effects (reopen + telemetry + CASS)"
```

---

## Task 8: Integration test against the real skill

**depends_on:** [T7]

**Files:**
- Create: `mcp-server/src/__tests__/compliance-audit-integration.test.ts`

- [ ] **Step 1: Create the gated integration test with a complete fixture.**

Create `mcp-server/src/__tests__/compliance-audit-integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runComplianceAudit } from '../tools/compliance-audit.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { execa } from 'execa';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN = process.env.RUN_INTEGRATION === '1';
const describeMaybe = RUN ? describe : describe.skip;

interface BrBead { id: string; title: string; status: string; }

function brList(cwd: string): BrBead[] {
  const out = execSync('br list --json', { cwd, encoding: 'utf8' });
  return JSON.parse(out) as BrBead[];
}

describeMaybe('compliance audit — integration', () => {
  it('runs the real skill against a 2-bead fixture project', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fw-comp-int-'));
    try {
      // 1. Initialize a tiny project.
      execSync('git init -q', { cwd: tmp });
      execSync('git config user.email integration@example.com', { cwd: tmp });
      execSync('git config user.name Integration', { cwd: tmp });
      execSync('br init', { cwd: tmp });

      // 2. Bead A — trivially correct: spec asks for greet(name); impl matches.
      execSync('br create "Add greeting function" --description "Implement greet(name) returning Hello, name!. Add unit test."', { cwd: tmp });

      // Bead B — false-closed: spec asks for two functions; impl only has one.
      execSync('br create "Add greet+farewell" --description "Implement greet() AND farewell(). Both must have unit tests."', { cwd: tmp });

      const beads = brList(tmp);
      expect(beads).toHaveLength(2);
      const beadA = beads[0];
      const beadB = beads[1];

      // Implement bead A correctly.
      mkdirSync(join(tmp, 'src'), { recursive: true });
      mkdirSync(join(tmp, 'tests'), { recursive: true });
      writeFileSync(join(tmp, 'src/greet.js'), 'export const greet = (name) => `Hello, ${name}!`;\n');
      writeFileSync(join(tmp, 'tests/greet.test.js'),
        "import { greet } from '../src/greet.js';\nimport { test } from 'node:test';\nimport assert from 'node:assert';\ntest('greet', () => assert.strictEqual(greet('World'), 'Hello, World!'));\n");

      // Implement bead B INCOMPLETELY — only greet, no farewell, no test.
      writeFileSync(join(tmp, 'src/greet2.js'), 'export const greet = (name) => `Hi ${name}`;\n');

      execSync('git add . && git commit -q -m "impl"', { cwd: tmp });
      execSync(`br update ${beadA.id} --status closed`, { cwd: tmp });
      execSync(`br update ${beadB.id} --status closed`, { cwd: tmp });

      // 3. Run the audit.
      const ctx: any = {
        exec: async (bin: string, args: string[], opts: any) => execa(bin, args, opts),
        state: {},
      };
      const result = await runComplianceAudit(ctx, {
        cwd: tmp,
        beadIds: [beadA.id, beadB.id],
        threshold: 700,
      });

      // 4. Assertions.
      expect(result.structuredContent?.data?.status).toBe('ok');
      const data = result.structuredContent!.data!;
      expect(data.passed.length + data.failed.length).toBe(2);

      // Bead B should fail (incomplete impl, no test).
      const failedIds = data.failed.map((f: any) => f.beadId);
      expect(failedIds).toContain(beadB.id);

      // Bead B should be reopened by the side-effect.
      const postBeads = brList(tmp);
      const postBeadB = postBeads.find((b) => b.id === beadB.id);
      expect(postBeadB?.status).toBe('open');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30 * 60 * 1000);  // 30-min timeout
});
```

**Note for the implementer:** The `br list --json` output schema may evolve — adjust `BrBead` and the parsing as needed. If the skill is not installed at `~/.claude/skills/beads-compliance-and-completion-verification/`, this test fails with a spawn error, which is the expected behavior (the unit test in T6 covers the spawn-error path).

- [ ] **Step 2: Run with RUN_INTEGRATION=1 once locally to confirm it works.**

```bash
cd mcp-server
RUN_INTEGRATION=1 npx vitest run src/__tests__/compliance-audit-integration.test.ts
```

Expected: PASSES (slow — 5-15 min). If it times out, verify the skill is installed at `~/.claude/skills/beads-compliance-and-completion-verification/`.

- [ ] **Step 3: Run the test suite WITHOUT the env var to confirm it's skipped.**

```bash
cd mcp-server
npx vitest run src/__tests__/compliance-audit-integration.test.ts
```

Expected: 1 test SKIPPED (no failures, no assertions run).

- [ ] **Step 4: Commit.**

```bash
git add mcp-server/src/__tests__/compliance-audit-integration.test.ts
git commit -m "test(mcp): integration test for compliance audit (gated by RUN_INTEGRATION=1)"
```

---

## Task 9: Wire `_review.md` Step 9 to call compliance audit

**depends_on:** [T7]

**Files:**
- Modify: `skills/start/_review.md` (Step 9 block — line ~250-280)

- [ ] **Step 1: Locate the existing Step 9 block.**

```bash
grep -n 'flywheel_verify_beads' skills/start/_review.md
```

Expected: ~2-3 hits clustered around Step 9. Note the line range.

- [ ] **Step 2: Add the compliance_audit invocation immediately after `flywheel_verify_beads` returns.**

Insert this block in `skills/start/_review.md` after the `flywheel_verify_beads` call returns and BEFORE the existing result menu:

````markdown
### Step 9.0a — Compliance audit (default-on wave gate)

After `flywheel_verify_beads` succeeds (no `unclosedNoCommit`), run the compliance audit on the same wave:

```
flywheel_compliance_audit({
  cwd,
  beadIds: <bead-ids-just-closed>,
  mode: 'single-bead',     // default
  threshold: 700,          // default
})
```

Spawns the standalone `/beads-compliance-and-completion-verification` skill in single-bead-parallel mode. Wall time: ~5-10 min for a wave of 5. Honors `FW_COMPLIANCE_OVERRIDE` env for emergency skip.

Branch on `result.structuredContent?.data?.status`:

- `status === 'skipped'` (FW_COMPLIANCE_OVERRIDE set) → display `Compliance: skipped (override)` and proceed to existing Step 9 result menu.
- `status === 'error'` → display the error reason (e.g. `Compliance: error parsing result.json`) and proceed to existing Step 9 result menu (advisory only — do NOT gate).
- `status === 'ok'` AND `failed.length === 0` → display `Compliance: <N> passed (all ≥700/1000)` and proceed to existing Step 9 result menu.
- `status === 'ok'` AND `failed.length > 0` → present the **failure menu** below.

### Step 9.0b — Compliance failure menu

```
AskUserQuestion({
  question: "Compliance audit found <N> false-closed bead(s). What now?",
  header: "Compliance",
  options: [
    { label: "Re-implement failed (Recommended)", description: "Reopened beads <ids> — route back to Step 7 with these as the new wave" },
    { label: "Show evidence", description: "Open <passUtc>/REPORT.md, then re-show this menu" },
    { label: "Override + proceed", description: "Stamp `Compliance-Override: <ids>` trailer in wrap-up commit. Beads stay reopened, session continues" },
    { label: "Skip and continue (advisory)", description: "Treat the audit as advisory, ignore the reopens, proceed to wrap-up. Logged but not gated" }
  ],
  multiSelect: false
})
```

Beads in `failed[]` have ALREADY been reopened (`br update --status open`) by the compliance_audit tool — the menu controls only what happens next, not the bead state. Routing handled in Task 10 (wired below).
````

- [ ] **Step 3: Verify the markdown is well-formed.**

```bash
head -100 skills/start/_review.md | grep -c 'Step 9'
```

Expected: at least 2 hits (existing + new step 9.0a/9.0b).

- [ ] **Step 4: Commit.**

```bash
git add skills/start/_review.md
git commit -m "feat(skills): wire compliance audit into _review.md Step 9 wave gate"
```

---

## Task 10: Wire route handlers + commit-trailer for overrides

**depends_on:** [T9]

**Files:**
- Modify: `skills/start/_review.md` (after Step 9.0b — add 9.0c routing)
- Modify: `skills/start/_wrapup.md` (commit-trailer insertion)

- [ ] **Step 1: Add route handler section to `_review.md`.**

Append after Step 9.0b in `_review.md`:

````markdown
### Step 9.0c — Failure menu routing

Branch on the user's choice:

- **"Re-implement failed"** → set `state.checkpoint.activeBeadIds = failed.map(f => f.beadId)`, write the checkpoint, jump back to Step 7 (implementation). Existing impl agents pick up the reopened beads on next wave. Do NOT re-run `flywheel_approve_beads` — beads are already approved.

- **"Show evidence"** → run:
  ```bash
  cat <passUtc>/REPORT.md
  ```
  where `<passUtc>` = `result.structuredContent?.data?.passUtc`. Then re-show the Step 9.0b menu.

- **"Override + proceed"** → record overrides in checkpoint:
  ```
  state.checkpoint.compliance = {
    overrides: failed.map(f => f.beadId),
    overrideUtc: new Date().toISOString(),
  }
  ```
  Beads remain reopened. Proceed to existing Step 9 result menu (which leads to Step 9.5 wrap-up). `_wrapup.md` will stamp the commit trailer (see Task 10 / `_wrapup.md` change).

- **"Skip and continue (advisory)"** → no checkpoint change. Beads remain reopened (audit findings are real even if user dismisses gate). Proceed to existing Step 9 result menu.
````

- [ ] **Step 2: Modify `_wrapup.md` to stamp the `Compliance-Override:` trailer.**

Find the section in `_wrapup.md` that constructs the wrap-up commit message (search for `git commit` or `commit message`). Add this block immediately before the commit:

````markdown
**Compliance override trailer.** If `state.checkpoint.compliance?.overrides?.length > 0`, append a `Compliance-Override:` trailer to the commit message:

```bash
COMPLIANCE_OVERRIDE="$(echo '<comma-separated overrides>' | tr -d '\n')"
git commit -m "$(cat <<EOF
<existing message body>

Compliance-Override: $COMPLIANCE_OVERRIDE
EOF
)"
```

This creates a permanent audit trail — every overridden compliance failure is searchable via `git log --grep='Compliance-Override:'`.
````

- [ ] **Step 3: Verify the markdown structure.**

```bash
grep -c 'Compliance-Override' skills/start/_wrapup.md
```

Expected: at least 2 hits (the prose + the example).

- [ ] **Step 4: Commit.**

```bash
git add skills/start/_review.md skills/start/_wrapup.md
git commit -m "feat(skills): wire compliance failure-menu routing + override commit-trailer"
```

---

## Task 11: Update AGENTS.md and cross-references

**depends_on:** [T10]

**Files:**
- Modify: `AGENTS.md` (or `README.md` — whichever has the flywheel phase reference)
- Modify: `skills/start/SKILL.md` (Step 9 sub-skill table reference)
- Modify: `skills/start/_review.md` (cross-reference back to spec)

- [ ] **Step 1: Update `AGENTS.md` flywheel-phases section.**

Find the section listing flywheel phases (search for `Step 9` or `verify`). Add or update:

```markdown
### Step 9 — Wave-completion gate

Two-stage gate:
1. **`flywheel_verify_beads`** — status reconciliation (closed beads exist in `br`, matching commits found, attestation files present).
2. **`flywheel_compliance_audit`** (NEW v3.14.0) — invokes `/beads-compliance-and-completion-verification` skill in single-bead-parallel mode to score every closed bead 0-1000 against literal acceptance criteria. Beads scoring below 700 are auto-reopened. See `docs/superpowers/specs/2026-05-08-beads-compliance-integration-design.md`.

Skip via `FW_COMPLIANCE_OVERRIDE=<bead-id-list>` env var or in-menu override.
```

- [ ] **Step 2: Update `skills/start/SKILL.md` phase table.**

Find the table near the top that lists `_review.md` for Steps 8/9. Add a one-line note:

```markdown
| Review & loop | `agent-flywheel:start_review` | `_review.md` | 8, 9 (verify + compliance), 9.25, 9.4 |
```

- [ ] **Step 3: Add a "See also" footer to `_review.md`.**

At the end of `_review.md`:

```markdown
## See also

- Spec: `docs/superpowers/specs/2026-05-08-beads-compliance-integration-design.md`
- Standalone skill: `~/.claude/skills/beads-compliance-and-completion-verification/SKILL.md`
- MCP tool: `mcp-server/src/tools/compliance-audit.ts`
```

- [ ] **Step 4: Commit.**

```bash
git add AGENTS.md skills/start/SKILL.md skills/start/_review.md
git commit -m "docs: cross-reference compliance gate in AGENTS.md and SKILL.md"
```

---

## Task 12: Version bump + CHANGELOG + release build

**depends_on:** [T11]

**Files:**
- Modify: `mcp-server/package.json` (version 3.13.1 → 3.14.0)
- Modify: `CHANGELOG.md`
- Modify: any other version-pinned files (see `version-sync` script)

- [ ] **Step 1: Bump version in `mcp-server/package.json`.**

Change:
```json
"version": "3.13.1"
```
to:
```json
"version": "3.14.0"
```

- [ ] **Step 2: Run version-sync to propagate.**

```bash
cd mcp-server
npm run version-sync
```

Expected: any peer files (root `package.json`, plugin manifests) updated to match.

- [ ] **Step 3: Add `CHANGELOG.md` entry.**

Insert at the top of CHANGELOG.md (above v3.13.1):

```markdown
## [3.14.0] - 2026-05-08

### Added
- **`flywheel_compliance_audit` MCP tool** — wraps the standalone `/beads-compliance-and-completion-verification` skill. Default-on Step 9 wave-completion gate that scores every closed bead 0-1000 against acceptance criteria using real test runs and evidence packs. Beads below threshold (700) are auto-reopened. New tool at `mcp-server/src/tools/compliance-audit.ts`.
- **Compliance failure menu in `_review.md`** — Re-implement / Show evidence / Override / Skip routing.
- **`compliance_false_closed` telemetry counter** — surfaces in welcome-banner error-code trends.
- **Per-bead score persistence in CASS** via new `mcp-server/src/cass-helpers.ts`. Enables future "low-score-N-sessions-in-a-row" signals.

### Changed
- **`/beads-compliance-and-completion-verification` skill** — added `--mode flywheel-gate` shorthand and structured `passes/<UTC>/result.json` output for programmatic callers.

### Why
False-closed beads — where status flipped to `closed` but the work wasn't actually done — were slipping past the existing `verify_beads` gate (which only checks status reconciliation). This wires literal acceptance-criteria verification into the wave-completion gate. See `docs/superpowers/specs/2026-05-08-beads-compliance-integration-design.md`.

### Migration
- No code changes required for existing flywheel users.
- Wave-completion now adds ~5-10 min per wave for the audit. Skip with `FW_COMPLIANCE_OVERRIDE=<comma-separated bead-ids>` or via the in-menu Skip option.
- Standalone skill installation required at `~/.claude/skills/beads-compliance-and-completion-verification/`. If missing, the gate degrades to advisory-only with a banner warning.
```

- [ ] **Step 4: Run the build.**

```bash
cd mcp-server
npm run build
```

Expected: `dist/` rebuilt cleanly. Check `dist/tools/compliance-audit.js` exists.

- [ ] **Step 5: Run the full test suite one more time.**

```bash
cd mcp-server
npx vitest run
```

Expected: all pass (excluding the integration test, which is gated).

- [ ] **Step 6: Commit + tag.**

```bash
git add mcp-server/package.json package.json CHANGELOG.md mcp-server/dist/
git commit -m "release: v3.14.0 — beads-compliance audit gate"
git tag v3.14.0
```

- [ ] **Step 7: Run a final flywheel-doctor smoke check.**

```bash
# In a fresh terminal:
/agent-flywheel:flywheel-doctor
```

Expected: all checks green; `dist_drift` shows `dist is current with src`; new tool is registered.

---

## Self-review checklist (run before handing off)

- [x] Spec coverage: every Section 10 deliverable in the spec maps to a task (T1-T2 = skill changes, T5-T7 = MCP tool, T8 = integration test, T9-T10 = `_review.md`, T11 = docs, T12 = release).
- [x] No placeholders: every step has concrete code or commands.
- [x] Type consistency: `ComplianceAuditOutcome` shape is identical between Tasks 5, 6, and 7.
- [x] Telemetry code name: `compliance_false_closed` used consistently in T3, T7, and T12.
- [x] Mode name: `flywheel-gate` used consistently in T1, T2, T6.
- [x] Override mechanism: `FW_COMPLIANCE_OVERRIDE` env (skip) and `Compliance-Override:` commit trailer (audit-trail) clearly disambiguated in T6, T7, T10, T12.
- [x] Dependency graph: all tasks declare `depends_on:`. T1, T3, T4 have no deps (parallel-safe foundation).

## Out of scope (deferred to v3.15.0+)

- Step 10 wrap-up audit entry point.
- Cron / tripwire entry point (weekly all-closed audit).
- `searchPriorComplianceScores` welcome-banner integration ("low-score N sessions in a row" signal).
- Per-bead override granularity (current: env-list bypasses ALL).
- Compliance score visualization in `flywheel-bead-viewer`.
