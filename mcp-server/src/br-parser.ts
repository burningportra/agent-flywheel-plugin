import { z } from "zod";
import { FlywheelError } from "./errors.js";

export const BrListRowSchema = z.object({
  id: z.string(),
  title: z.string().default(""),
  status: z.enum(["open", "in_progress", "closed", "deferred"]).default("open"),
  priority: z.number().int().optional(),
  labels: z.array(z.string()).optional(),
  template: z.string().optional(),
  created_ts: z.string().optional(),
  closed_ts: z.string().optional(),
}).passthrough();

export type BrListRow = z.infer<typeof BrListRowSchema>;

export function parseBrListArray(rows: unknown[]): { rows: BrListRow[]; rejected: number } {
  const parsed: BrListRow[] = [];
  let rejected = 0;
  for (const row of rows) {
    const result = BrListRowSchema.safeParse(row);
    if (result.success) {
      parsed.push(result.data);
    } else {
      rejected++;
    }
  }
  return { rows: parsed, rejected };
}

export function parseBrList(rawJson: string): { rows: BrListRow[]; rejected: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson.trim());
  } catch (e) {
    const msg = e instanceof SyntaxError ? e.message : String(e);
    throw new FlywheelError({
      code: "parse_failure",
      message: `br list --json output is not valid JSON: ${msg}`,
      cause: msg,
    });
  }

  const candidate = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["issues"])
      ? (parsed as Record<string, unknown>)["issues"] as unknown[]
      : null;

  if (candidate === null) {
    throw new FlywheelError({
      code: "parse_failure",
      message: "br list --json output is not an array or {issues:[]} object",
    });
  }

  return parseBrListArray(candidate);
}
