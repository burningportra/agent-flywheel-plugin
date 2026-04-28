/**
 * agent_mail_liveness remediation — diagnose + instruct.
 *
 * Spawning a long-lived `am serve-http` daemon from inside an MCP tool is
 * fragile: the child outlives the request, stdio handoff is awkward, and
 * supervision is the user's. This handler stays non-mutating and prints the
 * one-liner the user must run themselves. verifyProbe re-runs the curl
 * liveness probe so the caller still gets `verifiedGreen` truthfully.
 */
import type { RemediationHandler } from '../remediate.js';
export declare const agentMailLivenessHandler: RemediationHandler;
//# sourceMappingURL=agent_mail_liveness.d.ts.map