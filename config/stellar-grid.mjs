const STELLAR_GRID = {
    // === Детектор (matrix) — строгий ===
    windowK:          [3, 5, 7],
    minClusters:      [2, 3],
    jaccardThreshold: [0.32, 0.42, 0.52],           // высокий порог — качество важнее количества
    lagPeakThreshold: [0.45, 0.55, 0.65],

    // === Exit-параметры — длинные ===
    trailingTake:         [1.0, 1.5, 2.3, 3.5, 5.0],
    hardStop:             [1.4, 2.1, 2.9, 4.0],
    stalenessSinceProfit: [0.7, 1.2, 1.8],
    stalenessSinceMinutes:[150, 300, 600],
    staleMinutes:         [240, 600, 1080, 1800],     // 4ч — 30ч (достаточно длинные)

    // === Каскад и объём — консервативно ===
    volZThreshold:        [1.8, 2.4, 3.3],
    squeezePolicy:        ["none", "tighten", "veto"], // invert почти не нужен
    squeezeThreshold:     [0.58, 0.70, 0.82],
    volBaselineWindow:    [25, 40, 55],
    cascadeWindowMinutes: [40, 80, 150, 240],

    // === Стационарность — длинная ===
    stationarityWindowMs: [
        21 * 24 * 3600_000,   // 3 недели
        42 * 24 * 3600_000,   // 6 недель
        75 * 24 * 3600_000,   // ~2.5 месяца
        120 * 24 * 3600_000   // 4 месяца
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: STELLAR_GRID,
    folds: 4,
    shrinkageK: 5,
    mode: "auto",
    maxBurstWindowMs: 18 * 60 * 60 * 1000,   // до 18 часов на всплеск
    viability: {
        minSharedEvents: 4,
        minPeakShare: 0.62,
        minStrongEdges: 2
    }
});
