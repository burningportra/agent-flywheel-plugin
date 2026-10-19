"""Split each benchmark run into model time and tool waits on the critical path.

usage: split-time.py <bench-label> [<bench-label> ...]

A turn starts when the model gets its input (launch, or the last tool result it waited for) and
ends at its last assistant event. Tool wait is the gap from that end to the last result of the
tools the turn called. The final turn, which writes the screen, is reported on its own.
"""
import json
import os
import statistics
import sys

# Runs land in $BENCH_OUT/bench/<label>/, defaulting to the working directory.
HERE = os.environ.get("BENCH_OUT", os.getcwd())
PREFIX = "mcp__plugin_agent-flywheel_agent-flywheel__"


def split(path):
    msgs, results, uses = {}, {}, {}
    order = []
    for line in open(path):
        rec = json.loads(line)
        t, ev = rec["t"], rec["event"]
        if ev.get("type") == "assistant":
            mid = ev["message"].get("id")
            if mid not in msgs:
                msgs[mid] = {"first": t, "last": t, "tools": []}
                order.append(mid)
            msgs[mid]["last"] = t
            for block in ev["message"].get("content", []):
                if block.get("type") == "tool_use":
                    msgs[mid]["tools"].append(block["id"])
                    uses[block["id"]] = block.get("name", "").replace(PREFIX, "")
        elif ev.get("type") == "user":
            content = ev.get("message", {}).get("content")
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "tool_result":
                        results[block.get("tool_use_id")] = t
    model = tool = 0.0
    start = 0.0
    slow = []
    for mid in order:
        m = msgs[mid]
        model += m["last"] - start
        if m["tools"]:
            done = max(results.get(i, m["last"]) for i in m["tools"])
            wait = max(0.0, done - m["last"])
            tool += wait
            slow.append((round(wait, 1), "+".join(uses[i] for i in m["tools"])))
            start = done
        else:
            start = m["last"]
    final = msgs[order[-1]]["last"] - msgs[order[-1]]["first"] if order else 0
    return {"turns": len(order), "model": round(model, 1), "tool_wait": round(tool, 1),
            "final_turn_stream": round(final, 1), "waits": slow}


for label in sys.argv[1:]:
    bench = os.path.join(HERE, "bench", label)
    rows = []
    for name in sorted(os.listdir(bench)):
        if name.startswith("run-"):
            row = split(os.path.join(bench, name))
            rows.append(row)
            print(label, name, {k: row[k] for k in ("turns", "model", "tool_wait", "final_turn_stream")})
            print("    waits:", row["waits"])
    if rows:
        print(label, "median model", statistics.median(r["model"] for r in rows),
              "median tool wait", statistics.median(r["tool_wait"] for r in rows),
              "median turns", statistics.median(r["turns"] for r in rows))
