import { describe, it, expect } from "vitest";
import { deflatedSharpe, minTrackRecordLength, mulberry32 } from "../src/statistics";

// Эти тесты НЕ зависят от подобранных seed: гоняют десятки независимых seed и
// проверяют СТАТИСТИЧЕСКОЕ поведение (доля прошедших), а не один счастливый прогон.
// Если бы аппарат был подогнан под мою синтетику — доли бы развалились.
function gauss(rng: () => number) {
  let sp: number | null = null;
  return () => {
    if (sp !== null) { const s = sp; sp = null; return s; }
    let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng();
    const m = Math.sqrt(-2 * Math.log(u)); sp = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v);
  };
}

describe("РОБАСТНОСТЬ: аппарат не подогнан под конкретные seed", () => {
  it("реальный эдж +0.4σ сертифицируется на БОЛЬШИНСТВЕ из 30 независимых seed (≥22/30)", () => {
    let pass = 0;
    for (let seed = 10000; seed < 10030; seed++) {
      const g = gauss(mulberry32(seed));
      const r = Array.from({ length: 500 }, () => 0.004 + g() * 0.01);
      if (deflatedSharpe(r, 200, 0.01) >= 0.95) pass++;
    }
    expect(pass).toBeGreaterThanOrEqual(22); // не требуем 30/30 — честный тест иногда промахивается
  });

  it("чистый шум НЕ сертифицируется НИ НА ОДНОМ из 30 seed (0 ложных)", () => {
    let falsePositive = 0;
    for (let seed = 20000; seed < 20030; seed++) {
      const g = gauss(mulberry32(seed));
      const r = Array.from({ length: 500 }, () => g() * 0.01);
      if (deflatedSharpe(r, 200, 0.01) >= 0.95) falsePositive++;
    }
    expect(falsePositive).toBe(0); // НИ ОДНОГО ложного сертификата шума
  });

  it("монотонная градация: сила эджа → доля сертификаций растёт", () => {
    const rate = (em: number) => {
      let p = 0;
      for (let seed = 30000; seed < 30020; seed++) {
        const g = gauss(mulberry32(seed));
        const r = Array.from({ length: 500 }, () => em + g() * 0.01);
        if (deflatedSharpe(r, 200, 0.01) >= 0.95) p++;
      }
      return p / 20;
    };
    const r0 = rate(0), r02 = rate(0.002), r05 = rate(0.005);
    expect(r0).toBe(0);                  // 0σ → никогда
    expect(r05).toBeGreaterThan(r02);    // монотонно растёт
    expect(r05).toBeGreaterThanOrEqual(0.9); // сильный эдж → почти всегда
  });

  it("брутфорс N=280k штрафуется сильнее урезанного N=50 на ТОМ ЖЕ эдже", () => {
    let hugeStricter = 0;
    for (let seed = 40000; seed < 40020; seed++) {
      const g = gauss(mulberry32(seed));
      const r = Array.from({ length: 300 }, () => 0.004 + g() * 0.01);
      if (deflatedSharpe(r, 279936, 0.05) < deflatedSharpe(r, 50, 0.02)) hugeStricter++;
    }
    expect(hugeStricter).toBeGreaterThanOrEqual(18); // брутфорс почти всегда строже
  });

  it("minTRL растёт при ослаблении эджа (нужно больше сделок)", () => {
    const trl = (em: number) => {
      const g = gauss(mulberry32(55555));
      const r = Array.from({ length: 500 }, () => em + g() * 0.01);
      return minTrackRecordLength(r);
    };
    expect(trl(0.002)).toBeGreaterThan(trl(0.006)); // слабее эдж → больше сделок надо
  });
});
