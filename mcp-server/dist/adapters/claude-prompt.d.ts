/**
 * Claude prompt adapter.
 *
 * Claude is the baseline — its prompt mirrors the existing Step 7
 * template in `skills/start/_implement.md` so behavior is unchanged for
 * Claude panes when model diversity is enabled. Kept as its own file so
 * the three providers expose a symmetric interface.
 */
import type { AdaptedPrompt, BeadDispatchContext } from './codex-prompt.js';
export type { AdaptedPrompt, BeadDispatchContext };
export declare function adaptPromptForClaude(bead: BeadDispatchContext): AdaptedPrompt;
//# sourceMappingURL=claude-prompt.d.ts.map