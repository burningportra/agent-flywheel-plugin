import type { ExecFn } from './exec.js';
/** Local type — sophia owns its own step interface for CR creation. */
interface PlanStep {
    index: number;
    description: string;
    acceptanceCriteria: string[];
    artifacts: string[];
    dependsOn?: number[];
}
export interface SophiaResult<T = unknown> {
    ok: boolean;
    data?: T;
    error?: string;
}
export interface SophiaCR {
    id: number;
    branch: string;
    title: string;
}
export interface SophiaTask {
    id: number;
    title: string;
}
export interface SophiaTaskStatus {
    id: number;
    title: string;
    status: string;
}
export interface SophiaCRStatus {
    id: number;
    branch: string;
    title: string;
    status: string;
    tasks: SophiaTaskStatus[];
}
export declare function isSophiaAvailable(exec: ExecFn, cwd: string): Promise<boolean>;
export declare function isSophiaInitialized(exec: ExecFn, cwd: string): Promise<boolean>;
export declare function initSophia(exec: ExecFn, cwd: string): Promise<SophiaResult>;
export declare function getCRStatus(exec: ExecFn, cwd: string, crId: number): Promise<SophiaResult<SophiaCRStatus>>;
export declare function createCR(exec: ExecFn, cwd: string, title: string, description: string): Promise<SophiaResult<SophiaCR>>;
export declare function setCRContract(exec: ExecFn, cwd: string, crId: number, opts: {
    why: string;
    scope: string[];
    nonGoals?: string[];
    invariants?: string[];
    testPlan?: string;
    rollbackPlan?: string;
    blastRadius?: string;
}): Promise<SophiaResult>;
export declare function addTask(exec: ExecFn, cwd: string, crId: number, title: string): Promise<SophiaResult<SophiaTask>>;
export declare function setTaskContract(exec: ExecFn, cwd: string, crId: number, taskId: number, opts: {
    intent: string;
    acceptance: string[];
    scope: string[];
}): Promise<SophiaResult>;
export declare function checkpointTask(exec: ExecFn, cwd: string, crId: number, taskId: number, commitType?: string): Promise<SophiaResult>;
export declare function validateCR(exec: ExecFn, cwd: string, crId: number): Promise<SophiaResult>;
export declare function reviewCR(exec: ExecFn, cwd: string, crId: number): Promise<SophiaResult>;
export interface PlanToCRResult {
    cr: SophiaCR;
    taskIds: Map<number, number>;
}
/**
 * Creates a Sophia CR from a plan, with tasks and contracts for each step.
 * Returns the CR info and a mapping of plan step indices to sophia task IDs.
 */
export declare function createCRFromPlan(exec: ExecFn, cwd: string, goal: string, steps: PlanStep[], constraints: string[]): Promise<SophiaResult<PlanToCRResult>>;
export interface MergeResult {
    ok: boolean;
    conflict: boolean;
    conflictFiles?: string[];
    error?: string;
}
/**
 * Merge changes from a worktree branch back to the target branch.
 * Uses --no-ff to keep a clear merge history.
 * If conflicts occur, aborts the merge and reports conflicting files.
 */
export declare function mergeWorktreeChanges(exec: ExecFn, cwd: string, sourceBranch: string, targetBranch: string, stepDescription?: string): Promise<MergeResult>;
export {};
//# sourceMappingURL=sophia.d.ts.map