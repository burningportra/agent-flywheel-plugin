# Plan: Explicit `includePi` Opt-In Dispatch, Agent Mail CLI Timeout Guard, and `br` Config Latency Doctor/Remediation

**Goal**: Explicit `includePi` opt-in flag in `splitBeadsByProvider`/`swarmMixFor`/`flywheel_approve_beads`, bounded Agent Mail CLI timeout guards in implementer prompts, and `br` config latency doctor/remediation.
**Goal Slug**: `explicit-includepi-opt-in-flag-in-splitbeadsbyprovider-swarm`
**Date**: 2026-10-22

---

## 1. Architecture Overview

In `v3.27.0`, the Agent Flywheel switched its default swarm recommendation to **Claude + AGY (`cc:agy 1:1`, `--cc=3 --agy=3`)** whenever `agy` is available, keeping **Pi (`--pi`)** as an explicit operator opt-in in the `Swarm lanes` decision gate. Three follow-up gaps surfaced during the `v3.27.0` dogfood swarm:

1. **Server-side `includePi` Opt-In Routing (`explicit-pi-opt-in-dispatch`)**:
   - Currently, `splitBeadsByProvider` and `swarmMixFor` always route to `splitWithAgy` (`cc:agy 1:1`) when `caps.agy?.available` is true. When the user selects the optional **Claude + AGY + Pi (`--cc=2 --agy=2 --pi=2`)** lane option in the `Swarm lanes` menu, callers have no server flag to request the 3-way `cc:pi:agy` (`1:1:1`) split in `buildImplementerDispatch`, `flywheel_approve_beads(action: "start")`, or `flywheel_advance_wave`.
   - Adding `includePi?: boolean` across `SplitBeadsOptions`, `splitBeadsByProvider`, `swarmMixFor`, `BuildImplementerDispatchArgs`, `ApproveArgs`, and `AdvanceWaveArgs` lets the server natively compute `cc:pi:agy` (`1:1:1`, `--cc=2 --pi=2 --agy=2` for 6 panes) when `includePi: true` and `cc:agy` (`1:1`, `--cc=3 --agy=3`) by default (`includePi` omitted or `false`).

2. **Bounded Agent Mail CLI Timeout Guards (`agent-mail-cli-timeout-guard`)**:
   - During the `v3.27.0` swarm wave, Agent Mail's background git archive commit queue stalled `am file_reservations reserve` and `am mail send` for 40+ seconds in implementer panes.
   - Updating `mcp-server/src/adapters/claude-prompt.ts` (`adaptPromptForAgy`, `adaptPromptForPi`, `adaptPromptForGemini`, and `adaptPromptForClaude`) to wrap/bound `am` CLI invocations with a 10-second timeout guard and non-blocking fallback instructions prevents Agent Mail archive-queue contention from stalling implementer panes.

3. **`br` Config Latency Doctor Check & Auto-Remediation (`br-config-latency-doctor-remediate`)**:
   - On external APFS/SMB volumes (`/Volumes/...`), `br update <id> --status in_progress` inside `flywheel_approve_beads(action: "start")` can exceed the 5000ms timeout unless `.beads/config.yaml` disables telemetry (`metrics.disabled: true`) and auto-flush (`no_auto_flush: true`).
   - Adding a `br_config_latency` check to `flywheel_doctor` and an automated `brConfigLatencyHandler` to `flywheel_remediate` detects and repairs high-latency `.beads/config.yaml` files before `flywheel_approve_beads` runs.

---

## 2. Work Breakdown (3 Parallel Beads, Zero File Contention)

### Bead 1: `explicit-pi-opt-in-dispatch` — Add `includePi` opt-in flag to `splitBeadsByProvider`, `swarmMixFor`, `buildImplementerDispatch`, `flywheel_approve_beads`, and `flywheel_advance_wave`

