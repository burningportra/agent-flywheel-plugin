import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";

const MUTATING_AM_DOCTOR = /\bam\s+doctor\s+(repair|archive-normalize|reconstruct|restore|fix|fix-orphan-refs|pack-archive)\b/i;
const DELETE_ACTIVITY_LOCK = /\b(rm|unlink)\b[^\n;&|]*(\.mailbox\.activity\.lock|storage\.sqlite3\.activity\.lock)/i;

const BLOCK_MESSAGE = [
  "Blocked by agent-flywheel Agent Mail guard.",
  "",
  "Agent Mail intentionally holds `.mailbox.activity.lock` while `am serve-http` is running.",
  "Do not run mutating `am doctor` commands or delete lock files from swarm panes.",
  "Ask the coordinator to run:",
  "  flywheel_remediate({ checkName: \"agent_mail_liveness\", mode: \"execute\", autoConfirm: true })",
  "",
  "Break-glass only: prefix the shell command with FLYWHEEL_ALLOW_AM_DOCTOR=1.",
].join("\n");

function releaseReservationsIfIdentified(cwd: string) {
  const agent = process.env.AGENT_MAIL_AGENT || process.env.AGENT_NAME;
  const project = process.env.AGENT_MAIL_PROJECT || cwd;
  if (!agent || !project) return;
  spawnSync("am", ["file_reservations", "release", project, agent], {
    timeout: 10_000,
    stdio: "ignore",
  });
}

export default function agentMailGuard(pi: ExtensionAPI) {
  pi.on("session_shutdown", async (_event, ctx) => {
    releaseReservationsIfIdentified(ctx.cwd ?? process.cwd());
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = String(event.input.command ?? "");
    if (!command) return;
    if (/\bFLYWHEEL_ALLOW_AM_DOCTOR=1\b/.test(command)) return;

    if (MUTATING_AM_DOCTOR.test(command) || DELETE_ACTIVITY_LOCK.test(command)) {
      return { block: true, reason: BLOCK_MESSAGE };
    }
  });
}
