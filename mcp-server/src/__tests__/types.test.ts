import { describe, it, expect } from 'vitest';
import { createInitialState } from '../types.js';

describe('createInitialState', () => {
  it('returns an object with all required fields', () => {
    const state = createInitialState();
    expect(state).toHaveProperty('phase');
    expect(state).toHaveProperty('constraints');
    expect(state).toHaveProperty('retryCount');
    expect(state).toHaveProperty('maxRetries');
    expect(state).toHaveProperty('maxReviewPasses');
    expect(state).toHaveProperty('iterationRound');
    expect(state).toHaveProperty('currentGateIndex');
    expect(state).toHaveProperty('polishRound');
    expect(state).toHaveProperty('polishChanges');
    expect(state).toHaveProperty('polishConverged');
  });

  it('starts in idle phase', () => {
    expect(createInitialState().phase).toBe('idle');
  });

  it('starts with empty constraints', () => {
    expect(createInitialState().constraints).toEqual([]);
  });

  it('starts with zero counters', () => {
    const state = createInitialState();
    expect(state.retryCount).toBe(0);
    expect(state.iterationRound).toBe(0);
    expect(state.currentGateIndex).toBe(0);
    expect(state.polishRound).toBe(0);
  });

  it('starts with default max values', () => {
    const state = createInitialState();
    expect(state.maxRetries).toBe(3);
    expect(state.maxReviewPasses).toBe(2);
  });

  it('starts with empty polishChanges and polishConverged false', () => {
    const state = createInitialState();
    expect(state.polishChanges).toEqual([]);
    expect(state.polishConverged).toBe(false);
  });
});
