---
name: agent-flywheel
description: >-
  Use when starting, resuming, or operating the Agent Flywheel multi-agent
  workflow (scan, discover, plan, beads, NTM swarm implementation, review, and
  wrap-up), running Poteto (pstack) mode (/why, /interrogate, /architect,
  SHA-coupled verification ledger), or syncing and troubleshooting the
  Antigravity (agy) and OpenCode plugin ports.
---

# Agent Flywheel Operator Skill

Drives the six-phase Agent Flywheel development loop (**Scan → Discover → Plan → Beads → Implement → Review & Wrap-Up**) across Antigravity (`agy`), Claude Code, and OpenCode, including the **High-Stakes Duel Track** and **Poteto (`pstack`) Mode**.

---

## 1. Universal Rules (Non-Negotiable)

1. **Every user decision uses `ask_question` (`AskUserQuestion` in Claude Code).** Never ask the user to choose in plain prose. Keep options to 2–4 labeled choices with the recommended option first (`(Recommended)`).
2. **NTM (`swarm-spawn.js` + `ntm --robot-send`) is mandatory for all multi-agent fan-out.** Never spawn parallel subagents or raw `tmux split-window` loops for deep-plan, swarm implementation, fresh-eyes review, or reality-check.
3. **Load phase sub-skills via `flywheel_get_skill` at every phase boundary.** Prefer `flywheel_get_skill` over `read_file` — it serves the bundled skill body in one MCP call (`mcp-server/dist/skills.bundle.json`).
4. **Branch on structured error codes (`FlywheelErrorCode`).** Inspect `result.structuredContent?.data?.error?.code` (or `data.error.code` via `fw-call.mjs`); never regex-match human prose.
5. **Never edit `.pi-flywheel/checkpoint.json` or `mcp-server/dist/` directly.** Use `flywheel_*` MCP tools for state transitions and `npm --prefix mcp-server run build` for `dist/`.

---

## 2. Calling `flywheel_*` MCP Tools

When the `agent-flywheel` MCP server is mounted in your session, invoke `flywheel_*` tools directly. If `flywheel_*` tools are not registered in the current tool list, run the bundled stdio helper script [fw-call.mjs](./scripts/fw-call.mjs):

```bash
# Returns structuredContent.data as JSON (default --data)
node /Volumes/1tb/Projects/agent-flywheel-plugin/skills/agent-flywheel/scripts/fw-call.mjs \
  <tool_name> '<json_args>' [--data | --text | --full]
```

Examples:

```bash
# 1. Load a phase skill body
node /Volumes/1tb/Projects/agent-flywheel-plugin/skills/agent-flywheel/scripts/fw-call.mjs \
  flywheel_get_skill '{"name":"agent-flywheel:start"}'

# 2. Run the 3-tool Step 0 bootstrap in parallel
node /Volumes/1tb/Projects/agent-flywheel-plugin/skills/agent-flywheel/scripts/fw-call.mjs \
  flywheel_doctor '{"cwd":"/path/to/repo"}'
node /Volumes/1tb/Projects/agent-flywheel-plugin/skills/agent-flywheel/scripts/fw-call.mjs \
  flywheel_observe '{"cwd":"/path/to/repo"}'
node /Volumes/1tb/Projects/agent-flywheel-plugin/skills/agent-flywheel/scripts/fw-call.mjs \
  flywheel_profile '{"cwd":"/path/to/repo"}'
```

---

## 3. Phase-by-Phase Workflow & Sub-Skill Router

At each phase boundary, load the matching sub-skill via `flywheel_get_skill`:

| Phase | Steps | Sub-Skill Name | Key MCP Tools & Scripts |
| :--- | :--- | :--- | :--- |
| **Entry & Scan** | Steps 0–4 | `agent-flywheel:start` | `flywheel_doctor`, `flywheel_observe`, `flywheel_profile`, `flywheel_discover`, `flywheel_select` |
| **Planning** | Steps 4.5–5.6.5 | `agent-flywheel:start_planning` | `flywheel_pi_models`, `flywheel_plan`, `flywheel_convergence`, `flywheel_synthesize_rubric` |
| **Beads** | Steps 5.5–6 | `agent-flywheel:start_beads` | `br create`, `br dep add`, `scripts/check-bead-verify.mjs`, `flywheel_approve_beads` (`start`, `converge-polish`, `verify-bead`) |
| **Swarm Implement** | Step 7 | `agent-flywheel:start_implement` | `flywheel_swarm_host`, `flywheel_pi_models`, `swarm-spawn.js`, `tender-daemon.js`, `flywheel_advance_wave` |
| **In-Flight Prompt** | Step 7b | `agent-flywheel:start_inflight_prompt` | Agent Mail `macro_start_session`, `reserveOrFail`, `.pi-flywheel/completion/<id>.json` |
| **Review & Coverage** | Steps 8–9.4 | `agent-flywheel:start_review` | `flywheel_verify_beads`, `flywheel_compliance_audit`, `flywheel_review` (`looks-good`, `hit-me`, `converge`, `cross-agent`) |
| **Wrap-Up** | Steps 9.45–12 | `agent-flywheel:start_wrapup` | `flywheel_grade_outcome`, `.pi-flywheel/ledger.tsv` audit, `flywheel_memory` (`draft_postmortem`, `store`, `draft_solution_doc`) |

