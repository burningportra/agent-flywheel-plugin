/** Pure stats — no I/O. */
export interface DurationStats {
    count: number;
    meanMinutes: number;
    medianMinutes: number;
    p95Minutes: number;
    minMinutes: number;
    maxMinutes: number;
}
export declare function computeDurationStats(durationsMinutes: number[]): DurationStats;
//# sourceMappingURL=calibration-store.d.ts.map