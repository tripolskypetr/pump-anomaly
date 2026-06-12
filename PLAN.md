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
npm test        # vitest run — 118 тестов
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

// без свечей: вход + exit-план на уровне symbol-dir, recommendation="enter"
const plans = model.signals(liveItems);

// со свечами: volRegime посчитан, cell-exit разрешён, каскад оценён
const plans = model.plan(liveItems, { SOLUSDT: solCandles, TRXUSDT: trxCandles });

for (const p of plans) {
  if (p.recommendation === "veto") continue;        // каскад ликвидаций — пропускаем
  openPosition(p.symbol, p.direction, {             // direction уже развёрнут при инверсии
    trailingTake: p.trailingTake,                    // уже ужат, если recommendation="tighten"
    hardStop: p.hardStop,
    lifeMinutes: p.impactHorizonMinutes,
  });
}
```

`signals`/`plan` думают сами: выбирают режим, считают volRegime, оценивают каскад, при необходимости разворачивают сигнал. Приложение просто исполняет `p.direction` — никаких `if` про инверсию или режим.

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
  // окно стационарности (длинный горизонт)
  stationarityWindowMs: [Infinity, 28*24*3600_000, 56*24*3600_000],
};
```

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
- **invert** — войти ПРОТИВ поста (стратегия из 1028592): канал дал short → каскад сквизит вверх → `signals` возвращает развёрнутый **long** с exit из инверс-ячейки тензора. `p.originalDirection` хранит сигнал канала, `p.inverted = true`, `p.direction` уже развёрнут.

Порог calm/anomalous (`volZThreshold`) и порог срабатывания (`squeezeThreshold`) — оси grid.

## Prod API

Три уровня, по нарастанию точности. Думать на проде не нужно — берёшь план и исполняешь.

```ts
// без свечей — exit на уровне symbol-dir, recommendation всегда "enter"
model.signals(items, opts?);

// со свечами (словарь по символам) — volRegime, cell-exit, детекция каскада
model.plan(items, candlesBySymbol, opts?);

// точечно под одну позицию (live: вход = последняя свеча окна)
model.planFor(symbol, direction, channel, candles, opts?);

// для бэктеста: явный момент входа, форвардные свечи считают squeezePressure
model.planForAt(symbol, direction, channel, candles, entryTs, opts?);
```

`TradePlan` несёт всё для исполнения и аудита:

```ts
interface TradePlan {
  symbol: string;
  direction: "long" | "short";        // к ИСПОЛНЕНИЮ (развёрнут при инверсии)
  originalDirection: "long" | "short"; // что сказал канал
  inverted: boolean;
  channel: string | null;
  ts: number;
  confidence: number;
  independentClusters: number;
  trailingTake: number;                // уже ужат, если recommendation="tighten"
  hardStop: number;
  impactHorizonMinutes: number;
  stalenessSinceProfit: number;
  stalenessSinceMinutes: number;
  squeezePolicy: "none" | "tighten" | "veto" | "invert";
  squeezeThreshold: number;
  volZThreshold: number;
  exitSource: "cell" | "symbol-dir" | "mode" | "global";
  volRegime: "calm" | "anomalous" | null;  // null без свечей
  volZ: number | null;
  squeezePressure: number | null;
  recommendation: "enter" | "tighten" | "veto" | "invert";
  modelConfidence: number;
  modelReliable: boolean;
  source: "matrix" | "single";
}
```

`volZ`/`squeezePressure` считаются внутри из переданных свечей — на проде их руками вычислять не надо. `squeezePressure` меряется вперёд от входа, поэтому в чистом live (без форвардных свечей) он null и каскад не сработает по нему — пересчитывай `plan` на закрытии каждой 1m-свечи, как твой `listenActivePing`.

### Рантайм-переключатели (без переобучения)

```ts
interface RuntimeOptions {
  disableInvert?: boolean;   // invert → veto (не разворачивать, а защититься)
  disableSqueeze?: boolean;  // вся каскад-логика off → enter в направлении поста
}

model.plan(items, candlesBySymbol, { disableInvert: true });
```

Чтобы выключить инверсию ещё на обучении — исключи её из grid: `squeezePolicy: ["none", "tighten", "veto"]`.

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
