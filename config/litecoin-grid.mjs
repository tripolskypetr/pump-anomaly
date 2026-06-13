const LTC_GRID = {
    // === Детектор (matrix) — строгий ===
    windowK:          [3, 5, 7],
    minClusters:      [2, 3],
    jaccardThreshold: [0.31, 0.41, 0.50],
    lagPeakThreshold: [0.42, 0.53, 0.63],

    // === Exit-параметры — длинные горизонты ===
    trailingTake:         [0.9, 1.5, 2.3, 3.5, 5.0],
    hardStop:             [1.3, 2.0, 2.8, 3.8],
    stalenessSinceProfit: [0.7, 1.2, 1.8],
    stalenessSinceMinutes:[120, 280, 550],
    staleMinutes:         [240, 600, 1080, 1800],     // 4ч — 30ч

    // === Каскад и объём — консервативно ===
    volZThreshold:        [1.7, 2.3, 3.1],
    squeezePolicy:        ["none", "tighten", "veto"],
    squeezeThreshold:     [0.56, 0.68, 0.80],
    volBaselineWindow:    [24, 38, 55],
    cascadeWindowMinutes: [35, 75, 140, 220],

    // === Стационарность — длинная ===
    stationarityWindowMs: [
        14 * 24 * 3600_000,   // 2 недели
        30 * 24 * 3600_000,   // 1 месяц
        60 * 24 * 3600_000,   // 2 месяца
        120 * 24 * 3600_000   // 4 месяца
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: LTC_GRID,
    folds: 4,
    shrinkageK: 5,
    mode: "auto",
    maxBurstWindowMs: 18 * 60 * 60 * 1000,   // до 18 часов на всплеск
    viability: {
        minSharedEvents: 4,
        minPeakShare: 0.60,
        minStrongEdges: 2
    }
});

