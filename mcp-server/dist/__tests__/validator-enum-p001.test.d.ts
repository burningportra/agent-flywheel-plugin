/**
 * P-001 (pass-5 second-order finding) — validateToolArgs must reject
 * invalid enum values BEFORE dispatch reaches the runner.
 *
 * Why: pre-P-001, a bad enum value (e.g. flywheel_review action:"review"
 * vs the valid hit-me|looks-good|skip) would slip through validation.
 * The runner's required-field check fired next and surfaced an error
 * about the WRONG field. Discovered in the pass-5 fresh-eyes simulation
 * transcript at audit/agent_simulations/post_pass_5/.
 */
export {};
//# sourceMappingURL=validator-enum-p001.test.d.ts.map