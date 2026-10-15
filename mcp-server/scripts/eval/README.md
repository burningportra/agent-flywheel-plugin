# `/start` behavior eval

On-demand regression eval for the `/agent-flywheel:start` orchestrator. Drives a
headless Claude session via the Agent SDK against this repo and asserts on
every attempted `tool_use` — specifically the gates that silently stop firing
if a prose pass or skill de-duplication landed wrong: Step 0d goal menu,
Step 5 plan-mode + ambition menus, Step 5.55 alignment check, Step 5.6
Plan-ready menu, Step 5.6.5 rubric gate, and the "no `br create` before Create
beads" rule.

## One-shot

The harness depends on the Agent SDK. Install it once as a dev dependency,
then run the eval:

```sh
cd mcp-server
npm install --save-dev @anthropic-ai/claude-agent-sdk@^0.3.300
npx tsx scripts/eval/run-eval.ts
```

An `npm run eval:start` script will be added to `mcp-server/package.json`
when its coordinator releases the current exclusive lease on that file
(tracked in Agent Mail; this bead ran under BoldOrchid's hold).

Either path writes `docs/perf/eval-start-baseline.json` (pass/fail per
scenario, token usage, turns, cost, artifact path). Keep this file updated on
`main` before every prose/dedup bead starts.

Per-run JSONL transcripts of every SDK message (both `tool_use` and `text`
blocks, plus every `canUseTool.injectAnswers` decision) land under
`mcp-server/scripts/eval/artifacts/<scenario-id>-<iso>.jsonl` — on failure,
the assertion violations are printed and the JSONL is the full crime scene.

## Flags

- `--only s1-step0d-and-step5,s2-standard-no-early-br-create` — run a subset.
- `--list` — print all scenarios and exit.
- `--dry-run` — show what would run without spawning a model.
- `--no-write-baseline` — observe only; do not overwrite the baseline file.

## Env knobs

- `FW_EVAL_MODEL` (default `claude-sonnet-5-5`). Sonnet is the cheap-but-faithful
  default per the spike; `claude-opus-5-5` is a fallback if a scenario stalls on
  skill following.
- `FW_EVAL_TIMEOUT_MS` (default 600000). Per-scenario hard timeout.
- `FW_EVAL_MAX_BUDGET_USD` (default 1.0). Passed through to the Agent SDK
  (`maxBudgetUsd`).

## Spike decision (confirmed by GoldOrchid 2026-10-15 on sha `80cbba8`)

**Approach:** `query()` from `@anthropic-ai/claude-agent-sdk` with
`permissionMode: 'default'` and a `canUseTool` hook that, when the tool is
`AskUserQuestion`, returns
`{ behavior: 'allow', updatedInput: { ...input, answers: { [question]: label } } }`.
The `answers` map is the permission-layer channel for user responses — the
child receives our scripted picks exactly as if a human had clicked them.

**Rejected approach:** `claude -p --output-format stream-json`. Headless print
mode filters `AskUserQuestion` out of the tool list entirely (the model falls
back to text-rendered menus), so structured option counts and labels cannot be
observed and 5-option menus look identical to 4-option ones. The CLI route
also has no mechanism to answer menus programmatically.

**`permissionMode` must be `'default'`.** `bypassPermissions` auto-approves
every tool call *before* consulting `canUseTool`, so the hook never runs and
no `updatedInput` reaches `AskUserQuestion`. The SDK logs
`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` when this trap fires.

## Side effects (clean up after running)

The eval drives a real `/agent-flywheel:start` session, so it leaves state
behind in the shared checkout:

- `docs/plans/<slug>-<date>.md` written by the planner.
- `.pi-flywheel/plans/<slug>/` artifacts and (on scenario 4) `rubric.md`.
- A fresh Agent Mail identity registered through `macro_start_session` with a
  random adjective-noun name.
- `mcp-server/package.json` may gain a scenario-specific `lint:skill:dev`
  script if the child's plan writes one.

Clean up locally with:

```sh
git checkout -- docs/ mcp-server/package.json
rm -rf .pi-flywheel/plans/make-the-cli-10-faster*
# Optionally retire the eval agent-mail identity if the swarm cares:
# am retire-agent <name>
```

A reasonable follow-up bead would be to run each scenario inside a disposable
`git worktree` with the mail port stubbed, so no state leaks into the shared
checkout.

## Agent Mail

Not stubbed. The Agent SDK discovers the plugin's own MCP server via plugin
auto-loading and Agent Mail via the project's `.mcp.json` on port 8765. This
matches how a real `/start` session runs, which is what the eval needs to
reproduce. If Agent Mail is down when the eval runs, scenarios 2–4 degrade
through the orchestrator's own fallback paths and the failures surface as
explicit baseline violations.

## Goal stability

Each scenario's goal names a synthetic "add a new `flywheel_*` MCP tool"
feature that **no D or E bead in `br list` is landing**. This keeps the goal
meaning the same at 768345f, at HEAD, and at every future compression-pass
sha — Sonnet can't short-circuit on an "already present" observation and the
scripted-answer matcher sees the menus the skill prescribes rather than
ad-hoc "Scope" questions. If you add a scenario or change a goal, pick a
tool name that is not present in `mcp-server/src/tools/` and does not
collide with any slug another agent might reserve on
`docs/brainstorms/<slug>-<today>.md`.

## Skill-tool stub note

When `/agent-flywheel:start` expands to `commands/start.md`, that command's
first `Skill(skill: "agent-flywheel:start")` call is deduped by the harness
with `"Skill /agent-flywheel:start is already loaded above; instructions
unchanged."` and the SKILL.md body never arrives (filed as
`agent-flywheel-plugin-m66.1.5`). The scenario then rides on the model's
recovery path (reading SKILL.md from disk, or calling
`flywheel_get_skill`) instead of the real /start flow, which produces
unstable, misleading baselines.

The harness has a fail-fast guard for this: `scripts/eval/stream.ts` watches
every `Skill(agent-flywheel:*)` tool_result for `"already loaded above"` and
sets `skill_stub_detected: true` on the outcome. `run-eval.ts` surfaces that
as a scenario violation naming m66.1.5 so the run cannot pass. Record new
baselines only at a sha that already contains the m66.1.5 fix.

## CI

Intentionally omitted. This eval spawns a model and spends real money per run
(~$0.50–$1.00 per scenario at Sonnet 5.5). Run it manually before merging
prose/dedup beads and after each cycle wrap-up.
