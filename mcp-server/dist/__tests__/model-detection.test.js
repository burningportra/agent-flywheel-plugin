import { describe, expect, it } from 'vitest';
import { detectAvailableModels, getDeepPlanModels, getRefinementModel, } from '../model-detection.js';
describe('model detection', () => {
    it('returns Agent aliases for deep planning and omits Gemini by default', () => {
        expect(getDeepPlanModels()).toEqual({
            correctness: 'opus',
            ergonomics: 'sonnet',
            synthesis: 'opus',
            freshPerspective: null,
        });
    });
    it('returns an NTM gmi dispatch when Gemini is available', () => {
        expect(getDeepPlanModels({ geminiAvailable: true })).toEqual({
            correctness: 'opus',
            ergonomics: 'sonnet',
            synthesis: 'opus',
            freshPerspective: {
                runner: 'ntm-gmi',
                provider: 'gemini',
                paneType: 'gmi',
            },
        });
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
//# sourceMappingURL=model-detection.test.js.map