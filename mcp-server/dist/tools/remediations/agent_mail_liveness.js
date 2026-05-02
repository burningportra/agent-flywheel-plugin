/**
 * agent_mail_liveness remediation — service-aware repair + restart.
 *
 * Agent Mail's Rust daemon intentionally holds `.mailbox.activity.lock` and
 * `storage.sqlite3.activity.lock` while it is serving. Mutating `am doctor`
 * maintenance (repair, archive-normalize, reconstruct, migrations) therefore
 * fails with "Resource is temporarily busy" unless the supervised service is
 * stopped first. This handler bakes the safe operator sequence into
 * `flywheel_remediate`: stop the service/runtime, run repair + archive hygiene,
 * restart the service, then verify `/health/liveness`.
 */
import { createLogger } from '../../logger.js';
import { errMsg } from '../../errors.js';
const log = createLogger('remediation.agent_mail_liveness');
const CURL_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 120_000;
const STOP_SERVICE_SCRIPT = String.raw `set -u
if command -v launchctl >/dev/null 2>&1 && [ -f "$HOME/Library/LaunchAgents/com.agent-mail.plist" ]; then
  launchctl bootout "gui/$(id -u)/com.agent-mail" >/dev/null 2>&1 || true
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop agent-mail.service >/dev/null 2>&1 || \
    systemctl --user stop com.agent-mail.service >/dev/null 2>&1 || true
else
  pkill -TERM -f 'am serve-http|mcp-agent-mail serve' >/dev/null 2>&1 || true
fi
sleep 2`;
const START_SERVICE_SCRIPT = String.raw `set -u
if command -v launchctl >/dev/null 2>&1 && [ -f "$HOME/Library/LaunchAgents/com.agent-mail.plist" ]; then
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.agent-mail.plist" >/dev/null 2>&1 || \
    launchctl kickstart -k "gui/$(id -u)/com.agent-mail" >/dev/null 2>&1 || \
    am service restart >/dev/null 2>&1 || true
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user start agent-mail.service >/dev/null 2>&1 || \
    systemctl --user start com.agent-mail.service >/dev/null 2>&1 || \
    am service restart >/dev/null 2>&1 || \
    nohup am serve-http > /dev/null 2>&1 &
else
  nohup am serve-http > /dev/null 2>&1 &
fi
sleep 3`;
function formatStep({ label, code, stdout, stderr }) {
    const out = stdout.trim();
    const err = stderr.trim();
    return [
        `$ ${label}`,
        `exit=${code}`,
        ...(out ? [`stdout:\n${out}`] : []),
        ...(err ? [`stderr:\n${err}`] : []),
    ].join('\n');
}
async function runRequiredStep(ctx, label, cmd, args) {
    const res = await ctx.exec(cmd, args, {
        cwd: ctx.cwd,
        timeout: STEP_TIMEOUT_MS,
        signal: ctx.signal,
    });
    const output = { label, code: res.code, stdout: res.stdout, stderr: res.stderr };
    if (res.code !== 0) {
        throw new Error(`Agent Mail remediation step failed: ${formatStep(output)}`);
    }
    return output;
}
async function runBestEffortStep(ctx, label, cmd, args) {
    const res = await ctx.exec(cmd, args, {
        cwd: ctx.cwd,
        timeout: STEP_TIMEOUT_MS,
        signal: ctx.signal,
    });
    return { label, code: res.code, stdout: res.stdout, stderr: res.stderr };
}
export const agentMailLivenessHandler = {
    description: 'Stop Agent Mail, run am doctor repair/archive-normalize, restart, and verify liveness.',
    mutating: true,
    reversible: true,
    async buildPlan(_ctx) {
        return {
            description: 'Service-aware Agent Mail fix: stop the supervised runtime to release mailbox activity locks, run `am doctor repair --yes`, run `am doctor archive-normalize --yes`, restart Agent Mail, then verify /health/liveness.',
            steps: [
                'Stop the Agent Mail service/runtime (launchd on macOS, systemd user service on Linux, or best-effort pkill fallback).',
                'Run `am doctor repair --yes` while the service is stopped so `.mailbox.activity.lock` is not held by the daemon.',
                'Run `am doctor archive-normalize --yes` to quarantine duplicate canonical archive files and repair safe metadata hygiene.',
                'Restart Agent Mail (`launchctl bootstrap`, `systemctl --user start`, `am service restart`, or `nohup am serve-http`).',
                'Verify `curl -s --max-time 2 http://127.0.0.1:8765/health/liveness` returns `{ "status": "alive" }`.',
            ],
            mutating: true,
            reversible: true,
        };
    },
    async execute(ctx) {
        const outputs = [];
        const summarize = () => ({
            stepsRun: outputs.length,
            stdout: outputs.map(formatStep).join('\n\n'),
            stderr: outputs
                .filter((step) => step.code !== 0)
                .map(formatStep)
                .join('\n\n'),
        });
        outputs.push(await runRequiredStep(ctx, 'command -v am', 'bash', [
            '-lc',
            'command -v am >/dev/null 2>&1',
        ]));
        outputs.push(await runBestEffortStep(ctx, 'stop Agent Mail service/runtime', 'bash', [
            '-lc',
            STOP_SERVICE_SCRIPT,
        ]));
        try {
            outputs.push(await runRequiredStep(ctx, 'am doctor repair --yes', 'am', ['doctor', 'repair', '--yes']));
            outputs.push(await runBestEffortStep(ctx, 'am doctor archive-normalize --yes', 'am', [
                'doctor',
                'archive-normalize',
                '--yes',
            ]));
        }
        finally {
            outputs.push(await runBestEffortStep(ctx, 'restart Agent Mail service/runtime', 'bash', [
                '-lc',
                START_SERVICE_SCRIPT,
            ]));
        }
        return summarize();
    },
    async verifyProbe(ctx) {
        try {
            const res = await ctx.exec('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:8765/health/liveness'], { cwd: ctx.cwd, timeout: CURL_TIMEOUT_MS, signal: ctx.signal });
            if (res.code !== 0) {
                log.warn('verifyProbe: curl exited non-zero', { exitCode: res.code });
                return false;
            }
            const trimmed = res.stdout.trim();
            const alive = trimmed.includes('"status":"alive"') || trimmed.includes('"status": "alive"');
            if (!alive)
                log.warn('verifyProbe: agent mail reachable but status not alive');
            return alive;
        }
        catch (err) {
            log.warn('verifyProbe: curl threw', {
                error: errMsg(err),
            });
            return false;
        }
    },
};
//# sourceMappingURL=agent_mail_liveness.js.map