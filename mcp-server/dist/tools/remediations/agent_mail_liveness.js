/**
 * agent_mail_liveness remediation — diagnose + instruct.
 *
 * Spawning a long-lived `am serve-http` daemon from inside an MCP tool is
 * fragile: the child outlives the request, stdio handoff is awkward, and
 * supervision is the user's. This handler stays non-mutating and prints the
 * one-liner the user must run themselves. verifyProbe re-runs the curl
 * liveness probe so the caller still gets `verifiedGreen` truthfully.
 */
import { createLogger } from '../../logger.js';
const log = createLogger('remediation.agent_mail_liveness');
const CURL_TIMEOUT_MS = 30_000;
const START_HINT = 'Run `nohup am serve-http > /dev/null 2>&1 &` from your shell, then re-run flywheel_doctor.';
export const agentMailLivenessHandler = {
    description: 'Diagnose Agent Mail liveness and emit a manual start command.',
    mutating: false,
    reversible: true,
    async buildPlan(_ctx) {
        return {
            description: 'Agent Mail must be started outside the MCP server. Manual step: ' + START_HINT,
            steps: [START_HINT],
            mutating: false,
            reversible: true,
        };
    },
    async execute(_ctx) {
        return {
            stepsRun: 0,
            stdout: START_HINT,
            stderr: '',
        };
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
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    },
};
//# sourceMappingURL=agent_mail_liveness.js.map