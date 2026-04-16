# SwarmTender configuration

`SwarmTender` (`mcp-server/src/tender.ts`) is the polling supervisor that watches
agent worktrees, classifies their health (`active` / `idle` / `stuck`), nudges
stuck agents via Agent Mail, and eventually kills agents that never recover.

Its tunables live in the exported `TenderConfig` interface. Every field is a
number (milliseconds, unless noted) and has a concrete default in
`DEFAULT_TENDER_CONFIG`. To customise them at runtime, use the exported helper:

```ts
import { loadTenderConfig } from "./tender.js";

const config = loadTenderConfig(process.cwd());
```

`loadTenderConfig(cwd)` shallow-merges overrides in the following precedence
(later sources override earlier ones):

1. `DEFAULT_TENDER_CONFIG` (baked-in defaults).
2. `<cwd>/.pi-flywheel/tender.config.json` — a flat JSON object keyed by the
   field names below. Non-numeric values and unknown keys are logged at `warn`
   and ignored.
3. `FLYWHEEL_TENDER_<FIELD>` environment variables. The suffix is the field
   name uppercased with no separators (e.g. `pollInterval` →
   `FLYWHEEL_TENDER_POLLINTERVAL`, `maxNudgesPerPoll` →
   `FLYWHEEL_TENDER_MAXNUDGESPERPOLL`). Non-numeric or unknown env vars are
   logged at `warn` and ignored. **Env vars win over the JSON file.**

## Fields

| Field                   | Default             | Description |
|-------------------------|---------------------|-------------|
| `pollInterval`          | `60_000` (60 s)     | How often the tender polls each worktree's `git status`. |
| `stuckThreshold`        | `300_000` (5 min)   | An agent with no file changes for this long is classified `stuck`. |
| `idleThreshold`         | `120_000` (2 min)   | An agent with no file changes for this long (but under `stuckThreshold`) is classified `idle`. |
| `cadenceIntervalMs`     | `1_200_000` (20 min)| How often to fire the operator cadence checklist (`onCadenceCheck`). |
| `crossReviewIntervalMs` | `2_700_000` (45 min)| Maximum time between cross-agent reviews before `onCrossReviewDue` fires. |
| `commitCadenceMs`       | `5_400_000` (90 min)| Warn (`onCommitOverdue`) if no commits happen for this long. |
| `nudgeDelayMs`          | `0`                 | Delay after an agent first becomes `stuck` before the first nudge fires. |
| `maxNudges`             | `2`                 | Total nudges to deliver to a single stuck agent before killing it. |
| `killWaitMs`            | `120_000` (2 min)   | Grace period after the last nudge before the agent is killed. |
| `maxNudgesPerPoll`      | `3`                 | Upper bound on nudges sent across **all** agents within one poll cycle. Prevents a large swarm going silent simultaneously from exhausting Agent Mail quota. |

## Example: `.pi-flywheel/tender.config.json`

```json
{
  "pollInterval": 30000,
  "stuckThreshold": 180000,
  "maxNudgesPerPoll": 5
}
```

## Example: environment variables

```sh
export FLYWHEEL_TENDER_POLLINTERVAL=30000
export FLYWHEEL_TENDER_MAXNUDGESPERPOLL=5
```

Env vars override any matching entry in `tender.config.json`.

## Notes

- `nudgeDelayMs > killWaitMs` is a misconfiguration — the tender logs a warning
  at construction time because agents would never be killed after nudging.
- Changes only take effect when a new `SwarmTender` is constructed; hot-reload
  is not supported.
