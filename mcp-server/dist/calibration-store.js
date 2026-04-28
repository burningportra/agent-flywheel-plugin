export function computeDurationStats(durationsMinutes) {
    const count = durationsMinutes.length;
    if (count === 0) {
        return { count: 0, meanMinutes: 0, medianMinutes: 0, p95Minutes: 0, minMinutes: 0, maxMinutes: 0 };
    }
    const sorted = [...durationsMinutes].sort((a, b) => a - b);
    let sum = 0;
    for (const v of sorted)
        sum += v;
    const meanMinutes = sum / count;
    let medianMinutes;
    if (count % 2 === 1) {
        medianMinutes = sorted[Math.floor(count / 2)];
    }
    else {
        const mid = count / 2;
        medianMinutes = (sorted[mid - 1] + sorted[mid]) / 2;
    }
    const p95Index = Math.floor(0.95 * (count - 1));
    const p95Minutes = sorted[p95Index];
    return {
        count,
        meanMinutes,
        medianMinutes,
        p95Minutes,
        minMinutes: sorted[0],
        maxMinutes: sorted[count - 1],
    };
}
//# sourceMappingURL=calibration-store.js.map