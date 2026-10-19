"""Headless /agent-flywheel:start benchmark: seconds from launch to the first menu, arms interleaved.

usage: bench-start.py <fixture-dir> <checkpoint-snapshot> <rounds> <label>=<plugin-dir> [<label>=<plugin-dir> ...]

Each round runs every arm once, reversing the order every other round, so a drift in machine load
lands on both arms. Every arm loads its plugin with --plugin-dir and the installed copy disabled.
Every run starts from the same checkpoint snapshot. Tools that act on a menu answer are
disallowed, a run that reaches one anyway (or loads a phase skill) is recorded as invalid, and the
benchmark aborts when a run leaves files in the fixture beyond `.pi-flywheel/`.
"""
import json
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time

fixture, snapshot, rounds = sys.argv[1], sys.argv[2], int(sys.argv[3])
arms = [arg.split("=", 1) for arg in sys.argv[4:]]
# Runs land in $BENCH_OUT/bench/<label>/, defaulting to the working directory.
HERE = os.environ.get("BENCH_OUT", os.getcwd())
PREFIX = "mcp__plugin_agent-flywheel_agent-flywheel__"
POST_MENU = ["flywheel_select", "flywheel_plan", "flywheel_discover", "flywheel_approve_beads",
             "orch_select", "orch_plan", "orch_discover", "orch_approve_beads",
             "Write", "Edit", "NotebookEdit", "Agent", "Skill"]
DISALLOWED = [PREFIX + t if t.startswith(("flywheel_", "orch_")) else t for t in POST_MENU] + [
    "mcp__mcp-agent-mail", "mcp__agent-mail", "mcp__plugin_agent-flywheel_agent-mail", "mcp__keenable"]
CLEAN_STATUS = "?? .pi-flywheel/\n"
# AskUserQuestion is disabled in every headless session, so both arms get the same stand-in for
# the picker an interactive session blocks on.
HEADLESS_NOTE = ("This is a headless benchmark of the opening screen. AskUserQuestion is unavailable here. "
                 "Where a skill says to call it, print the question and its options as text and end your turn. "
                 "Never act on a menu choice yourself.")
SETTINGS = json.dumps({"enabledPlugins": {"agent-flywheel@agent-flywheel": False}})


def fixture_status():
    return subprocess.run(["git", "status", "--porcelain"], cwd=fixture, capture_output=True, text=True, timeout=30).stdout


def run_once(plugin_dir):
    shutil.copyfile(snapshot, os.path.join(fixture, ".pi-flywheel", "checkpoint.json"))
    cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
           "--permission-mode", "auto", "--permission-prompts", "host",
           "--plugin-dir", plugin_dir, "--settings", SETTINGS,
           "--append-system-prompt", HEADLESS_NOTE, "--disallowedTools", *DISALLOWED]
    start = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=fixture, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            stdin=subprocess.PIPE, text=True)
    watchdog = threading.Timer(300, proc.kill)
    watchdog.daemon = True
    watchdog.start()
    proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": "/agent-flywheel:start"}}) + "\n")
    proc.stdin.flush()
    events, tools, message_ids, first_q, header, invalid = [], [], set(), None, None, None
    for line in proc.stdout:
        now = time.monotonic() - start
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        events.append({"t": round(now, 2), "event": event})
        if event.get("type") == "control_request":
            request = event.get("request", {})
            if request.get("subtype") == "can_use_tool":
                proc.stdin.write(json.dumps({"type": "control_response", "response": {
                    "subtype": "success", "request_id": event.get("request_id"),
                    "response": {"behavior": "allow", "updatedInput": request.get("input")}}}) + "\n")
                proc.stdin.flush()
        if event.get("type") == "assistant":
            message = event.get("message", {})
            message_ids.add(message.get("id"))
            for block in message.get("content", []):
                if block.get("type") == "tool_use":
                    name = block.get("name", "").replace(PREFIX, "")
                    tools.append((round(now, 1), name))
                    if name in POST_MENU:
                        invalid = f"called {name} before a menu"
                    elif name == "flywheel_get_skill" and block.get("input", {}).get("name") != "agent-flywheel:start":
                        invalid = f"loaded {block.get('input', {}).get('name')} before a menu"
        if event.get("type") == "result":
            first_q, header = now, "(menu as text)"
        if first_q is not None or invalid:
            break
    watchdog.cancel()
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    if first_q is None and not invalid:
        invalid = "no menu within 300 s"
    row = {"seconds": None if invalid else round(first_q, 1), "header": header, "invalid": invalid,
           "turns": len(message_ids), "tools": tools}
    return row, events


if fixture_status() != CLEAN_STATUS:
    sys.exit(f"fixture is not clean: {fixture_status()!r}")

results = {label: [] for label, _ in arms}
for round_index in range(rounds):
    order = arms if round_index % 2 == 0 else arms[::-1]
    for label, plugin_dir in order:
        out_dir = os.path.join(HERE, "bench", label)
        os.makedirs(out_dir, exist_ok=True)
        row, events = run_once(plugin_dir)
        row["run"] = round_index
        results[label].append(row)
        with open(os.path.join(out_dir, f"run-{round_index}.jsonl"), "w") as fh:
            for e in events:
                fh.write(json.dumps(e) + "\n")
        print(json.dumps({"arm": label, **{k: row[k] for k in ("run", "seconds", "invalid", "turns")}}), flush=True)
        if fixture_status() != CLEAN_STATUS:
            sys.exit(json.dumps({"abort": "run left files in the fixture", "status": fixture_status()}))

for label, rows in results.items():
    secs = [r["seconds"] for r in rows if r["seconds"] is not None]
    summary = {"label": label, "runs": len(rows), "measured": len(secs),
               "p50": statistics.median(secs) if secs else None,
               "min": min(secs, default=None), "max": max(secs, default=None), "results": rows}
    with open(os.path.join(HERE, "bench", label, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)
    print(json.dumps({k: summary[k] for k in ("label", "measured", "p50", "min", "max")}))
