const BTC_GRID = {
    // === Детектор (matrix) — очень строгий ===
    windowK:          [4, 6, 8],
    minClusters:      [2, 3],
    jaccardThreshold: [0.35, 0.45, 0.55],
    lagPeakThreshold: [0.45, 0.56, 0.66],

    // === Exit-параметры — самые длинные ===
    trailingTake:         [1.2, 2.0, 3.0, 4.5, 7.0],
    hardStop:             [1.8, 2.5, 3.5, 5.0],
    stalenessSinceProfit: [0.8, 1.4, 2.2],
    stalenessSinceMinutes:[180, 360, 720],
    staleMinutes:         [360, 960, 1800, 2880],     // 6ч — 48ч (иногда дольше)

    // === Каскад и объём — консервативно ===
    volZThreshold:        [1.8, 2.5, 3.5],
    squeezePolicy:        ["none", "tighten", "veto"],
    squeezeThreshold:     [0.58, 0.70, 0.82],
    volBaselineWindow:    [30, 45, 60],
    cascadeWindowMinutes: [45, 100, 180, 300],

    // === Стационарность — очень длинная ===
    stationarityWindowMs: [
        30 * 24 * 3600_000,   // 1 месяц
        60 * 24 * 3600_000,   // 2 месяца
        120 * 24 * 3600_000,  // 4 месяца
        180 * 24 * 3600_000   // 6 месяцев
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: BTC_GRID,
    folds: 5,
    shrinkageK: 6,
    mode: "auto",
    maxBurstWindowMs: 48 * 60 * 60 * 1000,   // до 48 часов на всплеск
    viability: {
        minSharedEvents: 5,
        minPeakShare: 0.62,
        minStrongEdges: 2
    }
});
