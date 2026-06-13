import { describe, it, expect } from "vitest";
import {
  certifyStrategy, deflatedSharpe, probabilityOfBacktestOverfitting,
  realityCheckPValue, minTrackRecordLength, sharpe,
} from "../../src/statistics";
import {
  edgePresent, edgeAbsent, edgeWithOutlier, regimeShift,
  perfMatrix, candidatePool,
} from "./sequences";

// e2e: аппарат должен СЕРТИФИЦИРОВАТЬ реальный эдж и ОТКАЗАТЬ шуму/выбросу.
// Это главная проверка «edge vs выброс», которую брутфорс-argmax не делает.

describe("E2E: 500 сигналов — Deflated Sharpe отличает эдж от шума", () => {
  it("edge-present → DSR ≥ 0.95 (эдж переживает поправку на N испытаний)", () => {
    const { returns } = edgePresent();
    expect(returns.length).toBe(500);
    expect(deflatedSharpe(returns, 200, 0.01)).toBeGreaterThanOrEqual(0.95);
  });

  it("edge-absent (шум) → DSR ≈ 0 (честный отказ)", () => {
    const { returns } = edgeAbsent();
    expect(deflatedSharpe(returns, 200, 0.01)).toBeLessThan(0.5);
  });

  it("edge-with-outlier → DSR ≈ 0 (эдж держится на 1 точке, не реален)", () => {
    const { returns } = edgeWithOutlier();
    expect(deflatedSharpe(returns, 200, 0.01)).toBeLessThan(0.5);
  });
});

describe("E2E: minTRL — сколько сделок до доверия", () => {
  it("edge-present: minTRL мал, 500 сделок достаточно", () => {
    const { returns } = edgePresent();
    expect(minTrackRecordLength(returns)).toBeLessThan(500);
  });

  it("edge-absent: minTRL огромен (нужно несоизмеримо больше) или Sharpe≈0", () => {
    const { returns } = edgeAbsent();
    const trl = minTrackRecordLength(returns);
    // либо требует много больше 500, либо Sharpe настолько мал что значимость недостижима
    expect(trl).toBeGreaterThan(500);
  });
});

describe("E2E: SPA / Reality Check — data-snooping", () => {
  it("пул из 50 ШУМОВЫХ стратегий → p-value > 0.05 (лучший объясним перебором)", () => {
    const pool = candidatePool(false);
    expect(realityCheckPValue(pool, { bootstraps: 500, seed: 1 })).toBeGreaterThan(0.05);
  });

  it("пул с реальным эджем → p-value ≤ 0.05 (эдж НЕ объясним перебором)", () => {
    const pool = candidatePool(true);
    expect(realityCheckPValue(pool, { bootstraps: 500, seed: 1 })).toBeLessThanOrEqual(0.05);
  });
});

describe("E2E: PBO — оверфит по CSCV", () => {
  it("один реальный конфиг среди шумовых → PBO ≤ 0.10 (эдж переносится OOS)", () => {
    expect(probabilityOfBacktestOverfitting(perfMatrix(true))).toBeLessThanOrEqual(0.10);
  });

  it("все конфиги шумовые → PBO около 0.5 (оверфит)", () => {
    expect(probabilityOfBacktestOverfitting(perfMatrix(false))).toBeGreaterThan(0.3);
  });
});

describe("E2E: полный сертификат certifyStrategy", () => {
  it("РЕАЛЬНЫЙ эдж проходит все 5 барьеров → certified=true", () => {
    const cert = certifyStrategy({
      selectedReturns: edgePresent().returns,
      nTrials: 200,
      varSRAcrossTrials: 0.01,
      perfMatrix: perfMatrix(true),
      candidateReturns: candidatePool(true),
      nestedScore: 0.003,
    });
    expect(cert.certified).toBe(true);
    expect(cert.reasons).toEqual([]);
    expect(cert.dsr).toBeGreaterThanOrEqual(0.95);
    expect(cert.pbo).toBeLessThanOrEqual(0.10);
    expect(cert.spaPValue).toBeLessThanOrEqual(0.05);
    expect(cert.actualN).toBeGreaterThanOrEqual(cert.minTRL);
  });

  it("ЧИСТЫЙ ШУМ отклоняется → certified=false с причинами", () => {
    const cert = certifyStrategy({
      selectedReturns: edgeAbsent().returns,
      nTrials: 200,
      varSRAcrossTrials: 0.01,
      perfMatrix: perfMatrix(false),
      candidateReturns: candidatePool(false),
      nestedScore: 0.0,
    });
    expect(cert.certified).toBe(false);
    expect(cert.reasons.length).toBeGreaterThan(0);
  });

  it("ВЫБРОС-driven эдж отклоняется (mean+, но держится на 1 точке)", () => {
    const cert = certifyStrategy({
      selectedReturns: edgeWithOutlier().returns,
      nTrials: 200,
      varSRAcrossTrials: 0.01,
      perfMatrix: perfMatrix(false),
      candidateReturns: candidatePool(false),
      nestedScore: 0.0,
    });
    expect(cert.certified).toBe(false);
  });

  it("огромный N испытаний (брутфорс 280k) топит DSR даже при положительном mean", () => {
    // тот же эдж, но N=280k испытаний → планка случайности выше → DSR падает
    const r = edgePresent().returns;
    const dsrSmallN = deflatedSharpe(r, 50, 0.01);
    const dsrHugeN = deflatedSharpe(r, 279936, 0.05);
    expect(dsrHugeN).toBeLessThan(dsrSmallN); // брутфорс штрафуется
  });

  it("regime-shift: эдж только в половине — целиком не должен давать ложную уверенность", () => {
    // на всём ряде эдж размыт распадом; проверяем что вторая половина (шум) не сертифицируется
    const { returns } = regimeShift();
    const secondHalf = returns.slice(250);
    expect(deflatedSharpe(secondHalf, 200, 0.01)).toBeLessThan(0.5);
  });
});
