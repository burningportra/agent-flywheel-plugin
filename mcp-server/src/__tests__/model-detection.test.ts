import { describe, expect, it } from 'vitest';
import {
  DEEP_PLAN_MODELS,
  detectAvailableModels,
  getRefinementModel,
} from '../model-detection.js';

describe('model detection', () => {
  it('pins the Agent aliases for the Claude deep-plan seats', () => {
    expect(DEEP_PLAN_MODELS).toEqual({ correctness: 'opus', ergonomics: 'sonnet', synthesis: 'opus' });
  });

  it('rotates refinement through stable Agent aliases', () => {
    expect(Array.from({ length: 5 }, (_, round) => getRefinementModel(round))).toEqual([
      'opus',
      'sonnet',
      'fable',
      'sonnet',
      'opus',
    ]);
  });

  it('recognizes current Anthropic and Gemini model ids without duplicating provider prefixes', () => {
    const detected = detectAvailableModels([
      'anthropic/claude-opus-5-5',
      'google/gemini-3.1-flash-preview',
    ]);

    expect(detected.correctnessModel).toBe('anthropic/claude-opus-5-5');
    expect(detected.freshPerspectiveModel).toBe('google/gemini-3.1-flash-preview');
  });
});
