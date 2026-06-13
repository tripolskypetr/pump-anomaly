const RECOMMENDED_GRID = {
    // === Детектор (matrix) ===
    windowK:          [2, 3, 4],                    // чуть плотнее, чем дефолт
    minClusters:      [2, 3],                       // оставляем
    jaccardThreshold: [0.25, 0.35, 0.45],           // расширил вниз — на Solana часто шум
    lagPeakThreshold: [0.35, 0.45, 0.55],           // расширил

    // === Exit-параметры (самое важное) ===
    trailingTake:         [0.6, 1.0, 1.5, 2.2],     // более мелкий шаг в прибыльной зоне
    hardStop:             [0.8, 1.3, 1.8, 2.5],     // Solana очень волатильна — добавил 0.8
    stalenessSinceProfit: [0.4, 0.8, 1.3],          
    stalenessSinceMinutes:[45, 90, 180],            // короче, чем в дефолте
    staleMinutes:         [45, 120, 240, 480],      // 45 мин — 8 часов (Solana-пампы быстрые)

    // === Каскад и объём ===
    volZThreshold:        [1.4, 2.0, 2.8],          // чуть мягче
    squeezePolicy:        ["none", "tighten", "veto", "invert"], 
    squeezeThreshold:     [0.5, 0.62, 0.75],        // более мелкий шаг
    volBaselineWindow:    [15, 25],                 // добавил 15 (быстрее реагирует)
    cascadeWindowMinutes: [10, 20, 40],             // короче окна — Solana очень быстрая

    // === Стационарность ===
    stationarityWindowMs: [
        4 * 24 * 3600_000,   // 4 дня
        7 * 24 * 3600_000,   // 1 неделя
        14 * 24 * 3600_000,  // 2 недели
        28 * 24 * 3600_000   // 4 недели
    ],
};
