"""Oracle for the start screen on the ntm fixture: does each benchmark run show what the state requires?

usage: check-menu.py <bench-label> [<bench-label> ...]

The fixture's state is fixed by fixtures/ntm-checkpoint.json and its beads: an active session
('Add Muse Code' @ discovering) on main @ a4c1265, 7 open, 2 in progress, 7 blocked and 2,982
closed beads, a yellow doctor with a pre-flight banner, no docs/plans/*.md, and a cc:pi 2:4 mix.
"""
import json
import os
import re
import sys

# Runs land in $BENCH_OUT/bench/<label>/, defaulting to the working directory.
HERE = os.environ.get("BENCH_OUT", os.getcwd())
CHECKS = [
    ("version", r"AGENT-FLYWHEEL v3\.\d+\.\d+"),
    ("project", r"Project:\s+ntm\b"),
    ("branch@sha", r"main @ a4c1265"),
    ("open", r"\b7 open\b"),
    ("in-progress", r"\b2 in[- ]progress\b"),
    ("blocked", r"\b7 blocked\b"),
    ("closed exact", r"\b2,?982\b"),
    ("doctor status", r"Doctor:\s+yellow"),
    ("doctor flagged", r"Doctor flagged"),
    ("pre-flight banner", r"Pre-flight issues"),
]
# The first decision is the pre-flight gate whenever the doctor sets a banner, as it does on this
# fixture. A screen that stops there owes the gate's options; one that goes on owes the menu.
GATE_CHECKS = [
    ("gate: run setup", r"Run setup now"),
    ("gate: continue degraded", r"Continue with degraded"),
    ("gate: show degraded", r"Show me what.s degraded"),
]
MENU_CHECKS = [
    ("menu: session variant", r"active session"),
    ("menu: resume option", r"Resume session"),
    ("menu: auto-swarm option", r"Auto-swarm"),
    ("menu: no plans", r"no docs/plans/\*\.md"),
    ("menu: swarm mix", r"cc:pi 2:4"),
]


def screen_text(path):
    parts = []
    for line in open(path):
        event = json.loads(line)["event"]
        if event.get("type") == "assistant":
            for block in event["message"].get("content", []):
                if block.get("type") == "text":
                    parts.append(block["text"])
                elif block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion":
                    parts.append(json.dumps(block.get("input")))
        elif event.get("type") == "control_request" and event.get("request", {}).get("tool_name") == "AskUserQuestion":
            parts.append(json.dumps(event["request"].get("input")))
    return "\n".join(parts)


for label in sys.argv[1:]:
    bench = os.path.join(HERE, "bench", label)
    if os.path.exists(os.path.join(bench, "summary.json")):
        valid = [r for r in json.load(open(os.path.join(bench, "summary.json")))["results"] if r["seconds"] is not None]
    else:
        valid = [{"run": int(name[4:-6]), "seconds": "?"} for name in sorted(os.listdir(bench)) if name.startswith("run-")]
    totals = {name: 0 for name, _ in CHECKS}
    print(f"== {label}: {len(valid)} valid runs")
    for row in valid:
        text = screen_text(os.path.join(HERE, "bench", label, f"run-{row['run']}.jsonl"))
        stops_at_gate = re.search(r"What would you like to do", text) is None
        checks = CHECKS + (GATE_CHECKS if stops_at_gate else GATE_CHECKS + MENU_CHECKS)
        missing = [name for name, pattern in checks if not re.search(pattern, text)]
        for name, pattern in checks:
            totals[name] = totals.get(name, 0) + bool(re.search(pattern, text))
        decision = "pre-flight gate" if stops_at_gate else "gate + main menu"
        print(f"  run {row['run']}: {row['seconds']} s, ends at {decision}, missing: {', '.join(missing) or 'none'}")
    print("  passes per check: " + ", ".join(f"{name} {count}/{len(valid)}" for name, count in totals.items()))
