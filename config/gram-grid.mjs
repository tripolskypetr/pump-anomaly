const TON_GRID = {
    // === Детектор (matrix) ===
    windowK:          [2, 3, 5],
    minClusters:      [2, 3],
    jaccardThreshold: [0.25, 0.35, 0.45],
    lagPeakThreshold: [0.35, 0.48, 0.58],

    // === Exit-параметры (основной фокус) ===
    trailingTake:         [0.7, 1.1, 1.6, 2.3, 3.5],
    hardStop:             [1.0, 1.5, 2.2, 3.0],
    stalenessSinceProfit: [0.5, 0.9, 1.4],
    stalenessSinceMinutes:[60, 120, 240],
    staleMinutes:         [60, 180, 360, 720],        // 1ч — 12ч (основной диапазон)

    // === Каскад и объём ===
    volZThreshold:        [1.4, 2.0, 2.7],
    squeezePolicy:        ["none", "tighten", "veto", "invert"],
    squeezeThreshold:     [0.52, 0.63, 0.75],
    volBaselineWindow:    [15, 25, 35],
    cascadeWindowMinutes: [15, 30, 60, 90],

    // === Стационарность (TON развивается быстро) ===
    stationarityWindowMs: [
        5 * 24 * 3600_000,   // 5 дней
        10 * 24 * 3600_000,  // ~1.5 недели
        21 * 24 * 3600_000,  // 3 недели
        42 * 24 * 3600_000   // 6 недель
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: TON_GRID,
    folds: 4,
    shrinkageK: 6,
    mode: "auto",
    maxBurstWindowMs: 3 * 60 * 60 * 1000,     // до 3 часов на один всплеск
    viability: {
        minSharedEvents: 3,
        minPeakShare: 0.55,
        minStrongEdges: 1
    }
});
