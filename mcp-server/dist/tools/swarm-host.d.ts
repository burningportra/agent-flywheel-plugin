import { z } from 'zod';
import type { McpToolResult, ToolContext } from '../types.js';
export declare const SwarmHostInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    action: z.ZodDefault<z.ZodEnum<{
        list: "list";
        sync: "sync";
        choose: "choose";
        release: "release";
    }>>;
    pick: z.ZodOptional<z.ZodString>;
    coordinatorName: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** The command the coordinator prefixes to run something in the host's clone (or here, with no host). */
export declare function runCommandFor(cwd: string): string;
/**
 * `flywheel_swarm_host` picks the Mac a swarm runs on. `list` finds Macs on
 * the local network that answer SSH and returns the AskUserQuestion payload;
 * `choose` prepares the picked Mac (a clone under its ntm projects_base, this
 * checkout's commits and beads, a keep-awake) or switches back to this Mac;
 * `sync` pulls the swarm's work back and pushes this checkout's; `release`
 * pulls one last time and forgets the host.
 */
export declare function runSwarmHost(ctx: ToolContext, input: unknown): Promise<McpToolResult>;
//# sourceMappingURL=swarm-host.d.ts.map