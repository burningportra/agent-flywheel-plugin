#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def read_text_file(path: Path, label: str) -> str:
    if not path.exists():
        raise RuntimeError(f"{label} not found: {path}")
    if not path.is_file():
        raise RuntimeError(f"{label} is not a file: {path}")
    try:
        return path.read_text()
    except OSError as exc:
        raise RuntimeError(f"could not read {label}: {path}") from exc


def load_json_file(path: Path, label: str) -> object:
    raw = read_text_file(path, label)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{label} is not valid JSON: {path}") from exc


def try_run(cmd: list[str], cwd: Path) -> str | None:
    try:
        result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def normalize_labels(labels: object) -> list[str]:
    if isinstance(labels, list):
        out: list[str] = []
        for item in labels:
            if isinstance(item, dict):
                name = item.get("name")
                if name:
                    out.append(str(name))
            elif isinstance(item, str):
                out.append(item)
        return out
    return []


def require_list(value: object, label: str) -> list[object]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise RuntimeError(f"{label} has unexpected shape")
    return value


def warn(msg: str) -> None:
    print(f"WARNING: {msg}", file=sys.stderr)


def best_beads_timestamp(obj: dict[str, object]) -> str:
    for key in ("closed_at", "updated_at", "created_at"):
        value = obj.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def beads_rows(repo: Path) -> list[dict[str, object]]:
    path = repo / ".beads" / "issues.jsonl"
    if not path.exists():
        return []
    rows_by_id: dict[str, tuple[dict[str, object], tuple[str, int]]] = {}
    malformed_lines = 0
    conflict_marker_lines = 0
    anonymous_rows: list[dict[str, object]] = []
    for line_number, line in enumerate(read_text_file(path, "beads issues JSONL").splitlines(), start=1):
        if not line.strip():
            continue
        if line.startswith(("<<<<<<<", "=======", ">>>>>>>")):
            conflict_marker_lines += 1
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            malformed_lines += 1
            continue

        row = {
            "id": obj.get("id") or "",
            "title": obj.get("title") or "",
            "status": obj.get("status") or "",
            "closed_at": obj.get("closed_at") or obj.get("updated_at") or "",
            "kind": obj.get("issue_type") or "",
            "url": "",
            "labels": obj.get("labels") or [],
            "source": "beads",
        }
        issue_id = str(row["id"])
        if not issue_id:
            anonymous_rows.append(row)
            continue

        candidate_key = (best_beads_timestamp(obj), line_number)
        existing = rows_by_id.get(issue_id)
        if existing is None or candidate_key >= existing[1]:
            rows_by_id[issue_id] = (row, candidate_key)

    if conflict_marker_lines:
        warn(
            f"skipped {conflict_marker_lines} merge-conflict marker lines while parsing {path}"
        )
    if malformed_lines:
        warn(f"skipped {malformed_lines} malformed JSONL lines while parsing {path}")

    rows = [row for row, _ in rows_by_id.values()]
    rows.sort(
        key=lambda row: (
            str(row.get("closed_at") or ""),
            str(row.get("id") or ""),
        ),
        reverse=True,
    )
    return rows + anonymous_rows


