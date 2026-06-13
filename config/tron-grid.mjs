const TRX_GRID = {
    // === Детектор (matrix) ===
    windowK:          [3, 4, 5],
    minClusters:      [2, 3],
    jaccardThreshold: [0.27, 0.37, 0.47],
    lagPeakThreshold: [0.38, 0.50, 0.60],

    // === Exit-параметры ===
    trailingTake:         [0.7, 1.1, 1.6, 2.4, 3.5],
    hardStop:             [1.0, 1.6, 2.3, 3.0],
    stalenessSinceProfit: [0.5, 0.9, 1.4],
    stalenessSinceMinutes:[60, 150, 280],
    staleMinutes:         [90, 240, 480, 900],        // 1.5ч — 15ч (оптимальный диапазон)

    // === Каскад и объём ===
    volZThreshold:        [1.45, 2.05, 2.8],
    squeezePolicy:        ["none", "tighten", "veto", "invert"],
    squeezeThreshold:     [0.52, 0.64, 0.76],
    volBaselineWindow:    [16, 26, 35],
    cascadeWindowMinutes: [18, 40, 75, 110],

    // === Стационарность ===
    stationarityWindowMs: [
        7 * 24 * 3600_000,   // 1 неделя
        14 * 24 * 3600_000,  // 2 недели
        28 * 24 * 3600_000,  // 4 недели
        45 * 24 * 3600_000   // ~1.5 месяца
    ],
};
