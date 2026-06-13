const ZEC_GRID = {
    // === Детектор (matrix) — средне-строгий ===
    windowK:          [3, 5, 7],
    minClusters:      [2, 3],
    jaccardThreshold: [0.30, 0.40, 0.50],
    lagPeakThreshold: [0.40, 0.52, 0.63],

    // === Exit-параметры ===
    trailingTake:         [0.9, 1.5, 2.4, 3.6, 5.5],
    hardStop:             [1.4, 2.2, 3.0, 4.2],
    stalenessSinceProfit: [0.6, 1.1, 1.7],
    stalenessSinceMinutes:[130, 260, 500],
    staleMinutes:         [240, 540, 960, 1680],      // 4ч — 28ч

    // === Каскад и объём ===
    volZThreshold:        [1.65, 2.25, 3.1],
    squeezePolicy:        ["none", "tighten", "veto"],
    squeezeThreshold:     [0.54, 0.66, 0.79],
    volBaselineWindow:    [22, 36, 50],
    cascadeWindowMinutes: [30, 70, 130, 200],

    // === Стационарность ===
    stationarityWindowMs: [
        14 * 24 * 3600_000,   // 2 недели
        28 * 24 * 3600_000,   // 4 недели
        56 * 24 * 3600_000,   // 8 недель
        100 * 24 * 3600_000   // ~3.5 месяца
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: ZEC_GRID,
    folds: 4,
    shrinkageK: 6,
    mode: "auto",
    maxBurstWindowMs: 12 * 60 * 60 * 1000,   // до 12 часов на всплеск
    viability: {
        minSharedEvents: 4,
        minPeakShare: 0.58,
        minStrongEdges: 2
    }
});
