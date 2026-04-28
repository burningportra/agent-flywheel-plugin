/**
 * checkpoint_validity remediation — back up corrupt checkpoint to .bak.<ts>.
 *
 * Strategy: rename `.pi-flywheel/checkpoint.json` to a timestamped backup so
 * the next session can start fresh. Reversible by renaming the .bak file
 * back. verifyProbe re-runs the same `readCheckpoint()` the doctor uses;
 * absent OR cleanly-loaded == green.
 */
import type { RemediationHandler } from '../remediate.js';
export declare const checkpointValidityHandler: RemediationHandler;
//# sourceMappingURL=checkpoint_validity.d.ts.map