- **Template**: `feature-implementation`
- **Files**:
  - `mcp-server/src/adapters/model-diversity.ts`
  - `mcp-server/src/adapters/implementer-dispatch.ts`
  - `mcp-server/src/tools/approve.ts`
  - `mcp-server/src/tools/advance-wave.ts`
  - `mcp-server/src/types.ts`
  - `mcp-server/src/server.ts`
  - `mcp-server/src/__tests__/model-diversity.test.ts`
  - `mcp-server/src/__tests__/implementer-dispatch.test.ts`
- **Implementation Details**:
  1. Export `SplitBeadsOptions { readonly includePi?: boolean }` from `mcp-server/src/adapters/model-diversity.ts`.
  2. Update `splitBeadsByProvider(beadIds, caps, opts?: SplitBeadsOptions)` and `splitWithAgy(beadIds, caps, opts?: SplitBeadsOptions)`:
     - When `opts?.includePi` is false/omitted: keep `slots = ['claude', 'agy']` (`cc:agy 1:1`).
     - When `opts?.includePi === true`: use `slots = ['claude', 'pi', 'agy']` (`cc:pi:agy 1:1:1`). If `pi` (or `claude`) is unavailable, reassign its slot to the first available provider in `['claude', 'pi', 'agy']`, emit a reassignment warning if `!caps[preferred]?.disabled`, and set `degraded = true` if any non-disabled slot in `['claude', 'pi', 'agy']` was missing.
  3. Update `swarmMixFor(caps, panes = 6, opts?: SplitBeadsOptions)` to forward `opts` to `splitBeadsByProvider(slots, caps, opts)`.
     - Verify `swarmMixFor(allCapsWithAgy, 6)` returns `{ label: 'cc:agy 3:3', spawnFlags: '--cc=3 --agy=3' }` and `swarmMixFor(allCapsWithAgy, 6, { includePi: true })` returns `{ label: 'cc:pi:agy 2:2:2', spawnFlags: '--cc=2 --pi=2 --agy=2' }`.
  4. Thread `includePi?: boolean` through `BuildImplementerDispatchArgs` (`implementer-dispatch.ts`), `ApproveArgs` (`types.ts`, `approve.ts`, `server.ts`), and `AdvanceWaveArgs` (`types.ts`, `advance-wave.ts`, `server.ts`).
- **Verification Triad**:
  - **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/model-diversity.test.ts src/__tests__/implementer-dispatch.test.ts`
  - **Verify, live**: Run `node -e` against `mcp-server/dist/adapters/model-diversity.js` confirming `swarmMixFor(caps, 6, { includePi: true })` outputs `--cc=2 --pi=2 --agy=2` and default outputs `--cc=3 --agy=3`.
  - **Verify, perf**: `splitBeadsByProvider` and `swarmMixFor` remain pure synchronous `O(N)` functions executing in `<1ms` for 100 beads.

---

### Bead 2: `agent-mail-cli-timeout-guard` — Bound `am` CLI commands in implementer prompts against Agent Mail git archive-queue hangs

- **Template**: `bug-fix`
- **Files**:
  - `mcp-server/src/adapters/claude-prompt.ts`
  - `mcp-server/src/__tests__/claude-prompt.test.ts`
- **Implementation Details**:
  1. Export `AGENT_MAIL_CLI_TIMEOUT_SECONDS = 10` and `AGENT_MAIL_CLI_TIMEOUT_GUARD` from `mcp-server/src/adapters/claude-prompt.ts`.
  2. In `agentMailSteps` (`mcp-server/src/adapters/claude-prompt.ts`):
     - For `agentMail === 'cli'` (`adaptPromptForAgy`, `adaptPromptForPi`, `adaptPromptForGemini`):
       - Instruct panes to bound every `am` shell call to `10s` (e.g., via `perl -e 'alarm 10; exec @ARGV' -- am ...` or shell command timeout `10s`) so Agent Mail's git archive queue never blocks the pane for 40+ seconds.
       - Add explicit non-blocking fallback rule in `0d`: if `am macros start-session`, `am file_reservations reserve`, or `am mail send` times out after 10s due to archive-queue contention, log a one-line warning and proceed immediately with implementation/completion rather than retrying in a blocking loop.
     - For `agentMail === 'mcp'` (`adaptPromptForClaude`):
       - Update `0d` to specify that if an Agent Mail MCP call times out (`>10s`), proceed without blocking the pane or running `am doctor`.
  3. Add unit tests in `mcp-server/src/__tests__/claude-prompt.test.ts` asserting that `adaptPromptForAgy`, `adaptPromptForPi`, `adaptPromptForGemini`, and `adaptPromptForClaude` include the timeout guard and non-blocking fallback instructions.
- **Verification Triad**:
  - **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/claude-prompt.test.ts`
  - **Verify, live**: Inspect rendered prompt output from `adaptPromptForAgy` and `adaptPromptForPi` via `node -e` against `mcp-server/dist/adapters/claude-prompt.js`.
  - **Verify, perf**: Prompt rendering remains pure string assembly (`<1ms` per bead).

