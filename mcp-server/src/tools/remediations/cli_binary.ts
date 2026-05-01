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

import type { HandlerCtx, RemediationHandler } from '../remediate.js';
import { createLogger } from '../../logger.js';
import { errMsg } from '../../errors.js';

const INSTALL_TIMEOUT_MS = 180_000;
const VERIFY_TIMEOUT_MS = 5_000;

interface CliBinaryConfig {
  binary: string;
  description: string;
  /**
   * Shell one-liner. Wrapped in `bash -lc` at execute time so login PATH
   * (cargo, ~/.local/bin, brew shellenv) is honoured.
   */
  installCommand: string;
}

const CONFIGS: Record<'br_binary' | 'bv_binary' | 'ntm_binary' | 'cm_binary', CliBinaryConfig> = {
  br_binary: {
    binary: 'br',
    description: 'Install br (beads_rust) via the official install script.',
    installCommand:
      'curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash',
  },
  bv_binary: {
    binary: 'bv',
    description: 'Install bv (beads viewer) via the official install script.',
    installCommand:
      'curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/main/install.sh" | bash',
  },
  ntm_binary: {
    binary: 'ntm',
    description: 'Install ntm (named tmux manager) via the official install script.',
    installCommand:
      'curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/ntm/main/install.sh" | bash',
  },
  cm_binary: {
    binary: 'cm',
    description: 'Install cm (CASS Memory) via the official install script.',
    installCommand:
      'curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/cass_memory_system/main/install.sh" | bash -s -- --easy-mode --verify',
  },
};

function buildHandler(checkName: keyof typeof CONFIGS): RemediationHandler {
  const cfg = CONFIGS[checkName];
  const log = createLogger(`remediation.${checkName}`);

  return {
    description: cfg.description,
    mutating: true,
    reversible: true,

    async buildPlan(_ctx: HandlerCtx) {
      return {
        description: cfg.description,
        steps: [cfg.installCommand],
        mutating: true,
        reversible: true,
      };
    },

    async execute(ctx: HandlerCtx) {
      const res = await ctx.exec('bash', ['-lc', cfg.installCommand], {
        cwd: ctx.cwd,
        timeout: INSTALL_TIMEOUT_MS,
        signal: ctx.signal,
      });
      if (res.code !== 0) {
        log.warn(`${cfg.binary} installer exited non-zero`, { exitCode: res.code });
      }
      return { stepsRun: 1, stdout: res.stdout, stderr: res.stderr };
    },

    async verifyProbe(ctx: HandlerCtx) {
      // Use bash -lc so the PATH update from the installer (typically adding
      // ~/.local/bin or ~/.cargo/bin) is visible to this probe. Without -lc
      // a freshly-installed binary may not be on PATH yet.
      try {
        const versionRes = await ctx.exec(
          'bash',
          ['-lc', `command -v ${cfg.binary} >/dev/null 2>&1 && ${cfg.binary} --version`],
          { cwd: ctx.cwd, timeout: VERIFY_TIMEOUT_MS, signal: ctx.signal },
        );
        if (versionRes.code === 0) return true;
        // Fallback: some CLIs (ntm) don't accept --version. Treat any
        // command-resolves-to-something as green.
        const helpRes = await ctx.exec(
          'bash',
          ['-lc', `command -v ${cfg.binary} >/dev/null 2>&1 && ${cfg.binary} --help`],
          { cwd: ctx.cwd, timeout: VERIFY_TIMEOUT_MS, signal: ctx.signal },
        );
        return helpRes.code === 0;
      } catch (err) {
        log.warn(`${cfg.binary} verifyProbe threw`, {
          error: errMsg(err),
        });
        return false;
      }
    },
  };
}

export const brBinaryHandler: RemediationHandler = buildHandler('br_binary');
export const bvBinaryHandler: RemediationHandler = buildHandler('bv_binary');
export const ntmBinaryHandler: RemediationHandler = buildHandler('ntm_binary');
export const cmBinaryHandler: RemediationHandler = buildHandler('cm_binary');
