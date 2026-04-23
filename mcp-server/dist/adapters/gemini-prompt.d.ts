/**
 * Gemini prompt adapter.
 *
 * Gemini tends to:
 *   - Do better with explicit headers + role framing at the top
 *     ("You are an implementation engineer…") and firm guardrails.
 *   - Repeat itself when structured-output blocks are ambiguous, so we
 *     bound it with a "STOP after the completion report" instruction.
 *   - Handle a bullet-heavy prompt more reliably than dense prose.
 *
 * The interface mirrors `codex-prompt.ts` exactly so the dispatch layer
 * is a switch on `provider`, nothing more.
 */
import type { AdaptedPrompt, BeadDispatchContext } from './codex-prompt.js';
export type { AdaptedPrompt, BeadDispatchContext };
export declare function adaptPromptForGemini(bead: BeadDispatchContext): AdaptedPrompt;
//# sourceMappingURL=gemini-prompt.d.ts.map