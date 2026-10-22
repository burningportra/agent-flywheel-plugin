/**
 * br_config_latency remediation — set `no_auto_flush: true` and
 * `metrics.disabled: true` in `<cwd>/.beads/config.yaml` so `br update` stays
 * under its 5000ms timeout on external APFS/SMB volumes.
 *
 * Edits go through the `yaml` Document API, so comments and unrelated keys
 * survive. An existing file is copied to `.beads/config.yaml.bak` before the
 * rewrite; a missing file is created. Mutating, reversible.
 */
import type { RemediationHandler } from '../remediate.js';
/**
 * Returns `raw` with both low-latency settings applied, or `raw` unchanged
 * when it already sets them. Throws when `raw` is not a YAML mapping.
 */
export declare function ensureLowLatencyBrConfig(raw: string): string;
export declare const brConfigLatencyHandler: RemediationHandler;
//# sourceMappingURL=br_config_latency.d.ts.map