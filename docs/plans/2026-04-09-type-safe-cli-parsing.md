# Type-Safe CLI Parsing Plan

**Goal:** Replace all unsafe `JSON.parse` + `as T` casts with Zod-validated parsing for br/bv CLI outputs, agent-mail responses, and other JSON boundaries.

**Date:** 2026-04-09
**Scope:** mcp-server/src/

## Problem

28 JSON.parse sites found across the codebase. 3 are high-risk (silent data corruption possible), 7 moderate-risk. The codebase already has well-defined TypeScript interfaces in `types.ts` but no runtime validation — a schema change in `br` or `bv` CLI output causes silent property-access failures.

## Approach

1. Add Zod as a dependency
2. Create `mcp-server/src/parsers.ts` — centralized Zod schemas + parse functions
3. Replace unsafe `JSON.parse(...) as T` patterns with validated parsers
4. Add regression tests for the parser module

## Dependency Graph

```
T1 (Install Zod) ──┐
                    ├──> T3 (Replace br/bv call sites)
T2 (Create parsers.ts) ┘         │
                                  ├──> T5 (Tests)
T4 (Replace agent-mail + misc) ──┘
```

## Tasks

### T1: Install Zod dependency
- `cd mcp-server && npm install zod`
- **Effort:** small
- **depends_on:** []

### T2: Create `mcp-server/src/parsers.ts` with Zod schemas
- Define schemas mirroring existing interfaces:
  - `BeadSchema` → validates br list --json output items
  - `BvInsightsSchema` → validates bv --robot output
  - `BvNextPickSchema` → validates bv --robot-triage/next output
  - `BrStructuredErrorSchema` → validates br error JSON
  - `AgentMailRpcResponseSchema` → validates agent-mail stdout
  - `CmResultSchema` → validates cm CLI output (memory)
  - `SophiaResultSchema` → validates sophia CLI output
- Export parse functions: `parseBrList()`, `parseBvInsights()`, `parseBvNextPick()`, `parseAgentMailResponse()`, etc.
- Each parse function: takes raw string, returns `{ ok: true, data: T } | { ok: false, error: string }`
- Use `.passthrough()` on schemas to tolerate extra fields from CLI updates
- **Effort:** medium
- **depends_on:** [T1]

### T3: Replace br/bv JSON.parse call sites
Target files and lines:
- `tools/profile.ts:74` — `JSON.parse(brListResult.stdout) as any[]` → `parseBrList()`
- `tools/approve.ts:76` — `JSON.parse(brListResult.stdout) as Bead[]` → `parseBrList()`
- `tools/approve.ts:304` — br ready parse → `parseBrList()`
- `beads.ts:189` — `JSON.parse(...) as BvInsights` → `parseBvInsights()`
- `beads.ts:218` — bv --robot-triage parse → `parseBvNextPick()` (array)
- `beads.ts:243` — bv --robot-next parse → `parseBvNextPick()` (single)
- `cli-exec.ts:107` — br error parse (already good — wrap in schema)
- `cli-exec.ts:299` — generic `as T` → add optional validator parameter
- **Effort:** medium
- **depends_on:** [T2]

### T4: Replace agent-mail, memory, and misc JSON.parse call sites
Target files and lines:
- `agent-mail.ts:91-118` — `let parsed: any` → `parseAgentMailResponse()`
- `agent-mail.ts:162-165` — nested JSON parse → `parseAgentMailResource()`
- `memory.ts:92` — cm result `as T` → `parseCmResult()`
- `memory.ts:211` — cm onboard status → `parseCmOnboardStatus()`
- `memory.ts:247` — cm search results → `parseCmSearchResults()`
- `sophia.ts:78,97` — sophia result → `parseSophiaResult()`
- `feedback.ts:87` — feedback file → `parseFeedbackFile()`
- `profiler.ts:28` — cached profile → `parseProfileCache()`
- **Effort:** medium
- **depends_on:** [T2]

### T5: Add Vitest tests for parsers.ts
- Test each schema with valid data, invalid data, and edge cases (empty arrays, missing fields, extra fields)
- Test that parse functions return proper error messages on invalid input
- Test passthrough behavior (extra fields preserved)
- **Effort:** medium
- **depends_on:** [T3, T4]

## Non-goals
- Validating LLM JSON output (ideation-funnel, plan-quality, bead-splitting) — these already have good inline validation
- Rewriting the types.ts interfaces — Zod schemas will mirror them
- Adding Zod to runtime hot paths that parse package.json (profiler.ts:364,424) — these use safe optional chaining already

## Risks
- Zod adds ~50KB to the bundle — acceptable for an MCP server
- Strict parsing may reject currently-tolerated malformed br output — mitigate with `.passthrough()` and `.optional()` on non-critical fields
