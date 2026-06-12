# pump-matrix

Чёрная коробка для детекции **синхронного памп-сигнала** по потоку торговых рекомендаций из Telegram-каналов и превращения его в готовый к исполнению план сделки.

Решает три задачи:

1. **Отделяет реальный приток капитала** (несколько независимых авторов синхронно бьют в тикер) от манипуляции одного актора за несколькими анонимными каналами.
2. **Отделяет памп от stop hunting** — ловушек, где сигнал ведёт толпу в плечо, чтобы снести её каскадом ликвидаций. Метку обучения ставит симуляция твоего prod-выхода по 1m-свечам, а не close-to-close.
3. **Выдаёт ready-to-trade план** с обученными exit-параметрами (trailing take / hard stop / импакт-горизонт), подобранными отдельно под каждый источник.

Совместима со схемой `parser-items` (`channel`, `symbol`, `direction`, `entry:{from,to}`, …).

## Установка и запуск

```bash
npm i
npm run build   # tsc -p tsconfig.json
npm test        # vitest run — 387 тестов
```

Стек: TypeScript + vitest, без CLI и монорепо. Единственная публичная точка входа высокого уровня — класс `PumpMatrix`.

## Быстрый старт

```ts
import { PumpMatrix } from "pump-matrix";
import * as fs from "fs";

// 1) обучить один раз на истории (метку ставит симуляция твоего prod-выхода)
const model = await PumpMatrix.fit(history, getCandles);
fs.writeFileSync("model.json", model.save());

// 2) в проде — без обучения
const model = PumpMatrix.load(fs.readFileSync("model.json", "utf8"));

// signals() возвращает ТОЛЬКО исполняемое — veto уже отфильтрован
const trades = model.signals(liveItems);
// со свечами добавляется volRegime + детекция каскада:
const trades = model.plan(liveItems, { SOLUSDT: solCandles, TRXUSDT: trxCandles });

for (const s of trades) {
  openPosition(s.symbol, s.direction, s.exit); // direction развёрнут при инверсии; exit готов
}
```

`signals`/`plan` думают сами: выбирают режим, считают volRegime, оценивают каскад, фильтруют veto, разворачивают инверсию. Приложение исполняет `s.direction` с `s.exit` — никаких `if` про veto, инверсию или режим.

## Контракт входных данных

### ParserItem (сигнал канала)

```ts
interface ParserItem {
  channel: string;
  symbol: string;
  direction: "long" | "short";
  ts: number;               // unix-время публикации, мс
  entryFromPrice?: number;  // нижняя граница зоны входа (entry.from)
  entryToPrice?: number;    // верхняя граница зоны входа (entry.to)
  [extra: string]: unknown; // targets/stoploss/… допускаются и игнорируются
}
```

`channel` обязателен — это ключ exit-тензора. Зона входа (`entryFromPrice`/`entryToPrice`) маппится из `entry:{from,to}` твоих parser-items; если не задана — вход по open первой свечи.

### getCandles (источник свечей)

```ts
type CandleInterval = "1m"|"3m"|"5m"|"15m"|"30m"|"1h"|"2h"|"4h"|"6h"|"8h"|"1d";

interface ICandleData {
  timestamp: number; // unix ms, момент ОТКРЫТИЯ свечи
  open: number; high: number; low: number; close: number; volume: number;
}

type GetCandles = (
  symbol: string,
  interval: CandleInterval,
  limit?: number,
  sDate?: number,  // inclusive
  eDate?: number,  // exclusive
) => Promise<ICandleData[]>;
```

Семантика диапазонов:

```
(limit)               → [align(now) − limit·step, align(now))
(limit, sDate)        → [align(sDate), align(sDate) + limit·step)
(limit, _, eDate)     → [align(eDate) − limit·step, eDate)
(_, sDate, eDate)     → [align(sDate), eDate), limit из диапазона
(limit, sDate, eDate) → [align(sDate), …), ровно limit свечей
```

Обучение размечает по `1m`-свечам, поэтому твой `getCandles` должен уметь их отдавать.

## Как ставится метка (stop hunting не пройдёт)

Метку обучения ставит **точная симуляция твоего prod-выхода по 1m-свечам** (`replayExit`), а не close-to-close. Перенесено из твоего кода один-в-один:

