# Frontier-model compression and correctness pass — final report

Program: `agent-flywheel-plugin-m66` ("Frontier-model compression and correctness pass").
Final sha: **`667428b`** (reports and dist updates land after this bead).
Recorded: 2026-10-15 by `GoldOrchid`, closing bead `agent-flywheel-plugin-m66.6.10` (E10).

## 1. Headline numbers

Measured by `npm run prompt-budget` (char counts × ceil/4 tokens, source-of-truth
`docs/perf/prompt-budget.json`). "Before" is M1's recorded baseline at commit
`37c7888` (file sha `0de405c`); "after" is HEAD `667428b`.

| Group            | Before chars | Before tokens | After chars | After tokens | Δ chars  | Δ %     |
|------------------|-------------:|--------------:|------------:|-------------:|---------:|--------:|
| adapter          | 11,293       | 2,824         | 11,184      | 2,797        | −109     | −1.0%   |
| command          | 46,520       | 11,633        | 17,918      | 4,482        | −28,602  | −61.5%  |
| gate             | 3,210        | 803           | 1,654       | 414          | −1,556   | −48.5%  |
| mcp-structured   | 24,186       | 6,049         | 22,653      | 5,667        | −1,533   | −6.3%   |
| mcp-text         | 34,613       | 8,657         | 12,527      | 3,134        | −22,086  | −63.8%  |
| skill            | 334,297      | 83,579        | 177,037     | 44,263       | −157,260 | −47.0%  |
| **Total**        | **454,119**  | **113,545**   | **242,973** | **60,757**   | **−211,146** | **−46.5%** |

The pass shrank the measured prompt surface by **211,146 chars / 52,788 tokens
(46.5%)** across 42 → 41 tracked entries, mostly from the skill prose rewrite
(E-beads) and the mcp-text / command sweeps (A- and D-beads).

The program's root epic set the measurement contract (`agent-flywheel-plugin-m66`):

> Savings are measured by the prompt-budget meter and regressions caught by the
> /start behavior eval (both in the "Measurement and guard rails" epic).

Both guards are green at HEAD.

## 2. Per-skill before/after (start cycle)

| File                                | Before chars | After chars | Δ chars  | Δ %     |
|-------------------------------------|-------------:|------------:|---------:|--------:|
| `skills/start/SKILL.md`             | 65,378       | 42,731      | −22,647  | −34.6%  |
| `skills/start/_planning.md`         | 66,327       | 31,984      | −34,343  | −51.8%  |
| `skills/start/_implement.md`        | 62,105       | 17,602      | −44,503  | −71.7%  |
| `skills/start/_review.md`           | 33,113       | 16,331      | −16,782  | −50.7%  |
| `skills/start/_wrapup.md`           | 27,402       | 13,585      | −13,817  | −50.4%  |
| `skills/start/_inflight_prompt.md`  | 19,097       | 14,058      | −5,039   | −26.4%  |
| `skills/start/_deslop.md`           | 17,523       | 13,294      | −4,229   | −24.1%  |
| `skills/start/_beads.md`            | 16,303       | 6,998       | −9,305   | −57.1%  |
| `skills/start/_reality_check.md`    | 15,568       | 13,840      | −1,728   | −11.1%  |
| `skill:flywheel-swarm/SKILL.md`     | 11,481       | 6,614       | −4,867   | −42.4%  |

The 10-file start-cycle corpus went from 322,816 to 170,423 chars, a 47.2% cut.
The TONE001 ratchet (`.lintskill-tone-baseline.json`, regenerated at close via
`npm run lint:skill:update-tone-baseline` from the TONE bead) locks in the
shouty-token drops that came with the prose pass.

## 3. Per-hot-response before/after (MCP tool text)

The text halves of nine hot MCP responses were the primary target of the C-
and D- beads (goal-aware prompt rewrites + response de-duplication):

