/**
 * cli_binary remediations — auto-install missing flywheel CLI deps via the
 * canonical curl|bash installers documented in `commands/flywheel-setup.md`.
 *
 * One factory builds a handler per binary so the install command + verify
 * probe stay in lockstep. Each handler:
 *
 *   - buildPlan: returns the install one-liner (mutating, reversible — the
 *     installers drop a single binary into ~/.local/bin or via brew).
 *   - execute: shells out to `bash -lc '<installer>'` so the user's PATH/env
 *     is honoured. Output is captured and returned for caller display.
 *   - verifyProbe: runs `<binary> --version`, falling back to `--help` for
 *     CLIs (like ntm) that don't accept --version. Mirrors the doctor probe
 *     in mcp-server/src/tools/doctor.ts so a green here means a green in the
 *     follow-up doctor sweep.
 *
 * Mutating — refused in execute mode without autoConfirm:true (enforced by
 * the dispatcher in remediate.ts). Reversible in the sense that the installs
 * are scoped to ~/.local/bin or Homebrew and can be uninstalled by hand;
 * we surface that through `reversible:true` on the plan but never attempt a
 * rollback automatically.
 *
 * Scope is deliberately narrow: only flywheel-owned CLIs (br, bv, ntm, cm).
 * System deps (tmux, gh, node) and optional tools (ubs, slb, …) are NOT
 * remediated here — those stay manual, in line with the bead's non-goals.
 */
import type { RemediationHandler } from '../remediate.js';
export declare const brBinaryHandler: RemediationHandler;
export declare const bvBinaryHandler: RemediationHandler;
export declare const ntmBinaryHandler: RemediationHandler;
export declare const cmBinaryHandler: RemediationHandler;
//# sourceMappingURL=cli_binary.d.ts.map