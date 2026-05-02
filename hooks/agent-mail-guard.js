#!/usr/bin/env node
/*
 * Claude hook: guard Agent Mail's mailbox activity lock.
 *
 * The Rust `am serve-http` daemon holds `.mailbox.activity.lock` for the life
 * of the service. Mutating `am doctor` maintenance must stop the service first;
 * otherwise agents hit "Resource is temporarily busy" and often try unsafe
 * workarounds like deleting the lockfile. This hook blocks those foot-guns in
 * Bash tool calls and points agents at flywheel_remediate's service-aware fix.
 */

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function releaseReservationsIfIdentified() {
  const agent = process.env.AGENT_MAIL_AGENT || process.env.AGENT_NAME;
  const project = process.env.AGENT_MAIL_PROJECT || process.cwd();
  if (!agent || !project) return;
  spawnSync('am', ['file_reservations', 'release', project, agent], {
    timeout: 10_000,
    stdio: 'ignore',
  });
}

if (process.argv.includes('--release-reservations')) {
  releaseReservationsIfIdentified();
  process.exit(0);
}

function readPayload() {
  const raw = process.env.CLAUDE_TOOL_INPUT || (() => {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  })();
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function commandFromPayload(payload) {
  return String(
    payload.command ||
      payload.tool_input?.command ||
      payload.toolInput?.command ||
      payload.input?.command ||
      ''
  );
}

const command = commandFromPayload(readPayload());
if (!command) process.exit(0);

// Explicit break-glass for a human intentionally running the full safe sequence.
if (/\bFLYWHEEL_ALLOW_AM_DOCTOR=1\b/.test(command) || process.env.FLYWHEEL_ALLOW_AM_DOCTOR === '1') {
  process.exit(0);
}

const mutatingDoctor = /\bam\s+doctor\s+(repair|archive-normalize|reconstruct|restore|fix|fix-orphan-refs|pack-archive)\b/i;
const deleteActivityLock = /\b(rm|unlink)\b[^\n;&|]*(\.mailbox\.activity\.lock|storage\.sqlite3\.activity\.lock)/i;

if (mutatingDoctor.test(command) || deleteActivityLock.test(command)) {
  const reason = mutatingDoctor.test(command)
    ? 'mutating `am doctor` command'
    : 'attempt to delete an Agent Mail activity lock file';
  console.error([
    `BLOCKED by agent-flywheel Agent Mail guard: ${reason}.`,
    '',
    'Agent Mail intentionally holds `.mailbox.activity.lock` while `am serve-http` is running.',
    'Run the service-aware repair instead of racing the daemon:',
    '  flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })',
    '',
    'Manual emergency sequence:',
    '  launchctl bootout gui/$(id -u)/com.agent-mail',
    '  am doctor repair --yes',
    '  am doctor archive-normalize --yes',
    '  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-mail.plist',
    '',
    'Do not delete the lock files; release the owning service/process instead.',
    'If a human intentionally wants to bypass this hook, prefix the command with FLYWHEEL_ALLOW_AM_DOCTOR=1.',
  ].join('\n'));
  process.exit(2);
}

process.exit(0);
