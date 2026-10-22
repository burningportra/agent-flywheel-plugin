# Plan: First-class Claude + AGY Swarm Lanes, Native AGY Prompt Adapter, and `prompt_suggester_plugin` Doctor Check

**Date:** 2026-10-22
**Goal slug:** `first-class-claude-agy-swarm-lanes-in-mcp-engine-doctor-with`
**Goal:** First-class Claude + AGY swarm lanes in MCP engine & doctor (with Pi opt-in), native AGY implementer prompt adapter (`adaptPromptForAgy`), and `prompt_suggester_plugin` doctor check.

---

## 1. Executive Summary

Commit `2de549f` updated the skill `AskUserQuestion` menus (`skills/start/_implement.md`, `skills/start/_inflight_prompt.md`, `skills/flywheel-swarm/SKILL.md`, `skills/start/_planning.md`) so **Claude + AGY (`--cc` + `--agy`)** is the recommended default swarm lane mix and **Pi (`--pi`)** is opt-in. However, the TypeScript MCP engine still models only `claude | pi | gemini | codex`:

1. **Swarm lane engine & config (`mcp-server/src/flywheel-config.ts`, `mcp-server/src/adapters/model-diversity.ts`, `mcp-server/src/adapters/implementer-dispatch.ts`)**:
   - `ModelProvider` and `NtmImplementationLane` lack `'agy'`.
   - `splitBeadsByProvider()` and `swarmMixFor()` cannot assign beads or pane counts to `--agy`, causing `flywheel_doctor.swarm` to report `cc:pi 2:4` and `buildImplementerDispatch()` to emit `lane: 'pi'` instead of `lane: 'agy'`.
2. **Native AGY implementer prompt adapter (`mcp-server/src/adapters/claude-prompt.ts`, `mcp-server/src/adapters/codex-prompt.ts`)**:
   - `--agy` worker panes currently receive raw Claude Code prompt instructions without an `adaptPromptForAgy()` adapter that sets `program='agy'`, uses `am` CLI for Agent Mail, and provides the AGY tool translation directive (`run_command`, `read_file`, `edit_file`, `write_file`).
3. **`prompt_suggester_plugin` doctor check (`mcp-server/src/tools/doctor.ts`, `mcp-server/src/tools/remediate.ts`)**:
   - `prompt-suggester` runs across Claude Code (`~/.claude/plugins/prompt-suggester`) and Antigravity (`~/.gemini/config/plugins/prompt-suggester`) and reads `.pi-flywheel/checkpoint.json`, but `flywheel_doctor` has no health probe for it.

---

## 2. Architecture & Design Decisions

### 2.1 Backward-Compatible `CapabilitiesMap` + First-Class `'agy'` Lane
- Extend `ModelProvider` to `'claude' | 'codex' | 'gemini' | 'pi' | 'agy'` and `NtmImplementationLane` to `'cc' | 'cod' | 'gmi' | 'pi' | 'agy'`.
- Keep `CapabilitiesMap.agy?: CliCapability` optional on the TypeScript interface so existing unit tests that construct `{ claude, codex, gemini, pi }` literals remain 100% source- and behavior-compatible, while `detectCliCapabilities()` always populates `agy` via `which agy` (unless `lanes.agy === false` in `flywheel.config.yaml`).
- In `splitBeadsByProvider(beadIds, caps)`:
  - When `caps.agy?.available` is `true` and both `pi` and `gemini` are unavailable/disabled (`!caps.pi.available && !caps.gemini.available`), split beads 50/50 (`Math.ceil(n/2)` to `claude`, `Math.floor(n/2)` to `agy` when both are available, or all to `agy` if `claude` is unavailable). For a 6-pane swarm, `swarmMixFor()` yields `{ label: 'cc:agy 3:3', spawnFlags: '--cc=3 --agy=3' }`.
  - When `caps.agy?.available` is `true` alongside `claude` and `pi` (with `gemini` disabled/unavailable), `agy` takes the 3rd primary lane slot (`claude`, `pi`, `agy` at 2:2:2 → `--cc=2 --pi=2 --agy=2`).
  - When `caps.agy` is undefined or unavailable, preserve the existing `claude:pi:gemini` (`codex` fallback) split unchanged.
- Extend `CONFIGURABLE_LANES` in `mcp-server/src/flywheel-config.ts` to `['gemini', 'codex', 'pi', 'agy'] as const` with `DEFAULT_CONFIG.lanes.agy = true`.

### 2.2 Native `adaptPromptForAgy()` Implementer Prompt Adapter
- In `mcp-server/src/adapters/claude-prompt.ts`:
  - Widen `TerminalPromptIdentity.provider` to `'claude' | 'pi' | 'gemini' | 'agy'` and `program` to `'claude-code' | 'pi' | 'agy'`.
  - Widen `AdaptedPrompt.provider` in `mcp-server/src/adapters/codex-prompt.ts` to `'claude' | 'codex' | 'gemini' | 'pi' | 'agy'`.
  - Export `adaptPromptForAgy(bead: BeadDispatchContext): AdaptedPrompt` using `agentMail: 'cli'` (`am` CLI commands), `program: 'agy'`, `model: 'agy'`, and an AGY harness tool note (`Use AGY native tools: run_command for shell commands, read_file, edit_file, write_file`) while keeping the identical `STEP 0`–`STEP 4` and `## PRE-COMPLETION QUALITY GATE` (`CompletionReportSchemaV1`) blocks.
  - Wire `case 'agy': return adaptPromptForAgy(ctx);` into `adaptPromptFor()` in `mcp-server/src/adapters/model-diversity.ts`.

