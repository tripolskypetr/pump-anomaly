const DOT_GRID = {
    // === Детектор (matrix) — строгий ===
    windowK:          [3, 5, 7],
    minClusters:      [2, 3],
    jaccardThreshold: [0.33, 0.43, 0.53],
    lagPeakThreshold: [0.44, 0.55, 0.65],

    // === Exit-параметры — длинные ===
    trailingTake:         [1.0, 1.6, 2.5, 3.8, 5.5],
    hardStop:             [1.5, 2.2, 3.0, 4.2],
    stalenessSinceProfit: [0.7, 1.2, 1.9],
    stalenessSinceMinutes:[150, 300, 600],
    staleMinutes:         [300, 720, 1440, 2160],     // 5ч — 36ч

    // === Каскад и объём ===
    volZThreshold:        [1.7, 2.4, 3.3],
    squeezePolicy:        ["none", "tighten", "veto"],
    squeezeThreshold:     [0.56, 0.68, 0.81],
    volBaselineWindow:    [26, 40, 55],
    cascadeWindowMinutes: [40, 90, 160, 260],

    // === Стационарность — очень длинная ===
    stationarityWindowMs: [
        21 * 24 * 3600_000,   // 3 недели
        45 * 24 * 3600_000,   // ~1.5 месяца
        90 * 24 * 3600_000,   // 3 месяца
        180 * 24 * 3600_000   // 6 месяцев
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: DOT_GRID,
    folds: 4,
    shrinkageK: 5,
    mode: "auto",
    maxBurstWindowMs: 36 * 60 * 60 * 1000,   // до 36 часов на всплеск
    viability: {
        minSharedEvents: 4,
        minPeakShare: 0.61,
        minStrongEdges: 2
    }
});
