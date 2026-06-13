const HYPE_GRID = {
    // === Детектор (matrix) — чуть мягче, т.к. на HYPE много шума ===
    windowK:          [2, 3, 4],
    minClusters:      [2, 3],
    jaccardThreshold: [0.22, 0.32, 0.42],           // ниже, чтобы ловить всплески
    lagPeakThreshold: [0.30, 0.45, 0.55],

    // === Exit — важно держать короткие горизонты ===
    trailingTake:         [0.5, 0.8, 1.2, 1.8, 2.5],   // мелкий шаг в зоне 0.5-1.8
    hardStop:             [0.7, 1.0, 1.4, 2.0],        // жёстче стопы
    stalenessSinceProfit: [0.3, 0.6, 1.0],
    stalenessSinceMinutes:[30, 60, 120],
    staleMinutes:         [30, 60, 120, 240],          // максимум 4 часа

    // === Каскад и объём — самые важные для HYPE ===
    volZThreshold:        [1.3, 1.8, 2.6],             // раньше замечаем объём
    squeezePolicy:        ["none", "tighten", "veto", "invert"], 
    squeezeThreshold:     [0.48, 0.60, 0.72],          // чувствительнее
    volBaselineWindow:    [12, 20, 30],                // быстрее реагируем
    cascadeWindowMinutes: [8, 15, 25, 40],             // очень короткие окна

    // === Стационарность — HYPE меняется быстро ===
    stationarityWindowMs: [
        3 * 24 * 3600_000,   // 3 дня
        5 * 24 * 3600_000,   // 5 дней
        10 * 24 * 3600_000,  // ~1.5 недели
        21 * 24 * 3600_000   // 3 недели
    ],
};