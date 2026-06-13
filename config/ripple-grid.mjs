const RIPPLE_GRID = {
    // === Детектор (matrix) — строже ===
    windowK:          [3, 5, 7],
    minClusters:      [2, 3],
    jaccardThreshold: [0.30, 0.40, 0.50],           // выше порог — нужен качественный сигнал
    lagPeakThreshold: [0.42, 0.52, 0.62],

    // === Exit-параметры — длиннее горизонты ===
    trailingTake:         [0.9, 1.4, 2.2, 3.5, 5.0],
    hardStop:             [1.3, 2.0, 2.8, 4.0],
    stalenessSinceProfit: [0.6, 1.1, 1.7],
    stalenessSinceMinutes:[120, 240, 480],
    staleMinutes:         [180, 480, 960, 1440],      // 3ч — 24ч (иногда дольше)

    // === Каскад и объём — умеренная чувствительность ===
    volZThreshold:        [1.7, 2.3, 3.2],
    squeezePolicy:        ["none", "tighten", "veto"], // invert реже полезен
    squeezeThreshold:     [0.57, 0.68, 0.80],
    volBaselineWindow:    [25, 40],
    cascadeWindowMinutes: [30, 60, 120, 180],

    // === Стационарность — длинные окна ===
    stationarityWindowMs: [
        14 * 24 * 3600_000,   // 2 недели
        30 * 24 * 3600_000,   // ~1 месяц
        60 * 24 * 3600_000,   // 2 месяца
        90 * 24 * 3600_000    // 3 месяца
    ],
};
