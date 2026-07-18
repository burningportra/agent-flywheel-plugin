/*
 * agent-flywheel hooks — opencode port of the Claude Code plugin hooks.
 *
 * CHECKED-IN TEMPLATE. The T3 renderer (scripts/opencode/sync.mjs) substitutes
 * `JSON.stringify(repoRoot)` for the FLYWHEEL_ROOT sentinel below, so this file
 * carries no machine-specific literals and re-renders correctly on any host.
 *
 * Covers the five hook points from hooks/hooks.json (see the manifest
 * hookCoverage table for the authoritative map):
 *   SessionStart                        -> event "session.created"  (banner, resume warning, CLI dep check)
 *   PreToolUse(Bash)                    -> "tool.execute.before"    (Agent Mail activity-lock guard)
 *   Stop / SubagentStop                 -> event "session.idle"     (release Agent Mail file reservations)
 *   PostToolUse(flywheel_approve_beads) -> "tool.execute.after"     (progress reminder)
 */

import { existsSync, readFileSync } from "node:fs"
import { join, delimiter } from "node:path"
import { spawnSync } from "node:child_process"

// Typed sentinel — the T3 renderer substitutes JSON.stringify(repoRoot) for the
// comment-plus-empty-string initializer on the next line. It is the ONLY place
// that marker appears, so a plain string replace is unambiguous. With the
// sentinel in place this parses as the empty string, so `node --check` passes
// on the un-rendered template.
const FLYWHEEL_ROOT = /*__FLYWHEEL_REPO_ROOT__*/""

function flywheelVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(FLYWHEEL_ROOT, "mcp-server", "package.json"), "utf8"),
    )
    return pkg.version ?? "?"
  } catch {
    return "?"
  }
}

function missingFlywheelClis() {
  if (process.env.FLYWHEEL_SKIP_DEP_CHECK === "1") return []
  const required = ["br", "bv", "ntm", "cm"]
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean)
  const onPath = (bin) => pathDirs.some((dir) => existsSync(join(dir, bin)))
  return required.filter((b) => !onPath(b))
}

function resumableSession(directory) {
  const checkpoint = join(directory, ".pi-flywheel", "checkpoint.json")
  if (!existsSync(checkpoint)) return null
  try {
    const data = JSON.parse(readFileSync(checkpoint, "utf8"))
    const s = data.state
    if (s && s.phase && s.phase !== "idle" && s.phase !== "complete") {
      return { phase: s.phase, goal: s.selectedGoal || null }
    }
  } catch {}
  return null
}

const MUTATING_DOCTOR =
  /\bam\s+doctor\s+(repair|archive-normalize|reconstruct|restore|fix|fix-orphan-refs|pack-archive)\b/i
const DELETE_ACTIVITY_LOCK =
  /\b(rm|unlink)\b[^\n;&|]*(\.mailbox\.activity\.lock|storage\.sqlite3\.activity\.lock)/i

// The launchctl emergency sequence is macOS-specific. Guard it behind
// process.platform so Linux hosts get an accurate, non-misleading message.
function buildGuardMessage() {
  const lines = [
    "BLOCKED by agent-flywheel Agent Mail guard.",
    "",
    "Agent Mail intentionally holds `.mailbox.activity.lock` while `am serve-http` is running.",
    "Run the service-aware repair instead of racing the daemon:",
    '  flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })',
    "",
  ]
  if (process.platform === "darwin") {
    lines.push(
      "Manual emergency sequence (macOS):",
      "  launchctl bootout gui/$(id -u)/com.agent-mail",
      "  am doctor repair --yes",
      "  am doctor archive-normalize --yes",
      "  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-mail.plist",
      "",
    )
  } else {
    lines.push(
      "Manual emergency sequence: stop the owning Agent Mail service/unit, then:",
      "  am doctor repair --yes",
      "  am doctor archive-normalize --yes",
      "",
    )
  }
  lines.push(
    "Do not delete the lock files; release the owning service/process instead.",
    "If a human intentionally wants to bypass this hook, prefix the command with FLYWHEEL_ALLOW_AM_DOCTOR=1.",
  )
  return lines.join("\n")
}

const GUARD_MESSAGE = buildGuardMessage()

function releaseReservationsIfIdentified(directory) {
  const agent = process.env.AGENT_MAIL_AGENT || process.env.AGENT_NAME
  const project = process.env.AGENT_MAIL_PROJECT || directory
  if (!agent || !project) return false
  const res = spawnSync("am", ["file_reservations", "release", project, agent], {
    timeout: 10_000,
    stdio: "ignore",
  })
  return res.status === 0
}

export const AgentFlywheelPlugin = async ({ project, client, $, directory, worktree }) => {
  const log = (level, message, extra = {}) =>
    client.app
      .log({ body: { service: "agent-flywheel", level, message, extra } })
      .catch(() => {})

  const toast = async (message, variant = "info", title = "agent-flywheel") => {
    try {
      await client.tui.showToast({ body: { title, message, variant } })
    } catch {}
  }

  await log("info", `agent-flywheel v${flywheelVersion()} plugin loaded`)

  // Feature-detect the toast API once at load. The try/catch in toast() keeps
  // a missing API from crashing, but that alone hides drift — surface it.
  if (typeof client?.tui?.showToast !== "function") {
    await log(
      "warn",
      "client.tui.showToast is unavailable — toast notifications are disabled (OpenCode API drift or unsupported version)",
    )
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const version = flywheelVersion()
        await log("info", `AGENT-FLYWHEEL v${version} session start`)

        const resume = resumableSession(directory)
        if (resume) {
          const goal = resume.goal ? ` goal="${resume.goal}"` : ""
          await toast(
            `Previous flywheel session detected: phase=${resume.phase}${goal}. Run /start to resume or /flywheel-stop to reset.`,
            "warning",
          )
        }

        const missing = missingFlywheelClis()
        if (missing.length > 0) {
          await toast(
            `Missing flywheel CLIs: ${missing.join(", ")}. Run /flywheel-doctor to auto-install.`,
            "warning",
          )
        }
      }

      if (event.type === "session.idle") {
        if (releaseReservationsIfIdentified(directory)) {
          await log("info", "released Agent Mail file reservations on session idle")
        }
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = String(output.args?.command || "")
      if (!command) return

      if (
        /\bFLYWHEEL_ALLOW_AM_DOCTOR=1\b/.test(command) ||
        process.env.FLYWHEEL_ALLOW_AM_DOCTOR === "1"
      ) {
        return
      }

      if (MUTATING_DOCTOR.test(command) || DELETE_ACTIVITY_LOCK.test(command)) {
        await log("warn", "blocked unsafe Agent Mail command", { command })
        throw new Error(GUARD_MESSAGE)
      }
    },

    "tool.execute.after": async (input) => {
      if (input.tool.endsWith("flywheel_approve_beads")) {
        await toast(
          "Bead approval processed. Run /flywheel-status to check progress.",
          "info",
        )
      }
    },
  }
}
