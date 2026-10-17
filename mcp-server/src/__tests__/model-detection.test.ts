import { describe, expect, it, vi } from 'vitest';
import {
  detectAvailableModels,
  getDeepPlanModels,
  getRefinementModel,
} from '../model-detection.js';

describe('model detection', () => {
  it('returns Agent aliases for deep planning and omits the Pi planner by default', () => {
    expect(getDeepPlanModels()).toEqual({
      correctness: 'opus',
      ergonomics: 'sonnet',
      synthesis: 'opus',
      freshPerspective: null,
    });
  });

  it('returns a Pi pane dispatch on Gemini Argon through Vercel when Pi is available', () => {
    expect(getDeepPlanModels({ piAvailable: true })).toEqual({
      correctness: 'opus',
      ergonomics: 'sonnet',
      synthesis: 'opus',
      freshPerspective: {
        runner: 'pi-pane',
        provider: 'pi',
        piModel: 'vercel-ai-gateway/google/gemini-4-argon',
      },
    });
  });

  it('uses a requested Pi model id', () => {
    const selection = getDeepPlanModels({
      piAvailable: true,
      piModel: 'openrouter/google/gemini-4-argon:high',
    });

    expect(selection.freshPerspective?.piModel).toBe('openrouter/google/gemini-4-argon:high');
  });

  it('falls back to the default Pi model and warns when the requested one could break the shell command', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const selection = getDeepPlanModels({ piAvailable: true, piModel: 'argon"; echo pwned' });

      expect(selection.freshPerspective?.piModel).toBe('vercel-ai-gateway/google/gemini-4-argon');
      const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(written).toContain('FW_PI_PLANNER_MODEL');
    } finally {
      stderr.mockRestore();
    }
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
