const DOGE_GRID = {
    // === Детектор (matrix) — средняя строгость ===
    windowK:          [3, 4, 6],
    minClusters:      [2, 3],
    jaccardThreshold: [0.26, 0.36, 0.46],
    lagPeakThreshold: [0.38, 0.50, 0.60],

    // === Exit-параметры ===
    trailingTake:         [0.8, 1.2, 1.8, 2.8, 4.0],
    hardStop:             [1.1, 1.7, 2.4, 3.2],
    stalenessSinceProfit: [0.5, 1.0, 1.5],
    stalenessSinceMinutes:[75, 150, 300],
    staleMinutes:         [90, 240, 480, 960],        // 1.5ч — 16ч (достаточно широкий диапазон)

    // === Каскад и объём ===
    volZThreshold:        [1.5, 2.1, 2.9],
    squeezePolicy:        ["none", "tighten", "veto", "invert"],
    squeezeThreshold:     [0.53, 0.64, 0.76],
    volBaselineWindow:    [18, 28, 40],
    cascadeWindowMinutes: [20, 45, 80, 120],

    // === Стационарность ===
    stationarityWindowMs: [
        7 * 24 * 3600_000,   // 1 неделя
        14 * 24 * 3600_000,  // 2 недели
        28 * 24 * 3600_000,  // 4 недели
        60 * 24 * 3600_000   // ~2 месяца
    ],
};