import type { Document, Finding, Rule, RuleContext } from "./types.js";
import { errMsg } from "../errors.js";

export interface RunRuleResult {
  findings: Finding[];
  internalError?: { ruleId: string; message: string };
}

export interface RunRuleOptions {
  /** Hard timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** AbortSignal optionally forwarded. */
  signal?: AbortSignal;
}

/**
 * Run a single rule with isolation + timeout. Never throws.
 * - try/catch around rule.check(): caught errors become internalError.
 * - Promise.race with timeout: timeout becomes internalError.
 */
export async function runRule(
  rule: Rule,
  doc: Document,
  ctx: RuleContext,
  opts: RunRuleOptions = {},
): Promise<RunRuleResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const findings = await Promise.race<Finding[]>([
      Promise.resolve().then(() => rule.check(doc, ctx)),
      new Promise<Finding[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`rule timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
        if (opts.signal) {
          opts.signal.addEventListener(
            "abort",
            () => {
              if (timer) clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { findings: findings ?? [] };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const message = errMsg(err);
    return {
      findings: [],
      internalError: { ruleId: rule.id, message },
    };
  }
}
