/**
 * Detect the active platform (Claude Code, Codex, Gemini CLI, …) and return
 * the matching {@link HookAdapter}.
 *
 * Detection order (first hit wins):
 *   1. Explicit `FLYWHEEL_PLATFORM` env var (test override).
 *   2. `CLAUDE_PLUGIN_ROOT` or `CLAUDECODE` env → claude-code.
 *   3. Default fallback → claude-code.
 *
 * Adding a new platform: implement the adapter, then add a case to
 * `getAdapter` AND a detection rule here. No edits to doctor.ts/setup.ts
 * are required.
 */
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter.js';
import type { HookAdapter } from './HookAdapter.js';

export type PlatformId = 'claude-code';

export function detectPlatform(): PlatformId {
  const explicit = process.env.FLYWHEEL_PLATFORM;
  if (explicit === 'claude-code') return 'claude-code';
  if (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDECODE) return 'claude-code';
  return 'claude-code';
}

export function getAdapter(platform: PlatformId = detectPlatform()): HookAdapter {
  switch (platform) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    default: {
      const _exhaustive: never = platform;
      void _exhaustive;
      return new ClaudeCodeAdapter();
    }
  }
}
