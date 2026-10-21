import type { BeadDispatchContext } from './codex-prompt.js';
/**
 * pstack guardrails against the excuses that let unfinished work close.
 * `potetoMode` adds the rule that an implementor never verifies its own bead,
 * because `flywheel_advance_wave` then waits for an independent verdict.
 */
export declare function buildAntiRationalizationRules(opts?: {
    potetoMode?: boolean;
}): string;
export declare function buildPreCompletionQualityGate(bead: Pick<BeadDispatchContext, 'beadId' | 'agentName'> & {
    potetoMode?: boolean;
}): string;
//# sourceMappingURL=completion-attestation-prompt.d.ts.map