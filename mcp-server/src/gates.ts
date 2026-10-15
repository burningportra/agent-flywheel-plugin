interface FreshEyesPromptBase {
  round: number;
  memoryContext: string;
  allArtifacts: string[];
  callbackHint: string;
  regressionHint: string;
}

export type FreshEyesPromptOpts = FreshEyesPromptBase & (
  | {
      emitStructuredFindings: true;
      shaRange: string;
      findingsPath: string;
    }
  | {
      emitStructuredFindings?: false;
      shaRange?: never;
      findingsPath?: never;
    }
);

export function buildFreshEyesPrompt(opts: FreshEyesPromptOpts): string {
  const { round, memoryContext, allArtifacts, callbackHint, regressionHint } = opts;
  const filesBlock = allArtifacts.map((artifact) => `- ${artifact}`).join("\n");
  const structuredFindingsBlock = opts.emitStructuredFindings
    ? `\n\n## Structured findings
Write the JSON object below to \`${opts.findingsPath}\`. The server reads only this file. Do not append the JSON to your response.

\`\`\`json
{
  "status": "pass" | "needs_attention" | "blocking",
  "findings": [
    {
      "severity": "low" | "medium" | "high" | "critical",
      "summary": "<one-line description>",
      "suggested_bead_title": "<verb-phrase title for the auto-synthesized bead>",
      "affected_files": ["<relative path>", "..."],
      "evidence_excerpt": "<2-10 lines of code or git log excerpt>"
    }
  ],
  "sha_range": "${opts.shaRange}"
}
\`\`\`

- Use \`status = "pass"\` when the diff is clean, and set \`findings = []\`.
- Use \`status = "needs_attention"\` when findings exist but none warrants an automatic bead.
- Use \`status = "blocking"\` when at least one finding is severe enough to become a bead. Every finding in the array becomes a \`br create\` input.`
    : "";

  return `## Fresh-eyes reviewer - Round ${round}${memoryContext}

Use ultrathink.

Review one bead and only the files assigned to it. Read every new or modified line, then answer these questions:

1. Does the implementation satisfy the bead description?
2. Which empty inputs, concurrent operations, error paths, or boundary conditions can break it?
3. Does the same bug pattern exist in another assigned file?
4. Is there a simpler or more robust implementation?

Fix every issue you find. If you find a bug, search the assigned files for the same pattern before you finish. Report a short summary to the coordinator.

## Files in this batch
The coordinator narrows this list to one bead's files before dispatch.

${filesBlock}${structuredFindingsBlock}${callbackHint}${regressionHint}`;
}
