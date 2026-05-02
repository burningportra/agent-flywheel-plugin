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
import type { RemediationHandler } from '../remediate.js';
export declare const agentMailLivenessHandler: RemediationHandler;
//# sourceMappingURL=agent_mail_liveness.d.ts.map