def github_rows(repo: Path, state: str, limit: int) -> list[dict[str, object]]:
    out = try_run(
        [
            "gh",
            "issue",
            "list",
            "--state",
            "all" if state == "all" else state,
            "--limit",
            str(limit),
            "--json",
            "number,title,state,closedAt,labels,url",
        ],
        repo,
    )
    if not out:
        return []
    try:
        raw = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError("github issue list is not valid JSON") from exc
    raw = require_list(raw, "github issue list")
    rows: list[dict[str, object]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise RuntimeError("github issue list contains non-object rows")
        rows.append(
            {
                "id": f"#{item.get('number')}",
                "title": item.get("title") or "",
                "status": item.get("state") or "",
                "closed_at": item.get("closedAt") or "",
                "kind": "issue",
                "url": item.get("url") or "",
                "labels": normalize_labels(item.get("labels")),
                "source": "github",
            }
        )
    return rows


def linear_rows(path: Path) -> list[dict[str, object]]:
    raw = load_json_file(path, "linear export")
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        items = raw.get("issues") or raw.get("nodes") or []
    else:
        raise RuntimeError(f"linear export has unexpected shape: {path}")
    items = require_list(items, f"linear export {path}")
    rows: list[dict[str, object]] = []
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError(f"linear export contains non-object issue rows: {path}")
        state = item.get("state")
        labels = item.get("labels")
        if isinstance(labels, dict):
            labels = labels.get("nodes")
        rows.append(
            {
                "id": item.get("identifier") or item.get("id") or "",
                "title": item.get("title") or item.get("name") or "",
                "status": state.get("name") if isinstance(state, dict) else state or "",
                "closed_at": item.get("completedAt") or item.get("canceledAt") or item.get("updatedAt") or "",
                "kind": "linear",
                "url": item.get("url") or "",
                "labels": normalize_labels(labels),
                "source": "linear",
            }
        )
    return rows


def jira_rows(path: Path) -> list[dict[str, object]]:
    raw = load_json_file(path, "jira export")
    if isinstance(raw, dict):
        items = raw.get("issues")
    elif isinstance(raw, list):
        items = raw
    else:
        raise RuntimeError(f"jira export has unexpected shape: {path}")
    items = require_list(items, f"jira export {path}")
    rows: list[dict[str, object]] = []
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError(f"jira export contains non-object issue rows: {path}")
        fields = item.get("fields", {}) if isinstance(item, dict) else {}
        status = fields.get("status", {})
        rows.append(
            {
                "id": item.get("key") or item.get("id") or "",
                "title": fields.get("summary") or item.get("title") or "",
                "status": status.get("name") if isinstance(status, dict) else status or "",
                "closed_at": fields.get("resolutiondate") or fields.get("updated") or "",
                "kind": "jira",
                "url": item.get("self") or "",
                "labels": normalize_labels(fields.get("labels")),
                "source": "jira",
            }
        )
    return rows


def milestone_rows(path: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    current = "unsectioned"
    for idx, line in enumerate(read_text_file(path, "milestone markdown").splitlines(), start=1):
        if line.startswith("## "):
            current = line[3:].strip()
            continue
        bullet = re.match(r"^\s*[-*]\s+(?:\[(x|X| )\]\s+)?(.+)$", line)
        if not bullet:
            continue
        done = bullet.group(1)
        title = bullet.group(2).strip()
        rows.append(
            {
                "id": f"{path.stem}:{idx}",
                "title": title,
                "status": "closed" if done and done.lower() == "x" else "open",
                "closed_at": "",
                "kind": current,
                "url": "",
                "labels": [],
                "source": "milestones",
            }
        )
    return rows


def auto_kind(repo: Path, input_path: Path | None) -> str:
    if input_path:
        if input_path.suffix.lower() == ".md":
            return "milestones"
        if input_path.suffix.lower() == ".json":
            try:
                text = read_text_file(input_path, "tracker export")
            except RuntimeError:
                return "unknown"
            if '"identifier"' in text or '"completedAt"' in text:
                return "linear"
            if '"fields"' in text and '"resolutiondate"' in text:
                return "jira"
    if (repo / ".beads" / "issues.jsonl").exists():
        return "beads"
    if try_run(["gh", "repo", "view", "--json", "nameWithOwner"], repo):
        return "github"
    return "unknown"


def filter_rows(rows: list[dict[str, object]], state: str) -> list[dict[str, object]]:
    if state == "all":
        return rows
    want = state.lower()
    out = []
    for row in rows:
        status = str(row.get("status") or "").lower()
        if want == "closed" and status in {"closed", "done", "completed"}:
            out.append(row)
        elif want == "open" and status not in {"closed", "done", "completed"}:
            out.append(row)
    return out


def markdown(rows: list[dict[str, object]]) -> str:
    lines = ["## Workstreams", ""]
    for row in rows:
        label = f"[`{row['id']}`]({row['url']})" if row.get("url") else f"`{row['id']}`"
        suffix = f" — {row['closed_at']}" if row.get("closed_at") else ""
        lines.append(f"- {label} {row['title']} [{row['source']}] {suffix}".rstrip())
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".")
    parser.add_argument("--input", help="path to tracker export file")
    parser.add_argument("--kind", default="auto", choices=["auto", "beads", "github", "linear", "jira", "milestones"])
    parser.add_argument("--state", default="closed", choices=["closed", "open", "all"])
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--format", default="json", choices=["json", "markdown"])
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not repo.exists():
        print(f"ERROR: repository path not found: {repo}", file=sys.stderr)
        return 1
    if not repo.is_dir():
        print(f"ERROR: repository path is not a directory: {repo}", file=sys.stderr)
        return 1

    input_path = Path(args.input).resolve() if args.input else None
    if input_path:
        if not input_path.exists():
            print(f"ERROR: input path not found: {input_path}", file=sys.stderr)
            return 1
        if not input_path.is_file():
            print(f"ERROR: input path is not a file: {input_path}", file=sys.stderr)
            return 1
    kind = args.kind if args.kind != "auto" else auto_kind(repo, input_path)

    try:
        if kind == "beads":
            rows = beads_rows(repo)
        elif kind == "github":
            rows = github_rows(repo, args.state, args.limit)
        elif kind == "linear":
            if not input_path:
                raise RuntimeError("--input is required for linear exports")
            rows = linear_rows(input_path)
        elif kind == "jira":
            if not input_path:
                raise RuntimeError("--input is required for jira exports")
            rows = jira_rows(input_path)
        elif kind == "milestones":
            if not input_path:
                raise RuntimeError("--input is required for milestone markdown")
            rows = milestone_rows(input_path)
        else:
            raise RuntimeError("could not determine tracker kind; pass --kind explicitly")
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    rows = filter_rows(rows, args.state)
    rows = rows[: args.limit]

    if args.format == "markdown":
        print(markdown(rows), end="")
    else:
        print(json.dumps(rows, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
