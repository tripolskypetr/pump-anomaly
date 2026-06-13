import { describe, it, expect } from "vitest";
import {
  emptyLedger, recordAttempt, canRefit, effectiveTrials, fitAttemptCount,
  DEFAULT_META_POLICY, deflatedSharpe, mulberry32,
} from "../src/index";

function gauss(rng: () => number) {
  let sp: number | null = null;
  return () => { if (sp !== null) { const s = sp; sp = null; return s; } let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); const m = Math.sqrt(-2 * Math.log(u)); sp = m * Math.sin(2 * Math.PI * v); return m * Math.cos(2 * Math.PI * v); };
}

describe("cadence guard — запрет частого переобучения", () => {
  it("первый fit всегда разрешён", () => {
    expect(canRefit(emptyLedger(), Date.now()).allowed).toBe(true);
  });
  it("refit через час после последнего — ЗАПРЕЩЁН (неделя по умолчанию)", () => {
    const t = Date.now();
    const led = recordAttempt(emptyLedger(), { ts: t, innerTrials: 200, certifiedNaive: false });
    expect(canRefit(led, t + 3600_000).allowed).toBe(false);
  });
  it("refit через неделю+ — разрешён", () => {
    const t = Date.now();
    const led = recordAttempt(emptyLedger(), { ts: t, innerTrials: 200, certifiedNaive: false });
    expect(canRefit(led, t + DEFAULT_META_POLICY.minRefitMs + 1).allowed).toBe(true);
  });
  it("nextAllowedTs = последний + minRefitMs", () => {
    const t = 1_000_000;
    const led = recordAttempt(emptyLedger(), { ts: t, innerTrials: 200, certifiedNaive: false });
    expect(canRefit(led, t + 100).nextAllowedTs).toBe(t + DEFAULT_META_POLICY.minRefitMs);
  });
});

describe("family-wise: effectiveTrials суммирует ВСЕ fit-попытки", () => {
  it("без прошлых попыток = текущий грид", () => {
    expect(effectiveTrials(emptyLedger(), 200)).toBe(200);
  });
  it("720 прошлых fit × 200 + текущий 200 = огромный effN", () => {
    let led = emptyLedger();
    for (let i = 0; i < 720; i++) led = recordAttempt(led, { ts: i, innerTrials: 200, certifiedNaive: false });
    expect(effectiveTrials(led, 200)).toBe(720 * 200 + 200);
  });
  it("логируются ВСЕ попытки, не только certified (честный знаменатель)", () => {
    let led = emptyLedger();
    led = recordAttempt(led, { ts: 1, innerTrials: 100, certifiedNaive: false }); // не прошёл
    led = recordAttempt(led, { ts: 2, innerTrials: 100, certifiedNaive: true });  // прошёл
    expect(fitAttemptCount(led)).toBe(2);
    expect(effectiveTrials(led, 100)).toBe(300); // оба учтены
  });
});

describe("МЕТА-winner's-curse: family-wise поправка топит ложный эдж от частых refit", () => {
  it("720 fit на коротком шуме: мета-DSR срезает ложные сертификаты, что пропустил наивный", () => {
    const FITS = 720, INNER = 50;
    let naive = 0, meta = 0;
    for (let f = 0; f < FITS; f++) {
      const g = gauss(mulberry32(80000 + f));
      let best: number[] = []; let bs = -Infinity;
      for (let c = 0; c < INNER; c++) { const r = Array.from({ length: 60 }, () => g() * 0.01); const m = r.reduce((s, x) => s + x, 0) / r.length; if (m > bs) { bs = m; best = r; } }
      if (deflatedSharpe(best, INNER, 0.02) >= 0.95) naive++;
      if (deflatedSharpe(best, INNER * FITS, 0.02) >= 0.95) meta++;
    }
    expect(naive).toBeGreaterThan(0);   // наивный пропускает ложные эджи
    expect(meta).toBeLessThan(naive);   // мета-поправка их срезает
    expect(meta).toBe(0);               // до нуля
  });

  it("СИЛЬНЫЙ эдж (0.75σ, 500 сделок) переживает даже 720 fit (поправка не топит реальное)", () => {
    const g = gauss(mulberry32(9));
    const strong = Array.from({ length: 500 }, () => 0.006 + g() * 0.008);
    let led = emptyLedger();
    for (let i = 0; i < 720; i++) led = recordAttempt(led, { ts: i, innerTrials: 200, certifiedNaive: false });
    expect(deflatedSharpe(strong, effectiveTrials(led, 200), 0.01)).toBeGreaterThanOrEqual(0.95);
  });
});
