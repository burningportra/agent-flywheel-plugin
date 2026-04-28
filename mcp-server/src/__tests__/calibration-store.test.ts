import { describe, it, expect } from 'vitest';
import { computeDurationStats } from '../calibration-store.js';

describe('computeDurationStats', () => {
  it('empty input → all stats 0', () => {
    const s = computeDurationStats([]);
    expect(s.count).toBe(0);
    expect(s.meanMinutes).toBe(0);
    expect(s.medianMinutes).toBe(0);
    expect(s.p95Minutes).toBe(0);
    expect(s.minMinutes).toBe(0);
    expect(s.maxMinutes).toBe(0);
  });

  it('single element → all four stats equal that element', () => {
    const s = computeDurationStats([42]);
    expect(s.count).toBe(1);
    expect(s.meanMinutes).toBe(42);
    expect(s.medianMinutes).toBe(42);
    expect(s.p95Minutes).toBe(42);
    expect(s.minMinutes).toBe(42);
    expect(s.maxMinutes).toBe(42);
  });

  it('even-count median = mean of two middle elements', () => {
    // sorted: [10, 20, 30, 40] → median = (20+30)/2 = 25
    const s = computeDurationStats([40, 10, 30, 20]);
    expect(s.count).toBe(4);
    expect(s.medianMinutes).toBe(25);
    expect(s.meanMinutes).toBe(25);
  });

  it('odd-count median = middle element', () => {
    // sorted: [10, 20, 30] → median = 20
    const s = computeDurationStats([30, 10, 20]);
    expect(s.count).toBe(3);
    expect(s.medianMinutes).toBe(20);
  });

  it('p95 uses Math.floor(0.95 * (n-1)) index after sort (no interpolation)', () => {
    // 20 elements: sorted 1..20
    // p95Index = floor(0.95 * 19) = floor(18.05) = 18 → value = 19
    const arr = Array.from({ length: 20 }, (_, i) => i + 1);
    const s = computeDurationStats(arr);
    expect(s.p95Minutes).toBe(19);
  });

  it('5000-element large input completes <100ms', () => {
    const arr = Array.from({ length: 5000 }, (_, i) => i + 1);
    const start = performance.now();
    const s = computeDurationStats(arr);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(s.count).toBe(5000);
    expect(s.minMinutes).toBe(1);
    expect(s.maxMinutes).toBe(5000);
  });

  it('stats are not NaN for normal inputs', () => {
    const s = computeDurationStats([5, 10, 15, 20, 25]);
    expect(Number.isNaN(s.meanMinutes)).toBe(false);
    expect(Number.isNaN(s.medianMinutes)).toBe(false);
    expect(Number.isNaN(s.p95Minutes)).toBe(false);
  });
});