- **moonbag** (long) — hard stop ниже входа; **gravebag** (short) — выше.
- **trailing take** — откат от пикового PnL при `currentProfit ≥ 0`.
- **peak staleness** — пик достиг порога прибыли, но протух за `stalenessSinceMinutes` без нового максимума (цена может вообще не идти к цели).
- **life-cap** (`staleMinutes`) — потолок жизни позиции = **эмпирический импакт-горизонт**, подбирается grid'ом.
- Выбивание по SL **откатывает метрику к последнему плюсовому trailing-пику**.

Почему ловит stop hunt: прокол в ловушке не дотягивает до trailingTake, а откат бьёт hard stop → метка отрицательная, **даже если** `close[t+H]` случайно положительный. Path-aware replay видит весь путь по OHLC, а не две точки.

**Свечи и боковик.** Под каждый кандидат `labelBurst` запрашивает `1m`-свечи вперёд от события на `staleMinutes·2+5` (запас на поздний вход в зону). Если это больше лимита чанка (500), либа **сама бьёт запрос на чанки** (`fetchCandlesChunked`), двигая since вперёд и склеивая с дедупом по timestamp — не зависит от того, пагинирует твой адаптер или нет. Два защитных контура:

- **Ошибка адаптера** (look-ahead guard на хвосте истории, дыра в данных символа — частое у меме-коинов) перехватывается: кандидат пропускается, обучение не падает. Один битый символ не роняет весь `fit`.
- **Усечённый горизонт.** В долгом боковике вход может случиться поздно, и после него не хватит свечей на полный life-cap. Такая метка помечается `truncated` и **отбрасывается per-exit** — иначе 24ч-горизонт сравнивался бы с 1ч по обрезанному пути, корраптя `impactHorizonMinutes`. Короткие горизонты того же кандидата при этом сохраняются.

## Обучение

`PumpMatrix.fit(history, getCandles, opts)` подбирает пороги детектора И параметры prod-выхода одним grid'ом под time-series K-fold (расширяющееся окно). Objective — `shrinkage-expectancy` `mean·N/(N+k)` (k=5 по умолчанию): усадка к нулю при малой выборке не даёт влюбиться в один жирный аутлайер.

```ts
interface TrainOptions {
  grid?: Partial<TrainGrid>;
  folds?: number;                       // фолды K-fold, по умолчанию 4
  shrinkageK?: number;                  // сила усадки objective, по умолчанию 5
  maxBurstWindowMs?: number;            // потолок окна всплеска
  reliability?: Partial<ReliabilityConfig>;
  mode?: "auto" | "matrix" | "single";  // режим отбора входов
  viability?: Partial<ViabilityConfig>; // пороги жизнеспособности матрицы
  onProgress?: ProgressFn;              // по умолчанию stdout-бар
}
```

Дефолтный grid (всё перебирается эмпирически — минимум аналитической математики):

```ts
const DEFAULT_GRID = {
  // детектор (матрица авторства)
  windowK:          [2, 3, 5],
  minClusters:      [2, 3],
  jaccardThreshold: [0.2, 0.3, 0.4],
  lagPeakThreshold: [0.4, 0.5, 0.6],
  // prod-выход (метку ставит replay)
  trailingTake:         [0.5, 1.0, 2.0],
  hardStop:             [1.0, 2.0, 3.0],
  stalenessSinceProfit: [1.0],
  stalenessSinceMinutes:[240],
  staleMinutes:         [60, 240, 720, 1440],   // импакт-горизонт: 1ч / 4ч / 12ч / 24ч
  // детектор каскада ликвидаций
  volZThreshold:    [1.5, 2.5],                 // когда объём аномален
  squeezePolicy:    ["none", "tighten", "veto", "invert"],
  squeezeThreshold: [0.55, 0.7],
  volBaselineWindow:[20],
  cascadeWindowMinutes: [15, 30, 60],           // окно детекции каскада — НЕ горизонт удержания
  // окно стационарности (длинный горизонт)
  stationarityWindowMs: [Infinity, 28*24*3600_000, 56*24*3600_000],
};
```