---

### Bead 3: `br-config-latency-doctor-remediate` — Add `br_config_latency` check to `flywheel_doctor` and auto-remediation handler to `flywheel_remediate`

- **Template**: `feature-implementation`
- **Files**:
  - `mcp-server/src/tools/doctor.ts`
  - `mcp-server/src/tools/remediate.ts`
  - `mcp-server/src/tools/remediations/br_config_latency.ts`
  - `mcp-server/src/__tests__/doctor-br-config.test.ts`
- **Implementation Details**:
  1. Add `'br_config_latency'` to `DOCTOR_CHECK_NAMES` in `mcp-server/src/tools/doctor.ts`.
  2. Implement `checkBrConfigLatency(cwd: string, signal: AbortSignal, now: () => number): Promise<DoctorCheck>` in `mcp-server/src/tools/doctor.ts`:
     - If `<cwd>/.beads` directory does not exist, return `green` (`"no .beads directory — br config check not applicable"`).
     - Read `<cwd>/.beads/config.yaml`. Check for `no_auto_flush: true` (`/^no_auto_flush\s*:\s*true\b/m`) and `metrics.disabled: true` (`/^metrics\s*:\s*\n(?:\s+#.*\n|\s+\w+.*\n)*?\s+disabled\s*:\s*true\b/m`).
     - If both are enabled: return `green` (`".beads/config.yaml has no_auto_flush: true and metrics.disabled: true"`).
     - Otherwise: return `yellow` with message listing the missing low-latency setting(s) and `hint: BR_CONFIG_LATENCY_HINT` (`"Call flywheel_remediate({ checkName: 'br_config_latency', mode: 'execute', autoConfirm: true }) to enable no_auto_flush and disable metrics in .beads/config.yaml."`).
  3. Create `mcp-server/src/tools/remediations/br_config_latency.ts` exporting `brConfigLatencyHandler: RemediationHandler` and helper `ensureLowLatencyBrConfig(raw: string): string`:
     - Idempotently sets `no_auto_flush: true` and `metrics:\n  disabled: true` in `.beads/config.yaml`, writing a `.beads/config.yaml.bak` backup when modifying an existing file.
     - Register `br_config_latency: brConfigLatencyHandler` in `REMEDIATION_REGISTRY` (`mcp-server/src/tools/remediate.ts`).
  4. Add unit tests in `mcp-server/src/__tests__/doctor-br-config.test.ts` covering green (no `.beads` dir, or both flags set), yellow (missing `no_auto_flush` or `metrics.disabled`), dry-run remediation, execute remediation, backup creation, and `verifiedGreen: true`.
- **Verification Triad**:
  - **Verify, unit**: `npm --prefix mcp-server test -- src/__tests__/doctor-br-config.test.ts`
  - **Verify, live**: Run `flywheel_doctor` on `/Volumes/1tb/Projects/agent-flywheel-plugin` and verify `br_config_latency` reports `green`.
  - **Verify, perf**: Pure synchronous file read of `.beads/config.yaml` (`<2ms` doctor check duration).
