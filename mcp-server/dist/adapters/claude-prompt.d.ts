/**
 * Prompt adapter for terminal-agent panes: Claude, and the Pi panes of the
 * Pi and Gemini lanes.
 *
 * Claude is the baseline — its prompt mirrors the existing Step 7
 * template in `skills/start/_implement.md` so behavior is unchanged for
 * Claude panes when model diversity is enabled. Pi and Gemini panes get the
 * same steps with Agent Mail through the `am` CLI.
 */
import type { AdaptedPrompt, BeadDispatchContext } from './codex-prompt.js';
export type { AdaptedPrompt, BeadDispatchContext };
export declare function adaptPromptForClaude(bead: BeadDispatchContext): AdaptedPrompt;
export declare function adaptPromptForPi(bead: BeadDispatchContext): AdaptedPrompt;
/** The Gemini lane is a Pi pane running {@link CURRENT_GEMINI_MODEL_ID}. */
export declare function adaptPromptForGemini(bead: BeadDispatchContext): AdaptedPrompt;
//# sourceMappingURL=claude-prompt.d.ts.map