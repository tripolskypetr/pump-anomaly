const BNB_GRID = {
    // === Детектор (matrix) — средне-строгий ===
    windowK:          [3, 4, 6],
    minClusters:      [2, 3],
    jaccardThreshold: [0.29, 0.39, 0.48],
    lagPeakThreshold: [0.40, 0.52, 0.62],

    // === Exit-параметры ===
    trailingTake:         [0.9, 1.4, 2.1, 3.2, 4.5],
    hardStop:             [1.2, 1.9, 2.6, 3.5],
    stalenessSinceProfit: [0.6, 1.1, 1.6],
    stalenessSinceMinutes:[100, 220, 420],
    staleMinutes:         [180, 420, 840, 1440],      // 3ч — 24ч

    // === Каскад и объём ===
    volZThreshold:        [1.6, 2.2, 3.0],
    squeezePolicy:        ["none", "tighten", "veto", "invert"],
    squeezeThreshold:     [0.55, 0.67, 0.79],
    volBaselineWindow:    [20, 35, 50],
    cascadeWindowMinutes: [25, 55, 100, 160],

    // === Стационарность ===
    stationarityWindowMs: [
        10 * 24 * 3600_000,   // 10 дней
        21 * 24 * 3600_000,   // 3 недели
        45 * 24 * 3600_000,   // ~1.5 месяца
        90 * 24 * 3600_000    // 3 месяца
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: BNB_GRID,
    folds: 4,
    shrinkageK: 6,
    mode: "auto",
    maxBurstWindowMs: 8 * 60 * 60 * 1000,   // до 8 часов на всплеск
    viability: {
        minSharedEvents: 4,
        minPeakShare: 0.58,
        minStrongEdges: 1
    }
});
