/**
 * flywheel_observe — single-call session-state snapshot (T6, claude-orchestrator-29i).
 *
 * Source: 3-way duel consensus winner (avg 852, full report at
 * `docs/duels/2026-04-30.md`, plan at `docs/plans/2026-04-30-duel-winners.md`).
 *
 * Quoting the duel synthesis: "Doctor probes; status renders; observe snapshots."
 * This tool MUST NOT become a second `flywheel_doctor` or third `flywheel_status`.
 * It snapshots existing primitives in one round-trip.
 *
 * Hard rules (all 3 duel agents agreed; do NOT relax):
 *   1. Idempotent.
 *   2. Non-mutating — never writes checkpoint, never `saveState`, never any fs write.
 *   3. Doctor data either cached or short-budgeted (< 1.5s total tool runtime).
 *   4. Every external probe degrades gracefully — mark sub-section
 *      `unavailable: true` rather than failing the whole call.
 */
import { z } from 'zod';
import type { McpToolResult, ToolContext } from '../types.js';
declare const HintSchema: z.ZodObject<{
    severity: z.ZodEnum<{
        info: "info";
        warn: "warn";
        red: "red";
    }>;
    message: z.ZodString;
    nextAction: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const FlywheelObserveReportSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    cwd: z.ZodString;
    timestamp: z.ZodString;
    elapsedMs: z.ZodNumber;
    git: z.ZodObject<{
        unavailable: z.ZodOptional<z.ZodLiteral<true>>;
        branch: z.ZodOptional<z.ZodString>;
        head: z.ZodOptional<z.ZodString>;
        dirty: z.ZodOptional<z.ZodBoolean>;
        untracked: z.ZodOptional<z.ZodArray<z.ZodString>>;
        warning: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    checkpoint: z.ZodObject<{
        exists: z.ZodBoolean;
        phase: z.ZodOptional<z.ZodString>;
        selectedGoal: z.ZodOptional<z.ZodString>;
        planDocument: z.ZodOptional<z.ZodString>;
        activeBeadIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    beads: z.ZodObject<{
        initialized: z.ZodBoolean;
        unavailable: z.ZodOptional<z.ZodLiteral<true>>;
        warning: z.ZodOptional<z.ZodString>;
        counts: z.ZodObject<{
            open: z.ZodNumber;
            in_progress: z.ZodNumber;
            closed: z.ZodNumber;
            deferred: z.ZodNumber;
            total: z.ZodNumber;
        }, z.core.$strip>;
        ready: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            title: z.ZodString;
            priority: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    agentMail: z.ZodObject<{
        reachable: z.ZodBoolean;
        unreadCount: z.ZodOptional<z.ZodNumber>;
        warning: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    ntm: z.ZodObject<{
        available: z.ZodBoolean;
        panes: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            type: z.ZodOptional<z.ZodString>;
            status: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        warning: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    artifacts: z.ZodObject<{
        wizard: z.ZodArray<z.ZodString>;
        flywheelScratch: z.ZodArray<z.ZodString>;
        truncated: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    attestations: z.ZodObject<{
        inFlightBeadIds: z.ZodArray<z.ZodString>;
        missing: z.ZodArray<z.ZodString>;
        stale: z.ZodArray<z.ZodString>;
        invalid: z.ZodArray<z.ZodString>;
        unavailable: z.ZodOptional<z.ZodLiteral<true>>;
        truncated: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
    hints: z.ZodArray<z.ZodObject<{
        severity: z.ZodEnum<{
            info: "info";
            warn: "warn";
            red: "red";
        }>;
        message: z.ZodString;
        nextAction: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    doctor: z.ZodOptional<z.ZodObject<{
        cached: z.ZodBoolean;
        ageMs: z.ZodOptional<z.ZodNumber>;
        overall: z.ZodOptional<z.ZodEnum<{
            green: "green";
            yellow: "yellow";
            red: "red";
        }>>;
        unavailable: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type FlywheelObserveReport = z.infer<typeof FlywheelObserveReportSchema>;
export type ObserveHint = z.infer<typeof HintSchema>;
/** Test/internal hook — flush the cache. Not exported via the tool envelope. */
export declare function _resetDoctorCache(): void;
export interface ObserveArgs {
    cwd: string;
}
/**
 * Build a session-state snapshot in one MCP round-trip.
 *
 * Read-only. Never mutates checkpoint, never calls `saveState`, never writes
 * any file on disk. Aggregates existing primitives via Promise.allSettled
 * so a single probe failing degrades that section to `unavailable: true`
 * rather than failing the whole call.
 */
export declare function runObserve(ctx: ToolContext, args: ObserveArgs): Promise<McpToolResult>;
export {};
//# sourceMappingURL=observe.d.ts.map