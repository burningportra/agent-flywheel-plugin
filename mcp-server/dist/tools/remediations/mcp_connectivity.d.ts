/**
 * mcp_connectivity remediation — ensure mcp-server build artefacts are present.
 *
 * The doctor check probes whether `mcp-server/dist/server.js` exists. If
 * missing, we run `npm ci && npm run build` (mutating only when missing).
 * verifyProbe re-runs the existence check.
 */
import type { RemediationHandler } from '../remediate.js';
export declare const mcpConnectivityHandler: RemediationHandler;
//# sourceMappingURL=mcp_connectivity.d.ts.map