Выбор победителя — **one-standard-error rule** (Breiman), а не argmax по CV-score. Чистый максимум из тысяч конфигураций систематически завышен (winner's curse): максимум шумных оценок смещён вверх на ~sigma·sqrt(2·ln N), и чем больше grid, тем сильнее переобучение на шум. Правило берёт самую КОНСЕРВАТИВНУЮ конфигурацию среди тех, чей score в пределах 1 SE от максимума — разница внутри 1 SE статистически незначима, поэтому robustness важнее удачи. «Консервативнее» = меньший hardStop, короче горизонт удержания, мягче реакция на каскад. Это делает размер grid менее опасным: лишние точки не утягивают выбор в счастливый выброс.

**Nested CV** (`selection.nestedOuterFolds`, по умолчанию 4) даёт несмещённую out-of-sample оценку выбранной конфигурации в `meta.nestedScore` — честное «что ждать на проде» без winner's curse. Выбор модели при этом остаётся за 1-SE; nested только оценивает. На 3 месяцах полный grid + nested ~50с, прогресс тикает на каждый внешний фолд (терминал не молчит). Параметры выбора (порядок консервативности, SE-коридор, число фолдов) вынесены в `selection.ts` — без магических литералов в логике.

`fit` возвращает обученную модель: `save()` → JSON-строка, `PumpMatrix.load(json)` восстанавливает без переобучения. Формат params — версия 3; старые v1/v2 не загрузятся (структура exit несовместима — переобучи).

## Два режима отбора входов

Режим меняет **условие входа**, но exit при этом **не общий** — подбирается отдельно под каждую ячейку тензора (см. ниже).

- **matrix** — вход = синхронный всплеск независимых кластеров-авторов (отсев манипуляций одного актора). Нужно ≥2 каналов и жизнеспособная корреляция.
- **single** (fallback) — корреляция недоступна (один канал), но даже один пост двигает рынок: аудитория входит. Каждый пост = вход, исход решает обученный exit.
- **auto** (по умолчанию) — матрица включается только если корреляция жизнеспособна И реально дала сигнал; иначе → single.

```ts
predict(items, { mode: "auto" });    // по умолчанию
predict(items, { mode: "matrix" });  // принудительно корреляция
predict(items, { mode: "single" });  // принудительно fallback
// result.usedMode  — каким режимом фактически отработал
// result.viability — почему: { viable, maxSharedEvents, strongEdges, multiChannelClusters, reason }
```

### Жизнеспособность матрицы: два канала ≠ matrix

Два канала **не** гарантируют matrix-режим. Если их пересечение шумовое (Jaccard случайно перевалил порог на 1-2 событиях, нет острых связей, граф тривиален) — `viability.viable = false`, и auto откатывается в single, чтобы не выдать ложный сигнал на случайном совпадении. Строгий критерий (`DEFAULT_VIABILITY`):

```ts
{ minSharedEvents: 3, minPeakShare: 0.6, minStrongEdges: 1, minStructure: 2 }
```

Переопределяется через `viability` в `fit`/`predict`. Все условия должны выполниться одновременно: достаточное событийное перекрытие, неслучайная острота связей, нетривиальный граф (найдены братья или ≥2 независимых кластера).

## Доверие к обучению (reliability)

```
confidence = support × stability × significance   (каждое в [0, 1])
reliable   = confidence ≥ 0.6 И totalN ≥ 40
```

| ось | растёт когда |
|---|---|
| support | больше сделок (усадка `N/(N+30)`) |
| stability | эдж в каждом фолде, не в одном |
| significance | эдж статистически ≠ 0 |

На малой выборке `reliable: false` — либа работает, но честно предупреждает. По мере роста данных все три оси растут → `confidence → 1`, `reliable` переключается в `true` **без правок кода**. Один канал → матрица авторства пуста → матрица сама по себе `reliable: false` по построению, но single-режим всё равно даёт торгуемые сигналы. Пороги (`supportK: 30`, `confidenceThreshold: 0.6`, `minN: 40`) настраиваются через `reliability` в `fit`.

## Exit-тензор `[mode][channel][symbol][direction][volRegime]`

Модель НЕ дублирует stoploss/targets из поста и НЕ смешивает математику выхода между источниками. trailing/hardStop/импакт-горизонт обучаются **отдельно на каждую ячейку** тензора — каждый канал качает каждый символ по-своему, long-trap и short-trap имеют разную динамику, а аномальный объём требует более тугого trailing.

Резолв per-signal с иерархическим fallback:

```
[mode][channel][symbol][direction][volRegime]   (cell)
  → [mode][symbol][direction]                    (symbol-dir, схлопнут volRegime)
  → [mode]                                        (mode)
  → global                                        (корень)
```

- **matrix и single раздельно** — разное матожидание входа → разный exit.
- **long и short — разные ячейки** (симметрия каскада).
- **calm и anomalous раздельно** — в аномальном объёме trailing туже.
- **новый канал без истории** падает на mode/global — fallback тоже обучен, без магических констант.

`p.exitSource` показывает, с какого уровня разрешён exit: `cell` | `symbol-dir` | `mode` | `global`.

## Детектор каскада ликвидаций (симметричный long/short)

Stop hunting симметричен: short-squeeze и long-cascade — зеркала одного механизма.

- **short-squeeze:** толпа шортит на плече → стена ликвидаций сверху → каскад форсированных buy толкает вверх (против short).
- **long-cascade:** толпа лонгует на плече → стена ликвидаций снизу → каскад форсированных sell толкает вниз (против long).

Плечо парсить не нужно — кумулятивный эффект виден в `volume`:

- **`volZ`** — z-score объёма входной свечи против базлайна. Высокий = синхронный заход толпы в плечо (накопленное топливо).
- **`squeezePressure`** — доля объёма на свечах, где цена идёт **против** позиции. Симметрично: для long «против» = вниз (каскад sell), для short = вверх (каскад buy). Высокое = движение питается ликвидациями, а не честным потоком → ловушка.

Реакция (`squeezePolicy`) подбирается обучением по CV или фиксируется в grid:

- **none** — обычный вход.
- **tighten** — ужать trailing, выскочить до разворота (`p.trailingTake` отдаётся уже ужатым).
- **veto** — не входить при высоком squeezePressure.
- **invert** — войти ПРОТИВ поста (стратегия из 1028592): канал дал short → каскад сквозит вверх → `signals` возвращает сигнал с `action: "invert"`, `direction: "long"` (уже развёрнут) и exit из инверс-ячейки тензора. `origin.invertedFrom` хранит исходное направление канала.

Порог calm/anomalous (`volZThreshold`) и порог срабатывания (`squeezeThreshold`) — оси grid.

**Окно детекции каскада** (`cascadeWindowMinutes`) — отдельная ось, НЕ связанная с горизонтом удержания `staleMinutes`. Сквиз это быстрое событие (минуты): мерить его на 24ч-окне неверно — длинное окно размывает резкий разворот. Раньше окно детекции бралось из `staleMinutes`, что склеивало два несвязанных концерна (жизнь позиции и чувствительность детектора); теперь они независимы.

## Prod API — единый контракт

`signals()` возвращает **только исполняемое**. veto (каскад ликвидаций) не попадает в выдачу — фильтр внутри. Прод не пишет `if (veto) continue` и не смотрит флаги.

```ts
for (const s of model.signals(liveItems)) {
  openPosition(s.symbol, s.direction, s.exit); // direction уже развёрнут при инверсии
}
```

Один сигнал = одно решение. Дискриминатор `action`, происхождение в одном `origin` (не флаги):

```ts
interface TradeSignal {
  symbol: string;
  direction: "long" | "short";        // ИТОГОВОЕ (учтена инверсия)
  action: "enter" | "invert" | "tighten";
  ts: number;
  exit: {                              // плоско, готово к openPosition
    trailingTake: number;             // ужат, если action="tighten"
    hardStop: number;
    impactHorizonMinutes: number;
    stalenessSinceProfit: number;
    stalenessSinceMinutes: number;
  };
  origin: {                           // аудит, не для ветвления
    detector: "matrix" | "single";
    channel: string | null;
    invertedFrom: "long" | "short" | null; // что говорил канал (null = без инверсии)
    exitSource: "cell" | "symbol-dir" | "mode" | "global";
    volRegime: "calm" | "anomalous" | null;
    confidence: number;
    independentClusters: number;
    modelConfidence: number;
    modelReliable: boolean;
  };
}
```

Методы:

```ts
model.signals(items, policy?)                       // без свечей: action всегда enter
model.plan(items, candlesBySymbol, policy?)          // со свечами: volRegime, каскад
model.planFor(symbol, dir, channel, candles, policy?)        // live, null при veto
model.planForAt(symbol, dir, channel, candles, ts, policy?)  // бэктест, null при veto
```

### Разрешения — allow-список, сериализован на обучении, readonly в исполнении

Что разрешено (входы/инверсии) фиксируется в момент `fit` и **вшивается в model.json**. В проде это readonly — второй аргумент `signals()` может только СУЗИТЬ, не расширить:

```ts
// на обучении — вшить политику в модель:
fit(history, getCandles, { policy: { allow: ["enter", "tighten"] } }); // без инверсии

// в проде — сузить для конкретного вызова (не шире обученной):
model.signals(items, { allow: ["enter"] });  // только прямые входы
```

`allow` без `"invert"` → инверсионные сигналы не отдаются (как veto — не входим в ловушку). Это заменило рантайм-флаги `disableInvert`/`disableSqueeze`: вместо размазанного по обучению-и-проду состояния — одна сериализуемая политика с инвариантом «исполнение не разрешает запрещённое обучением».

## Risk-reward (исследовательский выход + runtime-фильтр)

RR на сделку = `pnl / hardStop` — реализованный в единицах риска (сколько R снято). Считается на бэктесте по фолдам и вшивается в модель: **per-symbol** (для runtime-фильтра) и **global** (отчёт), наряду с `impactHorizonMinutes`.

```ts
model.riskReward.global;            // { mean, p95, p99, n }
model.riskReward.bySymbol.SOLUSDT;  // { mean, p95, p99, n }
```

В рантайме — **readonly-фильтр по тому же паттерну, что allow**: режет символы, чей backtest-RR ниже порога. Не пересчитывает RR в проде, только сравнивает с сохранённой статистикой:

```ts
model.signals(items, { minRiskReward: 1.5 });                  // mean RR >= 1.5
model.signals(items, { minRiskReward: 5.0, rrMetric: "p99" }); // хвост P99 >= 5.0
```

Символ без RR-статистики режется консервативно (нечем подтвердить). `rrMetric`: `mean` (по умолчанию), `p95`, `p99` — p99 фильтрует по правому хвосту, оставляя символы со взрывным потенциалом.

## Окно стационарности (длинный горизонт)

На 5 месяцах статистики корраптятся: τ и author-матрица агрегируются по ВСЕЙ истории, а режим за это время дрейфует — каналы появляются/замолкают, «братские» пары распадаются. Один глобальный набор усредняет несопоставимые периоды, и матрица «помнит» январскую связь в мае.

Решение без новой математики: статистики считаются по локальному окну, заканчивающемуся в текущем моменте. Размер окна — ось grid, train подбирает по CV:

```ts
stationarityWindowMs: [Infinity, 28*24*3600_000, 56*24*3600_000]
```

`Infinity` = вся история (старое поведение, годится на коротких данных). На длинном горизонте побеждает конечное окно — оно отбрасывает протухшие связи. В `predict`/live окно применяется автоматически к последнему периоду до самого свежего события. Влияет только на matrix-режим (author-матрица); single от него не зависит.

## Прогрессбар обучения

`fit`/`train` пишут прогресс в stdout **по умолчанию** (casual API):

```ts
await PumpMatrix.fit(history, getCandles); // бар включён сам собой
// [██████████████░░░░░░░░░░░░░░░░] 47% (42/90) label TRXUSDT
// [██████████████████████████████] 100% (27/27) score 5|0.4|0.6|all
```

Две фазы: `label` (медленная разметка по 1m-свечам, где идёт IO) и `score` (grid-скоринг по кэшу). Заглушить или подменить:

```ts
import { silentProgress } from "pump-matrix";
fit(history, getCandles, { onProgress: silentProgress });               // тихо
fit(history, getCandles, { onProgress: (e) => log(`${e.done}/${e.total}`) }); // свой
```

## Архитектура (слои детектора matrix-режима)

1. **selfTuneLag** — самооценка характерного лага τ из гистограммы попарных задержек между каналами. Без магических констант.
2. **jaccardScreen** — грубое сито близости каналов по скользящему окну сырых ts.
3. **lagXCorr** — направленный граф «кто за кем следует» по острому пику кросс-корреляции.
4. **clusterAuthors** — union-find: склейка каналов одного автора.
5. **earlyWarning** — плотность по НЕЗАВИСИМЫМ кластерам (дедупликация N каналов одного актора).

Вся пятёрка считается по окну стационарности. В single-режиме матрица не нужна — каждый пост становится входом напрямую.

## Лицензия

MIT



**Честная авто-диагностика режима.** `model.modeReason` объясняет, ПОЧЕМУ выбран single или matrix — не нужно гадать. Примеры: `auto → single: один канал — корреляция невозможна`, `auto → matrix: 3 острых связей, перекрытие 5, кластеров >1: 2`. Matrix требует ≥2 НЕЗАВИСИМЫХ кластеров авторов на одном тикере; каналы-эхо (всегда бьющие вместе) корректно слипаются в 1 кластер и не дают ложный matrix-сигнал. На одноканальных данных всегда single fallback.
