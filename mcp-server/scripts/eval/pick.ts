import type { ScriptedAnswer } from "./types.js";

export type PickOutcome =
  | {
      kind: "matched";
      /** Final label we return to the SDK as the user's answer. */
      label: string;
      /** The scripted rule whose `headerContains` matched the question header. */
      ruleTarget: string;
      /** Which option label in the offered list the rule selected. */
      optionMatched: string;
    }
  | {
      kind: "unmatched";
      /** A rule matched by header, but its target string matched no option label. */
      ruleTarget: string;
      /** The headers/labels that were on offer so the violation message can quote them. */
      header: string;
      labels: string[];
    }
  | {
      kind: "default";
      /** No scripted rule matched by header; we took options[0] as the fallback. */
      label: string;
      header: string;
      labels: string[];
    };

/**
 * Pick an answer for one AskUserQuestion sub-question.
 *
 * Matching rule (fixed under M3 reopen, 2026-10-15):
 *   1. A scripted rule matches when its `headerContains` substring is in the
 *      question's `header`. Question *text* is intentionally NOT scanned, so a
 *      rule like `headerContains: "pre-flight"` cannot be fired by a scope
 *      question whose body mentions "Pre-flight".
 *   2. If a rule matches, its target string must substring-match one of the
 *      offered option labels. On miss, return a `kind: "unmatched"` outcome
 *      so the caller can record a harness violation instead of injecting
 *      free-text to Sonnet.
 *   3. If no rule matches by header, fall back to the first offered option
 *      and record it as a `kind: "default"` outcome so the caller can log
 *      which scenario relied on the fallback.
 */
export function pickAnswer(
  header: string,
  options: Array<Record<string, unknown>>,
  scripted: readonly ScriptedAnswer[],
): PickOutcome {
  const hdr = String(header ?? "").toLowerCase();
  const labels = options.map((o) => String(o["label"] ?? ""));

  const rule = scripted.find((s) => hdr.includes(s.headerContains.toLowerCase()));
  if (rule) {
    const match = labels.find((label) =>
      label.toLowerCase().includes(rule.option.toLowerCase()),
    );
    if (match) {
      return {
        kind: "matched",
        label: match,
        ruleTarget: rule.option,
        optionMatched: match,
      };
    }
    return {
      kind: "unmatched",
      ruleTarget: rule.option,
      header,
      labels,
    };
  }

  const first = labels[0] ?? "";
  return { kind: "default", label: first, header, labels };
}