| Response                               | Before chars | After chars | Δ chars  | Δ %     |
|----------------------------------------|-------------:|------------:|---------:|--------:|
| `mcp.plan.deep.ambitious.text`         | 11,603       | 278         | −11,325  | −97.6%  |
| `mcp.plan.deep.ambitious.structured`   | 11,621       | 4,850       | −6,771   | −58.3%  |
| `mcp.plan.deep.scoped.text`            | 6,026        | 275         | −5,751   | −95.4%  |
| `mcp.plan.deep.scoped.structured`      | 6,048        | 4,497       | −1,551   | −25.6%  |
| `mcp.review.hit-me.text`               | 3,381        | 172         | −3,209   | −94.9%  |
| `mcp.review.hit-me.structured`         | 3,280        | 2,061       | −1,219   | −37.2%  |
| `mcp.approve.start.text`               | 1,762        | 707         | −1,055   | −59.9%  |
| `mcp.approve.start.structured`         | 1,309        | 9,317       | +8,008   | +611.8% |
| `mcp.approve.advanced-blunder-hunt.text` | 1,211      | 443         | −768     | −63.4%  |

**Note on `mcp.approve.start.structured`.** The +611% is intentional: D8
(`agent-flywheel-plugin-m66.5.8`, commits `a52fdbb` + `dd3b7ef` + `b8684e8` +
`77ee233`) moved the implementer lane prompts (built per-bead by
`mcp-server/src/adapters/completion-attestation-prompt.ts`) into
`flywheel_approve_beads(action: "start")`'s structured payload so the three
dispatchers (`flywheel-swarm`, `_implement.md`, `commands/flywheel-swarm.md`)
can send the server-built bytes unchanged. The matching text pay-load dropped
by 60%, and three skill locations that used to duplicate the Pre-Completion
Quality Gate now point at AGENTS.md.

## 4. Behavior eval

Baseline is `docs/perf/eval-start-baseline.json` at sha `77ee233` (recorded
in M3, commit `303a985`, 20 pass/20 harness unit tests + 4 scenario rows).
The eval was rerun at HEAD `667428b` with `--no-write-baseline`, so the
baseline file is unchanged. Rows come from
`/tmp/claude-501/e10-s1s2.log` (s1 + s2) and task-run `b1sbu7pyw` (s3 + s4);
"turns" and "tools" are the runner-level counts the SDK's result row would
not surface on its own. All four scenarios pass:

| Scenario                              | Baseline @ 77ee233           | HEAD @ 667428b              | Δ turns |
|---------------------------------------|------------------------------|-----------------------------|--------:|
| `s1-step0d-and-step5`                 | pass, 46 turns, 25 tools, $0.5391 | pass, 41 turns, 23 tools, $0.4838 | −5 |
| `s2-standard-no-early-br-create`      | pass, 40 turns, 24 tools, $0.4621 | pass, 37 turns, 21 tools, $0.4903 | −3 |
| `s3-ambitious-writes-charter-first`   | pass, 48 turns, 23 tools, $0.5093 | pass, 49 turns, 27 tools, $0.5648 | +1 |
| `s4-rubric-gate-before-bead-creation` | pass, 73 turns, 43 tools, $0.7892 | pass, 75 turns, 41 tools, $0.8166 | +2 |

s1 and s2 ran fewer turns at HEAD than at the baseline sha; s3 and s4 ran
slightly more (one additional menu round in s3's ambition pass, and the
rubric-gate branch in s4). The three invariant guards from M3 (worktree
plugin check, `skill_stub_detected`, `pick_events.unmatched`) reported
clean on every scenario. Logs survive under `/tmp/claude-501/e10-s1s2.log`
and the per-scenario JSONL artifacts under
`mcp-server/scripts/eval/artifacts/`.

**Carry-over coverage** called out in the bead comments is explicitly green:

- `s2` + `s4` are the first eval evidence that **C3** (`m66.4.4`
  review hit-me dedupe) and **C4** (`m66.4.5` approve blunder-hunt single
  render) did not regress the standard planning path.
