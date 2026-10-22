# Swarm host — where the swarm's panes run

**When to use:** the user picked **Start implementing** in `_beads.md`, started `/agent-flywheel:flywheel-swarm`, or resumed an in-flight swarm. Run this gate before `flywheel_approve_beads(action: "start")` and before any spawn, because approve builds each prompt with the host's Agent Mail project and hands the wave to that host.

This session keeps coordinating either way: questions, plugin tools, reviews, and cycle state stay on this Mac. On another Mac, the panes and the builds and tests they run happen in a clone there, and the tools sync commits, beads, and completion reports at each wave boundary.

## The gate

1. Call `flywheel_swarm_host({ cwd, action: "list" })`. When `data.question` is null, no other Mac can take the swarm, so it runs here: leave `RUN` empty and continue. Mention each `data.hosts[].blockers` entry in one line so the user knows what kept a Mac out.
2. Pass `data.question` to `AskUserQuestion` unchanged. When the operator pre-authorized an unattended run, take the option marked "(Recommended)" without asking.
3. Call `flywheel_swarm_host({ cwd, action: "choose", pick: "<answer>", coordinatorName: "<current Agent Mail name>" })`.
   - `data.host` null: the swarm runs here and `RUN` stays empty.
   - Otherwise set `RUN = data.run`, `NTM_PROJECT = data.host.ntmProject`, `HOST_REPO = data.host.repoPath`, and `SWARM_FLAGS = data.swarm.spawnFlags`, and print `data.warnings` as they are. The lanes in `data.swarm` are the ones that work on that Mac, so use them instead of the doctor's `swarm.spawnFlags`.
   - On an error, show its message and hint, then ask **Run here instead (Recommended)** or **Retry** under header **Swarm host**. **Run here instead** calls `choose` with `pick: "This Mac"`.
4. Prepare the clone once per host: run the repo's install and build through `$RUN` (for this plugin, `$RUN --cd mcp-server npm ci` then `$RUN --cd mcp-server npm run build`), then its test command once, so a broken worker shows up before the panes start.

## While the swarm runs on another Mac

- Prefix every `ntm`, `tmux`, `br`, `am`, `git`, and `df` command aimed at the panes or the worker clone with `$RUN`, for example `$RUN ntm --robot-send="$IMPL_SESSION" --panes=2 --msg="…"` and `$RUN br ready --json`. `swarm-spawn.js` and `tender-daemon.js` read the host record and reach that Mac by themselves, so run them without the prefix.
- Read pane mail with `$RUN am mail inbox --project "$HOST_REPO" --agent "<current Agent Mail name>" --json`. The panes write to that Mac's Agent Mail, which `fetch_inbox` here can't see.
- `flywheel_advance_wave` pulls the wave's commits, bead closes, and completion reports into this checkout before it verifies, and pushes the next wave after. `flywheel_approve_beads(action: "start")` pushes the first wave. When either returns `data.swarmHost.synced: false`, show `data.swarmHost.detail` and call `flywheel_swarm_host({ cwd, action: "sync" })` before sending the prompts.
- Reviews, `flywheel_review`, and anything else that reads this checkout's git log or beads between wave boundaries need a `sync` first.
- A `blocked_state` error from `advance_wave` or `sync` names the problem in `details.reason`: `merge_conflict` (merge the ref the hint names by hand), `worker_dirty` or `worker_refused` (a pane left edits uncommitted on that Mac; have it commit them), `push_rejected`, or `branch_changed`. Fix it, call `sync`, then retry.

## In-flight swarms on another Mac

These adjust `_inflight_prompt.md`'s operator spec:

- Items 2 and 3 use `SWARM_FLAGS` from step 3 above. `flywheel_pi_models` with the implementer role already checks the models against that Mac's Pi logins.
- Item 6: copy the wrapper into the clone with `$RUN sh -c 'mkdir -p .pi-flywheel && cat > .pi-flywheel/build-mutex.sh && chmod +x .pi-flywheel/build-mutex.sh' < "$PLUGIN_ROOT/scripts/build-mutex.sh"` (with `PLUGIN_ROOT` from `data.pluginRoot`), and point each pane prompt at `.pi-flywheel/build-mutex.sh`. Item 8's `rch` runs where the pane runs; when `$RUN which rch` fails, use the repo's own build and test commands inside the wrapper.
- Items 7, 10, and 11 run their `df`, `br`, and `ntm` commands through `$RUN`.
- Item 13 calls `flywheel_swarm_host({ cwd, action: "sync" })` before the review.

`_wrapup.md` releases the host at the end of the cycle.
