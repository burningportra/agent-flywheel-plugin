import { describe, it, expect } from 'vitest';
import { resolveDiscoveryArtifactDir } from '../tools/discover.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('R-010 — resolveDiscoveryArtifactDir', () => {
  it('honors XDG_STATE_HOME when set', () => {
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '/custom/state';
    try {
      expect(resolveDiscoveryArtifactDir()).toBe('/custom/state/agent-flywheel/discovery');
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });

  it('falls back to ~/.local/state/agent-flywheel/discovery when XDG_STATE_HOME unset', () => {
    const prev = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;
    try {
      expect(resolveDiscoveryArtifactDir()).toBe(
        join(homedir(), '.local', 'state', 'agent-flywheel', 'discovery'),
      );
    } finally {
      if (prev !== undefined) process.env.XDG_STATE_HOME = prev;
    }
  });

  it('treats whitespace-only XDG_STATE_HOME as unset', () => {
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '   ';
    try {
      expect(resolveDiscoveryArtifactDir()).toBe(
        join(homedir(), '.local', 'state', 'agent-flywheel', 'discovery'),
      );
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });

  it('NEVER returns a /tmp path', () => {
    expect(resolveDiscoveryArtifactDir()).not.toContain('/tmp');
  });
});
