// ─── I9: Synthesizer template hints ──────────────────────────
//
// The synthesizer may annotate bead specs with a template hint of the shape
// `<id>@<version>` (e.g. `foundation-with-fresh-eyes-gate@1`). Approve-time
// expansion (in `tools/approve.ts`) parses the hint and calls
// `expandTemplate(id, version, input)` from `bead-templates.ts`. Beads without
// a hint fall through the legacy free-form path unchanged.

/**
 * Matches a synthesizer-emitted template hint of the shape `<id>@<version>`.
 *
 * - `id`      — lowercase kebab-case (same shape validated by
 *               `validateTemplateIntegrity` in `bead-templates.ts`).
 * - `version` — positive integer.
 *
 * Leading/trailing whitespace is tolerated so `template: "  foo@1  "` still
 * parses; internal whitespace is rejected.
 */
export const TEMPLATE_HINT_REGEX = /^(?<id>[a-z][a-z0-9-]*)@(?<version>\d+)$/;

/**
 * Parse a synthesizer-emitted template hint (`"<id>@<version>"`).
 *
 * Returns `undefined` when the hint is missing, not a string, or malformed —
 * the caller should treat `undefined` as "no template hint, fall through to
 * legacy free-form bead creation." Malformed hints are logged at warn level so
 * they surface in session telemetry without breaking the bead-creation path.
 */
export function parseTemplateHint(hint: unknown): { id: string; version: number } | undefined {
  if (typeof hint !== "string") return undefined;
  const trimmed = hint.trim();
  if (trimmed.length === 0) return undefined;
  const match = TEMPLATE_HINT_REGEX.exec(trimmed);
  if (!match || !match.groups) {
    process.stderr.write(
      `[deep-plan] WARNING: Ignoring malformed template hint: ${JSON.stringify(trimmed)}\n`
    );
    return undefined;
  }
  const version = Number.parseInt(match.groups.version, 10);
  if (!Number.isFinite(version) || version < 1) {
    process.stderr.write(
      `[deep-plan] WARNING: Ignoring template hint with non-positive version: ${JSON.stringify(trimmed)}\n`
    );
    return undefined;
  }
  return { id: match.groups.id, version };
}

/**
 * Guidance block embedded into the plan-to-beads prompt so the synthesizing
 * agent knows how to emit template hints. Kept as an exported helper so it
 * can be composed into both the freeform bead-creation prompt
 * (`prompts.ts` §planToBeadsPrompt) and any future synthesizer prompt paths.
 */
export function synthesizerTemplateHintGuidance(): string {
  return [
    "### Template hints (optional but recommended)",
    "",
    "When a bead matches one of the built-in templates, annotate the bead spec with:",
    "",
    "    template: <id>@<version>",
    "",
    "The approve-time expansion path will call `expandTemplate(id, version, { title, scope, acceptance, test_plan })`",
    "and replace the bead description with the rendered body. When that expanded body is used in `br create`,",
    "include a machine-readable `Template: <id>` line near the top so `flywheel_calibrate` can group closed beads by template.",
    "Beads without a `template:` hint flow through the legacy free-form path unchanged and should omit `Template: <id>`.",
    "",
    "Hint ids must be lowercase kebab-case and versions must be positive integers,",
    "matching the regex `^[a-z][a-z0-9-]*@\\d+$` (e.g. `foundation-with-fresh-eyes-gate@1`).",
    "Malformed hints are ignored with a warn-level log; the bead is created as free-form.",
  ].join("\n");
}
