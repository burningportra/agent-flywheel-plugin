import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateCheckpoint,
  computeStateHash,
  writeCheckpoint,
  readCheckpoint,
  clearCheckpoint,
  cleanupOrphanedTmp,
  CHECKPOINT_DIR,
  CHECKPOINT_FILE,
  CHECKPOINT_TMP,
  CHECKPOINT_CORRUPT,
} from '../checkpoint.js';
import { createInitialState } from '../types.js';
import type { OrchestratorState, CheckpointEnvelope } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeEnvelope(state: OrchestratorState, overrides: Partial<CheckpointEnvelope> = {}): CheckpointEnvelope {
  return {
    schemaVersion: 1,
    writtenAt: new Date().toISOString(),
    orchestratorVersion: '0.0.0-test',
    state,
    stateHash: computeStateHash(state),
    ...overrides,
  };
}

// ─── validateCheckpoint ─────────────────────────────────────────

describe('validateCheckpoint', () => {
  it('accepts a valid envelope', () => {
    const state = createInitialState();
    const envelope = makeEnvelope(state);
    expect(validateCheckpoint(envelope)).toEqual({ valid: true });
  });

  it('rejects non-object input', () => {
    expect(validateCheckpoint(null)).toEqual({ valid: false, reason: 'checkpoint is not an object' });
    expect(validateCheckpoint('string')).toEqual({ valid: false, reason: 'checkpoint is not an object' });
  });

  it('rejects wrong schemaVersion', () => {
    const state = createInitialState();
    const envelope = makeEnvelope(state, { schemaVersion: 2 as any });
    expect(validateCheckpoint(envelope)).toEqual({ valid: false, reason: 'unknown schemaVersion: 2' });
  });

  it('rejects missing writtenAt', () => {
    const state = createInitialState();
    const envelope = makeEnvelope(state);
    delete (envelope as any).writtenAt;
    expect(validateCheckpoint(envelope)).toEqual({ valid: false, reason: 'missing or invalid writtenAt' });
  });

  it('rejects invalid writtenAt (not ISO date)', () => {
    const state = createInitialState();
    const envelope = makeEnvelope(state, { writtenAt: 'not-a-date' });
    expect(validateCheckpoint(envelope)).toEqual({ valid: false, reason: 'writtenAt is not a valid ISO date' });
  });

  it('rejects hash mismatch', () => {
    const state = createInitialState();
    const envelope = makeEnvelope(state, { stateHash: 'deadbeef' });
    const result = validateCheckpoint(envelope);
    expect(result).toEqual({ valid: false, reason: 'stateHash mismatch — state may be tampered or corrupted' });
  });

  it('rejects missing state.phase', () => {
    const state = createInitialState();
    const envelope = makeEnvelope(state);
    delete (envelope.state as any).phase;
    // Recompute hash since we modified state
    (envelope as any).stateHash = computeStateHash(envelope.state);
    expect(validateCheckpoint(envelope)).toEqual({ valid: false, reason: 'state.phase is not a string' });
  });

  it('rejects missing orchestratorVersion', () => {
    const state = createInitialState();
    const envelope = makeEnvelope(state);
    delete (envelope as any).orchestratorVersion;
    expect(validateCheckpoint(envelope)).toEqual({ valid: false, reason: 'missing orchestratorVersion' });
  });
});

// ─── computeStateHash ───────────────────────────────────────────

describe('computeStateHash', () => {
  it('returns same hash for same state', () => {
    const state = createInitialState();
    expect(computeStateHash(state)).toBe(computeStateHash(state));
  });

  it('returns different hash when a field changes', () => {
    const a = createInitialState();
    const b = { ...createInitialState(), phase: 'planning' as const };
    expect(computeStateHash(a)).not.toBe(computeStateHash(b));
  });

  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = computeStateHash(createInitialState());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── writeCheckpoint ────────────────────────────────────────────

describe('writeCheckpoint', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes file and returns true', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-write-'));
    const state = createInitialState();
    const ok = writeCheckpoint(dir, state);
    expect(ok).toBe(true);
    expect(existsSync(join(dir, CHECKPOINT_DIR, CHECKPOINT_FILE))).toBe(true);
  });

  it('creates the checkpoint directory if missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-mkdir-'));
    writeCheckpoint(dir, createInitialState());
    expect(existsSync(join(dir, CHECKPOINT_DIR))).toBe(true);
  });

  it('produces valid JSON with correct stateHash', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-json-'));
    const state = createInitialState();
    writeCheckpoint(dir, state);
    const raw = readFileSync(join(dir, CHECKPOINT_DIR, CHECKPOINT_FILE), 'utf8');
    const envelope = JSON.parse(raw) as CheckpointEnvelope;
    expect(envelope.stateHash).toBe(computeStateHash(state));
    expect(envelope.schemaVersion).toBe(1);
  });

  it('does not leave .tmp file after successful write (atomic rename)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-atomic-'));
    writeCheckpoint(dir, createInitialState());
    expect(existsSync(join(dir, CHECKPOINT_DIR, CHECKPOINT_TMP))).toBe(false);
  });
});