### 2.3 Non-Blocking `prompt_suggester_plugin` Doctor Check
- Add `'prompt_suggester_plugin'` to `DOCTOR_CHECK_NAMES` in `mcp-server/src/tools/doctor.ts` and `prompt_suggester_plugin: null` to `REMEDIATION_REGISTRY` in `mcp-server/src/tools/remediate.ts`.
- Add `promptSuggesterPath?: string | null` to `DoctorOptions`.
- `checkPromptSuggesterPlugin()` inspects candidate plugin roots (`options.promptSuggesterPath`, or `~/.claude/plugins/prompt-suggester` and `~/.gemini/config/plugins/prompt-suggester`):
  - When `promptSuggesterPath === null` or no candidate directory exists: return `severity: 'green'`, message `'prompt-suggester not installed (optional next-prompt steering plugin)'`.
  - When installed: verify manifest JSON (`plugin.json` or `gemini-extension.json`) parses with a string `version` AND `hooks/suggester-hook.mjs` exists. Return `severity: 'green'` (`prompt-suggester <version> installed (<targets>)`) when valid, or `severity: 'yellow'` with an actionable hint when corrupt or missing its hook script.

---

## 3. Implementation Phases & Bead Breakdown

### Phase 1 (Parallel Wave 1)
- **Bead 1 (`agy-prompt-And-config`)**: Extend `flywheel-config.ts` (`lanes.agy`), `codex-prompt.ts` (`AdaptedPrompt.provider`), and `claude-prompt.ts` (`adaptPromptForAgy`), with unit tests in `mcp-server/src/__tests__/adapters/completion-attestation-prompt.test.ts` and `mcp-server/src/__tests__/flywheel-config-r008.test.ts`.
- **Bead 2 (`prompt-suggester-doctor`)**: Add `prompt_suggester_plugin` to `mcp-server/src/tools/doctor.ts` and `mcp-server/src/tools/remediate.ts`, update `mcp-server/src/__tests__/tools/doctor.test.ts` and `mcp-server/src/__tests__/__snapshots__/capabilities.test.ts.snap`.

### Phase 2 (Wave 2 — depends on Bead 1)
- **Bead 3 (`agy-model-diversity-dispatch`)**: Wire `'agy'` into `mcp-server/src/adapters/model-diversity.ts` (`detectCliCapabilities`, `splitBeadsByProvider`, `swarmMixFor`, `adaptPromptFor`, `describeCapabilities`) and `mcp-server/src/adapters/implementer-dispatch.ts` (`NtmImplementationLane`), add unit tests in `model-diversity.test.ts` and `implementer-dispatch.test.ts`, and rebuild `mcp-server/dist/`.

---

## 4. File-Level Changes

| File | Change |
|------|--------|
| `mcp-server/src/flywheel-config.ts` | Add `'agy'` to `CONFIGURABLE_LANES`, `FlywheelConfigLanes`, `DEFAULT_CONFIG.lanes`, and `loadFlywheelConfigWithWarnings` |
| `mcp-server/src/adapters/codex-prompt.ts` | Widen `AdaptedPrompt['provider']` to include `'agy'` |
| `mcp-server/src/adapters/claude-prompt.ts` | Add `adaptPromptForAgy()` with AGY tool translation note and `am` CLI bootstrap |
| `mcp-server/src/adapters/model-diversity.ts` | Add `'agy'` to `ModelProvider`, `CapabilitiesMap`, `detectCliCapabilities`, `splitBeadsByProvider`, `swarmMixFor`, `adaptPromptFor`, `describeCapabilities` |
| `mcp-server/src/adapters/implementer-dispatch.ts` | Add `'agy'` to `NtmImplementationLane` and `NTM_LANE` |
| `mcp-server/src/tools/doctor.ts` | Add `prompt_suggester_plugin` check and `DoctorOptions.promptSuggesterPath` |
| `mcp-server/src/tools/remediate.ts` | Add `prompt_suggester_plugin: null` to `REMEDIATION_REGISTRY` |
| `mcp-server/src/__tests__/**` | Add unit tests for `adaptPromptForAgy`, `lanes.agy`, `cc:agy 3:3` split/mix, and `prompt_suggester_plugin` doctor check; update `capabilities.test.ts.snap` |

---

## 5. Testing Strategy & Plan Verification Triad

- **Verify, unit**: `npm --prefix mcp-server test` covering `model-diversity.test.ts`, `implementer-dispatch.test.ts`, `completion-attestation-prompt.test.ts`, `flywheel-config-r008.test.ts`, `doctor.test.ts`, `remediate.test.ts`, and `capabilities.test.ts`.
- **Verify, live**: Run `npm --prefix mcp-server run build` and invoke `flywheel_doctor` to confirm `prompt_suggester_plugin` and `swarm` (`cc:agy 3:3` when `lanes.pi: false`) report green.
- **Verify, perf**: Confirm `runDoctorChecks` completes well under the 2000ms per-check budget (`prompt_suggester_plugin` uses synchronous `existsSync`/`readFileSync` with zero child-process spawns, `< 5ms`).

---

## 6. Risk & Mitigation

- **Risk**: Existing `model-diversity.test.ts` and `implementer-dispatch.test.ts` pass `{ claude, codex, gemini, pi }` without `agy`.
  - **Mitigation**: Keep `CapabilitiesMap.agy` optional (`readonly agy?: CliCapability`) and activate the `agy` slot in `splitBeadsByProvider` only when `caps.agy?.available === true`.
- **Risk**: `capabilities.test.ts` pins `doctor_check_count` in a Vitest snapshot.
  - **Mitigation**: Update `mcp-server/src/__tests__/__snapshots__/capabilities.test.ts.snap` in Bead 2 and verify with `npx vitest run src/__tests__/capabilities.test.ts`.