---

## 4. Poteto (`pstack`) Mode Recipe

Use Poteto mode (`poteto: true`) when the user requests `pstack` / `poteto-mode` or high-rigor pre-code interrogation, ADR discipline, and SHA-coupled verification:

1. **Pre-Code Research (`/why`)**:
   - Load `flywheel_get_skill({ name: "agent-flywheel:why" })` (plus `agent-flywheel:why/references/epistemics` and `source-playbook` when needed).
   - Populate all 4 `preCodeResearch` areas: `codebase`, `gitHistory`, `libraryDocs`, and `priorDecisions`.
2. **Adversarial Spec Interrogation (`/interrogate`)**:
   - Load `flywheel_get_skill({ name: "agent-flywheel:interrogate" })`.
   - Write `docs/specs/<slug>-interrogation.md` covering behavioral invariants, failure modes, and observability.
3. **Architecture Decision Record (`/architect`)**:
   - Load `flywheel_get_skill({ name: "agent-flywheel:architect" })`.
   - Write `docs/architecture/<slug>-adr.md` and append a row to `decisions.tsv`.
4. **Poteto Plan Registration & Verification Triad Check**:
   - Call `flywheel_plan({ cwd, mode: "deep", poteto: true, preCodeResearch })`.
   - Validate the synthesized plan before creating beads:
     ```bash
     node /Volumes/1tb/Projects/agent-flywheel-plugin/scripts/check-plan.mjs docs/plans/<slug>.md
     node /Volumes/1tb/Projects/agent-flywheel-plugin/scripts/check-bead-verify.mjs docs/plans/<slug>.md --json
     ```
   - Every bead must carry the **Plan Verification Triad**:
     - `Verify, unit:` (fast deterministic command)
     - `Verify, live:` (real CLI/process/fixture execution)
     - `Verify, perf:` (bounded latency/resource budget)
5. **Independent SHA-Coupled Bead Verification**:
   - After each bead closes and writes `.pi-flywheel/completion/<beadId>.json`, stamp its `git patch-id --stable`-coupled verdict:
     ```bash
     node /Volumes/1tb/Projects/agent-flywheel-plugin/skills/agent-flywheel/scripts/fw-call.mjs \
       flywheel_approve_beads '{"cwd":"<cwd>","action":"verify-bead","beadId":"<id>","verdict":"verified","baseSha":"<base>","headSha":"<head>"}'
     ```
   - With `potetoMode: true` or `FW_VERIFICATION_REQUIRED=1`, `flywheel_advance_wave` blocks on `verification_missing`, `verification_failed`, or `verification_sha_drift`.

---

## 5. Multi-Agent NTM Swarm Quick Recipe

1. **Choose Swarm Lanes (`AskUserQuestion` header `"Swarm lanes"`)**:
   - **Claude + AGY (Recommended):** Spawn `--cc` + `--agy` panes (`--cc=3 --agy=3` for 6 panes) — no Pi setup required.
   - **Claude + AGY + Pi (optional Pi):** Include `--pi=N`, then call `flywheel_pi_models({ cwd, action: "list", roles: ["implementer"] })`, ask via `ask_question`, and persist with `action: "choose"`.
   - **Claude only:** Spawn `--cc=N` panes.
2. **Spawn the NTM Swarm**:
   ```bash
   node "/Volumes/1tb/Projects/agent-flywheel-plugin/mcp-server/dist/scripts/swarm-spawn.js" \
     <project> --label <purpose> --cc=3:opus --agy=3 [--pi=N --pi-model=<provider>/<model>]
   ```
   - Read the printed `session` and `panes: [{ lane, index, paneId, model }]`.
   - When **Claude + AGY** is selected, route non-`cc` bead prompts to the `agy` panes by printed `index`.
3. **Dispatch Marching Orders & Supervise**:
   - Send marching orders with `ntm --robot-send=<session> --panes=<index> --msg="..."` (staggered 5s between panes).
   - Start the tender daemon:
     ```bash
     node "/Volumes/1tb/Projects/agent-flywheel-plugin/mcp-server/dist/scripts/tender-daemon.js" \
       --session=<session> --cwd="<cwd>" --project-key="<cwd>" --coordinator="<AgentMailName>" &
     ```

---

## 6. Antigravity (`agy`) & OpenCode Port Sync

The Claude Code plugin checkout (`/Volumes/1tb/Projects/agent-flywheel-plugin`) is the single source of truth. Both ports are derived artifacts:

```bash
# Sync and validate the Antigravity (agy) plugin port
bash /Volumes/1tb/Projects/agent-flywheel-plugin/scripts/sync-agy.sh --write
agy plugin validate ~/.gemini/antigravity/plugins/agent-flywheel --strict --json

# Sync the OpenCode plugin port
bash /Volumes/1tb/Projects/agent-flywheel-plugin/scripts/sync-opencode.sh --write
```

Or via MCP tool:
```bash
node /Volumes/1tb/Projects/agent-flywheel-plugin/skills/agent-flywheel/scripts/fw-call.mjs \
  flywheel_emit_agy '{"cwd":"/Volumes/1tb/Projects/agent-flywheel-plugin","targetDir":"~/.gemini/antigravity/plugins/agent-flywheel","mode":"write"}'
```