- `s4` passing is the first eval evidence that **D1** (`m66.5.1` centralized
  NTM readiness), **D7** (`m66.5.7` server-owned bead-creation audit) and
  **D9** (`m66.5.9` wrap-up grading + team drain) did not break the
  rubric-gate ordering. Those three beads closed with `s4` deferred due to
  the M3 harness defect; M3's fixed harness now scores them.

**Coverage gap stated plainly.** The four scenarios load
`SKILL.md`, `_planning.md`, and `_beads.md`. They do **not** reach
`_implement.md`, `_review.md`, `_wrapup.md`, `_deslop.md`,
`_inflight_prompt.md`, or `_reality_check.md`. Those files' prose cuts are
covered by lint (`npm run lint:skill -- --ci`), the full vitest suite, and
reviewer eyes, not by this eval. The gap is filed as P3 bead
**`agent-flywheel-plugin-4p7`** (not dispatched; waits for the user).

## 5. Bugs fixed, with regression tests

Every bug in the correctness track closed with a regression test or an
equivalent on-disk guard. Row = bead → fix commit → test file:name.

| Bead | Fix | Regression test |
|------|-----|-----------------|
| `fpf` cross-program bead claim | `3afc6d3` (repro) + `94ae858` + `72c3c94` + `b36674a` (hotspot fixtures) | `mcp-server/src/__tests__/tools/approve.test.ts:389`, `advance-wave.test.ts:430`, `review.test.ts:294` (per the bead's close note) |
| `m66.3.2` B2 — calibrate had no per-template data | `e64150e` | `mcp-server/src/__tests__/tools/calibrate.test.ts`, `bead-prompt.test.ts` |
| `m66.3.3` B3 — duel provenance never reached bead prompts | `545bfa0` | `mcp-server/src/__tests__/duel-provenance.test.ts`, `bead-prompt.test.ts` |
| `m66.3.4` B4 — CASS memory didn't reach approve prompts | `7eb9920` | `mcp-server/src/__tests__/feedback.test.ts`, `memory.test.ts` |
| `m66.3.5` B5 — model table drift + unreachable Gemini planner | `5dcb2a8` + `de3cb32` | `mcp-server/src/__tests__/model-detection.test.ts`, `model-routing.test.ts` |
| `m66.3.6` B6 — "Skip rubric" couldn't be saved | `39b80b7` + `650045c` | `mcp-server/src/__tests__/synthesize-rubric.test.ts` |
| `m66.3.7` B7 — Codex rescue packet exposed as MCP tool | `1f9df0f` | `mcp-server/src/__tests__/tools/rescue.test.ts` |
| `m66.3.8` B8 — preflight banner + first-run flag from server | `55c8d7b` | `mcp-server/src/__tests__/preflight-yellow.test.ts`, `tools/doctor-preflight.test.ts`, `tools/doctor.register.test.ts` |
| `m66.3.9` B9 — headless review mode exit signal | `f6cbb91` + `f184fc1` + `e3e10f4` | `mcp-server/src/__tests__/tools/review.test.ts` (headless exit cases) |
| `m66.3.10` B10 — guided review gates 3–5 not skipped | `a56414d` | `mcp-server/src/__tests__/tools/review.test.ts` |
| `m66.3.11` fix — batch reviewer prompt in text + dispatch | `398f5ed` + `e47a53f` | `mcp-server/src/__tests__/tools/review.test.ts`, `gates.test.ts` |
| `m66.3.12` fix — NTM pane addressing + plan-file write races + swarm doc drift | `53f678a` + `960be7e` + `b7eb9db` | `mcp-server/src/__tests__/swarm-text-contradictions.test.ts` |
| `m66.3.14` B14 — wave-2+ implementer prompt attestation ask | `6de4558` | `mcp-server/src/__tests__/adapters/completion-attestation-prompt.test.ts` |
| `m66.3.15` B15 — `goalSlug` returned by `flywheel_select` | `49f12ac` + `3c29ed2` | `mcp-server/src/__tests__/tools/select.test.ts` |
| `m66.3.16` B16 — dead `orch_*` aliases + unlisted `flywheel_emit_codex` | `aec0cbd` | `mcp-server/src/__tests__/capabilities.test.ts` (+ snapshot) |
| `m66.1.5` pointer-command dedup trap | `612de81` | `mcp-server/src/__tests__/pointer-command-guard.test.ts` |
| `m66.1.3` M3 eval harness defects (3 rounds) | `7cea059` + `598c149` + `303a985` | `mcp-server/scripts/eval/argv.test.ts` (13) + `pick.test.ts` (7) + three live invariant guards (plugin path, skill-stub, unmatched target) |
| `m66.1.4` M4 argv parser hardening | `7cea059` | included in `argv.test.ts` |
| `1d6` TONE updater missing | `e1e85c9` | `mcp-server/scripts/update-tone-baseline.test.ts` (11) |

Everything in the "Confirmed bug → regression test" column of the root epic's
success criteria is checked.

## 6. Promises either implemented or deleted

| Promise                                                           | Status |
|-------------------------------------------------------------------|--------|
| `flywheel_rescue` MCP tool (B7)                                   | Implemented (`1f9df0f`) + AGENTS.md entry below |
| "Skip rubric" action persisted on checkpoint (B6)                 | Implemented (`39b80b7`) + AGENTS.md entry below |
| `flywheel_select` returns `goalSlug` (B15)                        | Implemented (`49f12ac`), consumer skills updated (`3c29ed2`) |
| Doctor/observe preflight banner (B8)                              | Implemented (`55c8d7b`), surfaced in server response |
| Wave-2+ implementer prompt asks for attestation (B14)             | Implemented (server builds it; AGENTS.md § "Completion Evidence Attestation" is the single source) |
| Server-owned bead-creation audit (D7)                             | Implemented (`358d073`) |
| `npm run lint:skill:update-tone-baseline` (TONE, bead `1d6`)      | Implemented (`e1e85c9`); docs/skill-style.md:25 now true |
| `/agent-flywheel:start` loads SKILL.md on first turn (m66.1.5)    | Implemented (`612de81` points all four pointer commands through `flywheel_get_skill`) |
| Pre-Completion Quality Gate as a single source (D3)               | Implemented — AGENTS.md owns the gate; three implementer skills point at it; the server builder injects the per-bead JSON example |
| Codex rescue text in three skills (D2)                            | Replaced with one `flywheel_rescue` call per skill |
| NTM readiness bash gates in three skills (D1)                     | Replaced with one `flywheel_doctor` + `flywheel_remediate` call |
| `prompts.ts` module                                               | **Deleted** (`37bd1d0`); five live exports moved to callers (A6) |
| Unused `_planning.md` readiness chain                             | **Deleted** (`26e1734`) |
| Dead `swarm` helpers                                              | **Deleted** (`2c68173`) |
| Dead `shared` exports                                             | **Deleted** (`2ef2f50`) |

The unreachable-server-code goal of the root epic (goal 1) is clean per the
reachability report (`npm run dead-code`), which has stayed green since A6
landed.

## 7. vce command/skill shadowing resolution

The parent `agent-flywheel-plugin-vce` audit found 21 command/skill name pairs
where the command body shadowed the skill. m66.1.5 fixed the four pointer
commands (`start`, `flywheel-reality-check`, `flywheel-speedup`,
`grill-with-docs`); `vce.1` and `vce.2` handled the rest in parallel.

**vce.1 (11 pairs: audit, cleanup, compound-refresh, doctor, drift-check, duel,
fix, healthcheck, refine-skill, refine-skills, research).** HEAD totals:
commands 17,127 chars, skills 53,347 chars (combined 70,474 chars). The
commands are now thin pointers; several skills grew because they absorbed text
moved out of their command body (notably `flywheel-doctor` SKILL at 13,359
chars). `pointer-command-guard.test.ts` was extended by this half to pin the
contract across every matching command/skill pair with an explicit
exceptions-and-reasons allowlist.

**vce.2 (10 pairs: rollback, scan, setup, status, stop, swarm, swarm-status,
swarm-stop, tool-feedback, memory).** HEAD totals: commands 4,479 chars, skills
28,291 chars (combined 32,770 chars). The commands are now one-line pointers
(average ~450 chars); `flywheel-setup` SKILL (12,333 chars) and
`flywheel-swarm` SKILL (6,645 chars, still carrying D8's server-prompt
dispatch text) are the two large bodies — see
`implement-dispatch-contract.test.ts`.

**21-pair total**: 103,244 chars at HEAD across commands + skills. The vce
split is why some skills grew in isolation: text that used to double-live in
the shadowing command body is now in one place.

## 8. Load-bearing text kept on purpose

Per the root epic's "Load-bearing text: do NOT compress" list, every item in
that list was preserved. Verified by lint + test survival:

- `> ## ⚠️ ... UNIVERSAL RULE` heading in `skills/start/SKILL.md` — IMPL001
  carve-out depends on it; `live-flywheel.test.ts` would fail if removed.
- Strings pinned by `menu-options.test.ts`, `goal-framing-grill.test.ts`,
  `preflight-yellow.test.ts`, and `wrapup-step-10-55.test.ts` — all still
  green.
- `opencode/compatibility.json` WARN counts — `667428b` (E9) refreshed those
  counts after the prose pass.
- `<!-- pane001-override -->` in `_deslop.md` — PANE001 CI check still green.
- The CompletionReport JSON example in `_implement.md` — moved to the
  server-built implementer prompt (`completion-attestation-prompt.ts`); the
  skill now points at AGENTS.md's canonical copy (D3, `603cc8a`).
- Prompts sent to Codex / Gemini panes — adapters' prose unchanged except for
  the shared attestation gate injection.
- Shouted tool facts kept with their caps dropped — grep for them in
  `_implement.md` / `_planning.md`.
- Security and boundary checks (planFile path-safety, review `shaRange`
  regex, approve mutex, outcome-grading JSON extraction) — all preserved.
- "Use ultrathink." — kept exactly once per deep-reasoning subagent prompt.

## 9. CI gates

- `prompt-budget` CI job at `.github/workflows/ci.yml` (added by `ab967a9`,
  C5) runs `npm run prompt-budget -- --check` on PRs. **It has never run on
  GitHub Actions**, because this program has never pushed. The job is there
  for the first push after release.
- `lint:skill`, `lint:skill:update-tone-baseline`, `check:skills-bundle`,
  `prompt-budget --check`, and `bats install/test/test-sync-opencode.bats`
  are all green locally at HEAD.
- `pointer-command-guard.test.ts` (extended by `vce.1`) + the attestation and
  dispatch-contract tests pin the contracts the compression pass depends on.

## 10. Known deltas you can see at HEAD

- The TONE001 ceiling dropped from the pre-E2 baseline to post-E2 counts.
  `_planning.md` 34 → 0, `_implement.md` 22 → 0, `_review.md` 10 → 0 are the
  biggest. See `mcp-server/.lintskill-tone-baseline.json`.
- `tender-daemon.test.ts` has a known ~1-in-3 flake per AGENTS.md; the full
  isolated vitest gate at `ce40623` (equivalent to `667428b` for
  `mcp-server/`) reports 2,676 passed, 2 skipped, 0 failed.
- Dist is rebuilt by the coordinator after each wave; the last clean rebuild
  in this program is **`ce40623`** (from clean `b36674a`).

## 11. Next decision for the user — not part of this bead

The release step (version bump, tag, push, updating both Macs) is explicitly
outside E10's scope per the root epic:

> Releasing (version bump, tag, push, updating both Macs) is the user's call
> and is not part of this program.

A release will:

1. Push `667428b` (and any later dist rebuild) to the GitHub remote. The
   `prompt-budget` CI job runs for the first time there and enforces the
   budget forward.
2. Bump `mcp-server/package.json` from `3.19.1` and tag.
3. Update both Macs via the normal plugin-sync path
   (`/plugin install burningportra/agent-flywheel-plugin` or the local
   checkout's install flow).

Pick when to do that — the program's measurement, correctness and prose work
is done.
