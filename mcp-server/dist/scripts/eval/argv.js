export const HELP_TEXT = `Usage: tsx scripts/eval/run-eval.ts [options]

Flags:
  --only <id,id,...>     Run only the named scenarios (comma-separated).
  --sha <sha>            Pin worktree checkouts to this named commit.
                         Defaults to HEAD of the main checkout.
  --list                 Print scenarios and exit 0.
  --dry-run              Show which scenarios would run and exit 0.
  --write-baseline       Overwrite docs/perf/eval-start-baseline.json with
                         the result. Default: do not write. Must be a full
                         four-scenario run — refused when combined with --only.
  --no-write-baseline    Accepted no-op (preserved for backwards compat).
  --append-baseline      Merge the result's scenario rows into the existing
                         baseline file in place: scenarios present in the run
                         replace their matching row, every other row is left
                         untouched. Can be combined with --only to update a
                         subset. Refused when combined with --write-baseline.
  --keep-worktrees       Leave /tmp/claude-501/fw-eval/<id>-* checkouts in
                         place after each scenario for inspection.
  --help, -h             Print this help and exit 0.

Env knobs:
  FW_EVAL_MODEL          Model id (default claude-sonnet-5-5).
  FW_EVAL_TIMEOUT_MS     Per-scenario hard timeout (default 600000).
  FW_EVAL_MAX_BUDGET_USD Per-scenario Agent SDK budget (default 1.0).
  FW_EVAL_SCRATCH        Scratch root for worktrees
                         (default /tmp/claude-501/fw-eval).

Baseline writes are an opt-in to protect the committed comparison point.
A default run leaves docs/perf/eval-start-baseline.json untouched.
`;
const KNOWN_FLAGS = new Set([
    "--only",
    "--sha",
    "--list",
    "--dry-run",
    "--write-baseline",
    "--no-write-baseline",
    "--append-baseline",
    "--keep-worktrees",
    "--help",
    "-h",
]);
export function parseArgv(argv) {
    const onlyIds = new Set();
    let sha;
    let listOnly = false;
    let dryRun = false;
    let writeBaseline = false; // M4: opt-in
    let appendBaseline = false;
    let keepWorktrees = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (!KNOWN_FLAGS.has(a)) {
            return {
                kind: "error",
                exitCode: 2,
                message: `Unknown flag: ${a}\n\n${HELP_TEXT}`,
            };
        }
        if (a === "--help" || a === "-h") {
            return { kind: "help", text: HELP_TEXT };
        }
        if (a === "--only") {
            const next = argv[i + 1];
            if (!next || next.startsWith("-")) {
                return {
                    kind: "error",
                    exitCode: 2,
                    message: `--only requires a comma-separated list of scenario ids.\n\n${HELP_TEXT}`,
                };
            }
            for (const id of next.split(","))
                if (id)
                    onlyIds.add(id.trim());
            i += 1;
            continue;
        }
        if (a === "--sha") {
            const next = argv[i + 1];
            if (!next || next.startsWith("-")) {
                return {
                    kind: "error",
                    exitCode: 2,
                    message: `--sha requires a commit sha.\n\n${HELP_TEXT}`,
                };
            }
            sha = next;
            i += 1;
            continue;
        }
        if (a === "--list")
            listOnly = true;
        else if (a === "--dry-run")
            dryRun = true;
        else if (a === "--write-baseline")
            writeBaseline = true;
        else if (a === "--append-baseline")
            appendBaseline = true;
        else if (a === "--no-write-baseline") {
            // M4: accepted no-op (default is already no-write).
        }
        else if (a === "--keep-worktrees")
            keepWorktrees = true;
    }
    if (writeBaseline && onlyIds.size > 0) {
        return {
            kind: "error",
            exitCode: 2,
            message: "--write-baseline cannot be combined with --only: a partial run must never replace the full baseline.",
        };
    }
    if (writeBaseline && appendBaseline) {
        return {
            kind: "error",
            exitCode: 2,
            message: "--write-baseline and --append-baseline are mutually exclusive: pick one.",
        };
    }
    return {
        kind: "run",
        onlyIds,
        sha,
        listOnly,
        dryRun,
        writeBaseline,
        appendBaseline,
        keepWorktrees,
    };
}
//# sourceMappingURL=argv.js.map