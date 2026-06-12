import { describe, it, expect } from "vitest";
import { computeReliability, DEFAULT_RELIABILITY } from "../src/reliability";

describe("computeReliability — оси доверия", () => {
  it("малая выборка → низкий confidence, reliable=false", () => {
    const r = computeReliability({
      foldMeans: [0.02, -0.01],
      foldSizes: [2, 3],
      allReturns: [0.05, -0.02, 0.03, 0.01, -0.04],
    });
    expect(r.totalN).toBe(5);
    expect(r.confidence).toBeLessThan(0.3);
    expect(r.reliable).toBe(false);
  });

  it("большая стабильная значимая выборка → высокий confidence, reliable=true", () => {
    // воспроизводимый положительный эдж: каждый фолд в плюс, низкий разброс
    const big = Array.from({ length: 200 }, (_, i) => 0.03 + (i % 5 - 2) * 0.005);
    const r = computeReliability({
      foldMeans: [0.028, 0.031, 0.029, 0.030],
      foldSizes: [50, 50, 50, 50],
      allReturns: big,
    });
    expect(r.totalN).toBe(200);
    expect(r.support).toBeGreaterThan(0.8);
    expect(r.stability).toBeGreaterThan(0.7);
    expect(r.significance).toBeGreaterThan(0.7);
    expect(r.reliable).toBe(true);
  });

  it("confidence МОНОТОННО растёт с объёмом при том же эдже", () => {
    const edge = () => 0.03 + (Math.random() - 0.5) * 0.04;
    const make = (n: number) => {
      const ret = Array.from({ length: n }, edge);
      const folds = 4, seg = Math.floor(n / folds);
      const fm: number[] = [], fs: number[] = [];
      for (let f = 0; f < folds; f++) {
        const slice = ret.slice(f * seg, (f + 1) * seg);
        fm.push(slice.reduce((s, x) => s + x, 0) / slice.length);
        fs.push(slice.length);
      }
      return computeReliability({ foldMeans: fm, foldSizes: fs, allReturns: ret });
    };
    const small = make(12);
    const mid = make(60);
    const large = make(300);
    expect(mid.confidence).toBeGreaterThan(small.confidence);
    expect(large.confidence).toBeGreaterThan(mid.confidence);
  });

  it("reliable переключается false→true при росте выборки", () => {
    const stableEdge = (n: number) => {
      const ret = Array.from({ length: n }, (_, i) => 0.025 + (i % 7 - 3) * 0.003);
      const folds = 4, seg = Math.floor(n / folds);
      const fm: number[] = [], fs: number[] = [];
      for (let f = 0; f < folds; f++) {
        const slice = ret.slice(f * seg, (f + 1) * seg);
        fm.push(slice.reduce((s, x) => s + x, 0) / slice.length);
        fs.push(slice.length);
      }
      return computeReliability({ foldMeans: fm, foldSizes: fs, allReturns: ret });
    };
    expect(stableEdge(16).reliable).toBe(false); // < minN=40
    expect(stableEdge(200).reliable).toBe(true);
  });

  it("большой, но нулевой/шумовой эдж не даёт reliable", () => {
    // объём есть, но среднее ≈ 0 при большом σ → significance низкая
    const noise = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.08 : -0.08));
    const r = computeReliability({
      foldMeans: [0.001, -0.002, 0.0, 0.001],
      foldSizes: [50, 50, 50, 50],
      allReturns: noise,
    });
    expect(r.significance).toBeLessThan(0.2);
    expect(r.reliable).toBe(false);
  });

  it("отрицательный эдж (спам-символ) → significance=0, не reliable", () => {
    const losing = Array.from({ length: 100 }, () => -0.03);
    const r = computeReliability({
      foldMeans: [-0.03, -0.03, -0.03, -0.03],
      foldSizes: [25, 25, 25, 25],
      allReturns: losing,
    });
    expect(r.significance).toBe(0);
    expect(r.confidence).toBe(0);
    expect(r.reliable).toBe(false);
  });
});
