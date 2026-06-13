const LINK_GRID = {
    // === Детектор (matrix) — строгий ===
    windowK:          [3, 5, 7],
    minClusters:      [2, 3],
    jaccardThreshold: [0.32, 0.42, 0.52],
    lagPeakThreshold: [0.43, 0.54, 0.64],

    // === Exit-параметры — средне-длинные ===
    trailingTake:         [1.0, 1.6, 2.4, 3.8, 5.5],
    hardStop:             [1.4, 2.1, 2.9, 4.0],
    stalenessSinceProfit: [0.7, 1.2, 1.8],
    stalenessSinceMinutes:[140, 280, 520],
    staleMinutes:         [300, 660, 1200, 1920],     // 5ч — 32ч

    // === Каскад и объём ===
    volZThreshold:        [1.65, 2.3, 3.2],
    squeezePolicy:        ["none", "tighten", "veto"],
    squeezeThreshold:     [0.55, 0.67, 0.80],
    volBaselineWindow:    [24, 38, 52],
    cascadeWindowMinutes: [35, 80, 150, 240],

    // === Стационарность — длинная ===
    stationarityWindowMs: [
        18 * 24 * 3600_000,   // ~18 дней
        35 * 24 * 3600_000,   // 5 недель
        70 * 24 * 3600_000,   // 10 недель
        120 * 24 * 3600_000   // 4 месяца
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: LINK_GRID,
    folds: 4,
    shrinkageK: 5,
    mode: "auto",
    maxBurstWindowMs: 24 * 60 * 60 * 1000,   // до 24 часов на всплеск
    viability: {
        minSharedEvents: 4,
        minPeakShare: 0.60,
        minStrongEdges: 2
    }
});
