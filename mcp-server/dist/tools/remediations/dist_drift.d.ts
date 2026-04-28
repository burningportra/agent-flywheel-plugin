/**
 * dist_drift remediation — rebuild mcp-server/dist after src changes.
 *
 * Strategy: run `npm run build` inside `mcp-server/`. verifyProbe re-runs the
 * doctor check (newest .ts mtime under src vs newest mtime under dist).
 *
 * Mutating, reversible (`git checkout mcp-server/dist`). Refuses
 * autoConfirm:false in execute mode (enforced by dispatcher in remediate.ts).
 */
import type { RemediationHandler } from '../remediate.js';
export declare const distDriftHandler: RemediationHandler;
//# sourceMappingURL=dist_drift.d.ts.map