const FARTCOIN_GRID = {
    // === Детектор (matrix) — мягкий, т.к. очень много шума ===
    windowK:          [2, 3, 4],
    minClusters:      [2, 3],
    jaccardThreshold: [0.20, 0.30, 0.42],           // низкий порог — ловим быстрые всплески
    lagPeakThreshold: [0.30, 0.45, 0.55],

    // === Exit — максимально короткий горизонт ===
    trailingTake:         [0.5, 0.8, 1.2, 1.7, 2.4],
    hardStop:             [0.65, 1.0, 1.4, 2.0],      // жёсткие стопы
    stalenessSinceProfit: [0.3, 0.6, 1.0],
    stalenessSinceMinutes:[25, 50, 100],
    staleMinutes:         [25, 60, 120, 240],         // 25 мин — 4 часа (основной диапазон)

    // === Каскад и объём — высокая чувствительность ===
    volZThreshold:        [1.25, 1.8, 2.6],           // рано замечаем объёмный вход
    squeezePolicy:        ["none", "tighten", "veto", "invert"], 
    squeezeThreshold:     [0.47, 0.59, 0.72],         // очень чувствительно
    volBaselineWindow:    [10, 18, 28],               // быстро реагируем
    cascadeWindowMinutes: [8, 15, 25, 40],            // короткие окна

    // === Стационарность — меняется очень быстро ===
    stationarityWindowMs: [
        3 * 24 * 3600_000,   // 3 дня
        6 * 24 * 3600_000,   // 6 дней
        12 * 24 * 3600_000,  // ~12 дней
        21 * 24 * 3600_000   // 3 недели
    ],
};

const model = await PumpMatrix.fit(history, getCandles, {
    grid: FARTCOIN_GRID,
    folds: 5,                          // больше фолдов из-за волатильности
    shrinkageK: 8,                     // сильная усадка (много выбросов)
    mode: "auto",
    maxBurstWindowMs: 90 * 60 * 1000,  // максимум 1.5 часа на всплеск
    viability: {
        minSharedEvents: 3,
        minPeakShare: 0.50,            // чуть мягче
    }
});
