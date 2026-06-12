import { describe, it, expect } from "vitest";
import { computeReliability } from "../src/reliability";
import { intersectPolicy } from "../src/signal";

describe("РЕГРЕССИЯ — significance не максимизируется на нулевой дисперсии", () => {
  it("80 ИДЕНТИЧНЫХ ретёрнов → НЕ reliable (вырожденные данные, не эдж)", () => {
    const r = computeReliability({
      foldMeans: [0.001, 0.001, 0.001, 0.001], foldSizes: [20, 20, 20, 20],
      allReturns: Array(80).fill(0.001),
    });
    // раньше significance=1 → confidence 0.73 → reliable=true (ЛОЖНО)
    expect(r.significance).toBeLessThan(0.6);
    expect(r.reliable).toBe(false);
  });

  it("околонулевая дисперсия (floating-point dust) тоже ловится", () => {
    // std([0.001]×N) даёт ~1e-19, не ровно 0 — порог должен быть относительным
    const r = computeReliability({
      foldMeans: [0.002, 0.002], foldSizes: [40, 40],
      allReturns: Array(80).fill(0.002),
    });
    expect(r.significance).toBeLessThan(0.6); // не максимум
  });

  it("настоящий эдж с разбросом → significance высокий, reliable=true", () => {
    const good = Array(80).fill(0).map((_, i) => 0.03 + (i % 3 === 0 ? 0.01 : -0.005));
    const r = computeReliability({
      foldMeans: [0.025, 0.028, 0.026, 0.027], foldSizes: [20, 20, 20, 20], allReturns: good,
    });
    expect(r.significance).toBeGreaterThan(0.9);
    expect(r.reliable).toBe(true);
  });

  it("отрицательный эдж → significance=0", () => {
    const r = computeReliability({
      foldMeans: [-0.01, -0.01], foldSizes: [40, 40], allReturns: Array(80).fill(-0.01),
    });
    expect(r.significance).toBe(0);
  });

  it("значимость нулевой дисперсии растёт с N, но медленно", () => {
    const sig = (n: number) => computeReliability({
      foldMeans: [0.001], foldSizes: [n], allReturns: Array(n).fill(0.001),
    }).significance;
    expect(sig(40)).toBeLessThan(sig(200)); // больше идентичных → чуть выше, но не сразу 1
    expect(sig(40)).toBeLessThan(0.3);
  });
});

describe("РЕГРЕССИЯ — intersectPolicy: minRiskReward только ужесточается", () => {
  it("запрос НЕ может ослабить вшитый RR-порог (max, не replace)", () => {
    const p = intersectPolicy({ allow: ["enter"], minRiskReward: 2 }, { minRiskReward: 0.5 });
    expect(p.minRiskReward).toBe(2); // остался строгий, не ослаблен до 0.5
  });
  it("запрос МОЖЕТ ужесточить RR-порог", () => {
    const p = intersectPolicy({ allow: ["enter"], minRiskReward: 2 }, { minRiskReward: 3 });
    expect(p.minRiskReward).toBe(3);
  });
  it("только обученный порог → проходит", () => {
    expect(intersectPolicy({ allow: ["enter"], minRiskReward: 2 }, {}).minRiskReward).toBe(2);
  });
  it("только запрошенный порог → проходит", () => {
    expect(intersectPolicy({ allow: ["enter"] }, { minRiskReward: 1.5 }).minRiskReward).toBe(1.5);
  });
  it("allow дедуплицируется", () => {
    const p = intersectPolicy({ allow: ["enter", "invert"] }, { allow: ["enter", "enter", "enter"] });
    expect(p.allow).toEqual(["enter"]);
  });
  it("запрос не может расширить allow (инвариант сужения сохранён)", () => {
    const p = intersectPolicy({ allow: ["enter"] }, { allow: ["enter", "invert", "tighten"] });
    expect(p.allow).toEqual(["enter"]);
  });
});