// ─── readCheckpoint ─────────────────────────────────────────────

describe('readCheckpoint', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-nofile-'));
    expect(readCheckpoint(dir)).toBeNull();
  });

  it('returns null on corrupt JSON and moves file to .corrupt', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-corrupt-'));
    const ckptDir = join(dir, CHECKPOINT_DIR);
    mkdirSync(ckptDir, { recursive: true });
    writeFileSync(join(ckptDir, CHECKPOINT_FILE), '{not valid json!!!', 'utf8');

    expect(readCheckpoint(dir)).toBeNull();
    expect(existsSync(join(ckptDir, CHECKPOINT_CORRUPT))).toBe(true);
    expect(existsSync(join(ckptDir, CHECKPOINT_FILE))).toBe(false);
  });

  it('returns null on hash mismatch (moves to .corrupt)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-hashmis-'));
    const ckptDir = join(dir, CHECKPOINT_DIR);
    mkdirSync(ckptDir, { recursive: true });
    const state = createInitialState();
    const envelope: CheckpointEnvelope = {
      schemaVersion: 1,
      writtenAt: new Date().toISOString(),
      orchestratorVersion: '1.0.0',
      state,
      stateHash: 'wrong-hash-value',
    };
    writeFileSync(join(ckptDir, CHECKPOINT_FILE), JSON.stringify(envelope), 'utf8');

    expect(readCheckpoint(dir)).toBeNull();
    expect(existsSync(join(ckptDir, CHECKPOINT_CORRUPT))).toBe(true);
  });

  it('returns result with warnings when checkpoint is stale', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-stale-'));
    const state = createInitialState();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const envelope = makeEnvelope(state, { writtenAt: twoDaysAgo });
    const ckptDir = join(dir, CHECKPOINT_DIR);
    mkdirSync(ckptDir, { recursive: true });
    writeFileSync(join(ckptDir, CHECKPOINT_FILE), JSON.stringify(envelope), 'utf8');

    const result = readCheckpoint(dir);
    expect(result).not.toBeNull();
    expect(result!.warnings.length).toBeGreaterThan(0);
    expect(result!.warnings[0]).toContain('stale');
  });

  it('returns valid envelope on happy path', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-happy-'));
    const state = createInitialState();
    writeCheckpoint(dir, state);

    const result = readCheckpoint(dir);
    expect(result).not.toBeNull();
    expect(result!.envelope.state.phase).toBe('idle');
    expect(result!.envelope.schemaVersion).toBe(1);
    expect(result!.warnings).toEqual([]);
  });
});

// ─── clearCheckpoint ────────────────────────────────────────────

describe('clearCheckpoint', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('removes the checkpoint file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-clear-'));
    writeCheckpoint(dir, createInitialState());
    expect(existsSync(join(dir, CHECKPOINT_DIR, CHECKPOINT_FILE))).toBe(true);

    clearCheckpoint(dir);
    expect(existsSync(join(dir, CHECKPOINT_DIR, CHECKPOINT_FILE))).toBe(false);
  });

  it('is idempotent (no throw if missing)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-clearnofile-'));
    expect(() => clearCheckpoint(dir)).not.toThrow();
  });
});

// ─── cleanupOrphanedTmp ─────────────────────────────────────────

describe('cleanupOrphanedTmp', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('removes .tmp file if present', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-orphan-'));
    const ckptDir = join(dir, CHECKPOINT_DIR);
    mkdirSync(ckptDir, { recursive: true });
    writeFileSync(join(ckptDir, CHECKPOINT_TMP), 'leftover', 'utf8');

    cleanupOrphanedTmp(dir);
    expect(existsSync(join(ckptDir, CHECKPOINT_TMP))).toBe(false);
  });

  it('does not throw if no .tmp file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'ckpt-notmp-'));
    expect(() => cleanupOrphanedTmp(dir)).not.toThrow();
  });
});
