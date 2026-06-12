# pump-matrix

Чёрная коробка для детекции **синхронного памп-сигнала** по потоку торговых рекомендаций из Telegram-каналов. Отличает реальный приток капитала (несколько независимых авторов синхронно бьют в тикер) от манипуляции одного актора за несколькими анонимными каналами — и от **stop hunting**, где сигнал ведёт в ловушку.

Совместима со схемой `parser-items` (`channel, symbol, direction, entry:{from,to}, ...`).

## Casual API

```ts
import { PumpMatrix } from "pump-matrix";

// 1) обучить один раз на истории (метку ставит симуляция твоего prod-выхода)
const model = await PumpMatrix.fit(history, getCandles);
fs.writeFileSync("model.json", model.save());

// 2) в проде — без обучения
const model = PumpMatrix.load(fs.readFileSync("model.json", "utf8"));
const plans = model.signals(liveItems);

for (const p of plans) {
  openPosition(p.symbol, p.direction, {
    trailingTake: p.trailingTake,
    hardStop: p.hardStop,
    lifeMinutes: p.impactHorizonMinutes,
  });
  // p.inverted: была ли применена инверсия (канал сказал p.originalDirection,
  //             исполняем развёрнутый p.direction)
  // p.source: "matrix" | "single"; p.exitSource: "cell" | "symbol-dir" | "mode" | "global"
}
```

## Exit-параметры: tensor3d по [mode][channel][symbol]

Модель НЕ дублирует stoploss/targets из оригинального поста и НЕ смешивает математику выхода между источниками. trailingTake/hardStop/импакт-горизонт обучаются **отдельно на каждую ячейку** `[mode][channel][symbol]` — каждый канал качает каждый символ по-своему. Резолв per-signal с иерархическим fallback:

```
[mode][channel][symbol]  →  [mode]  →  global
     (cell)                  (mode)     (global)
```

- **matrix и single раздельно** — разное матожидание входа даёт разный оптимальный exit (single защищает от слива при нулевом матожидании; matrix снимает максимум с раскачанной ликвидности толпы на памп-паре).
- **новый канал без истории** → падает на уровень режима, затем global. Никаких магических констант — fallback тоже обучен.
- `p.exitSource` показывает, обучен ли exit персонально под (канал, символ) или это fallback.

Каждый сигнал требует `channel` во входных `ParserItem` (он там и так есть) — это ключ тензора.

## Детектор каскада ликвидаций (симметричный long/short)

Stop hunting **симметричен**: short-squeeze и long-cascade — зеркала одного механизма.

- **short-squeeze:** толпа шортит на плече → стена ликвидаций сверху → каскад форсированных buy толкает вверх (против short).
- **long-cascade:** толпа лонгует на плече → стена ликвидаций снизу → каскад форсированных sell толкает вниз (против long).

Плечо парсить не нужно — кумулятивный эффект виден в `volume`:

- **`volZ`** — z-score объёма входной свечи против базлайна. Высокий = синхронный заход толпы в плечо (накопленное топливо), та самая «синяя свеча» из 1028592.
- **`squeezePressure`** — доля объёма на свечах, где цена идёт **против** позиции. Симметрично: для long «против» = вниз (каскад sell), для short = вверх (каскад buy). Высокое = движение питается ликвидациями, а не честным потоком → ловушка.

Реакция подбирается обучением по CV (или фиксируется параметром):

```ts
fit(history, getCandles, {
  grid: {
    squeezePolicy: ["none", "tighten", "veto", "invert"], // train выберет
    volZThreshold: [1.5, 2.5],     // когда объём аномален
    squeezeThreshold: [0.55, 0.7], // доля против позиции для срабатывания
  },
});
```

tighten — ужать trailing. veto — не входить. **invert** — войти ПРОТИВ поста (стратегия из 1028592): канал дал short → каскад сквизит вверх → `signals` возвращает развёрнутый **long** с exit из инверс-ячейки тензора. Прод открывает `p.direction` — он уже развёрнут, никаких `if`. `p.originalDirection` хранит сигнал канала, `p.inverted = true`.

`signals`/`plan` думают сами: видят ловушку, выбирают реакцию по CV, возвращают готовый (возможно инвертированный) сигнал. Приложение не знает, инверсия это или прямой вход.

**Понять, была ли инверсия:** `p.inverted` (булев), `p.originalDirection` (что сказал канал), `p.recommendation === "invert"`. Для исполнения они не нужны — просто открываешь `p.direction`.

**Выключить инверсию:**

```ts
// на обучении — не рассматривать invert вовсе:
fit(history, getCandles, { grid: { squeezePolicy: ["none", "tighten", "veto"] } });

// на готовой модели, без переобучения (рантайм):
model.plan(items, candlesBySymbol, { disableInvert: true });  // invert → veto
model.plan(items, candlesBySymbol, { disableSqueeze: true }); // вся каскад-логика off → enter
```

`disableInvert` глушит разворот в `veto` (не входим в ловушку), а не в прямой вход — безопаснее. `disableSqueeze` отключает всю реакцию на каскад. Оба флага есть у `signals`/`plan`/`planFor`/`planForAt`.

## Prod API: свечи на вход → готовый сигнал на выход

Три уровня, по нарастанию точности. Думать на проде не нужно — берёшь план и исполняешь.

```ts
// 1) без свечей — exit на уровне symbol-dir, recommendation всегда "enter"
const plans = model.signals(liveItems);

// 2) СО свечами (словарь по символам) — volRegime считается из свечей,
//    cell-exit разрешается, каскад ликвидаций детектируется
const plans = model.plan(liveItems, { SOLUSDT: solCandles, TRXUSDT: trxCandles });

// 3) точечно под одну позицию
const plan = model.planFor("SOLUSDT", "long", "crypto_yoda", candles);

for (const p of plans) {
  if (p.recommendation === "veto") continue;        // каскад ликвидаций — пропускаем
  openPosition(p.symbol, p.direction, {
    trailingTake: p.trailingTake,                    // уже ужат, если recommendation="tighten"
    hardStop: p.hardStop,
    lifeMinutes: p.impactHorizonMinutes,
  });
}
```

Каждый `TradePlan` со свечами несёт: `volRegime` (calm/anomalous), `volZ`, `squeezePressure`, `recommendation` (enter/tighten/veto/invert), `exitSource` (cell/symbol-dir/mode/global). volZ/squeeze считаются внутри — на проде их руками вычислять не надо.

Для бэктеста — `planForAt(symbol, dir, channel, candles, entryTs)`: явный момент входа, история до него, форвардные свечи после для squeezePressure.

## Прогрессбар обучения

`train`/`fit` делают вложенные циклы (медленная разметка свечами + grid-скоринг). Прогресс пишется в stdout, если передать `onProgress`:

```ts
import { PumpMatrix, stdoutProgress } from "pump-matrix";

await PumpMatrix.fit(history, getCandles, { onProgress: stdoutProgress });
// [██████████████░░░░░░░░░░░░░░░░] 47% (42/90) label TRXUSDT
// [██████████████████████████████] 100% (27/27) score 5|0.4|0.6
```

Две фазы: `label` (разметка по 1m-свечам, где идёт IO) и `score` (grid-скоринг по кэшу). По умолчанию тихо (`silentProgress`). Свой колбэк — для лога/UI вместо stdout:

```ts
fit(history, getCandles, {
  onProgress: (e) => myLogger.info(`${e.phase} ${e.done}/${e.total}`),
});
```

## Два режима отбора входов

Режим (matrix/single) меняет **условие входа**, но exit при этом **не общий**: он подбирается отдельно под каждую ячейку тензора `[mode][channel][symbol][direction][volRegime]`. matrix и single, long и short, calm и anomalous — у каждого свои эмпирические trailing/hardStop/импакт-горизонт, math разных источников не смешивается (см. раздел про tensor ниже).

- **matrix** — вход = синхронный всплеск независимых кластеров-авторов (отсев манипуляций одного актора). Нужно ≥2 каналов.
- **single** (fallback) — корреляция недоступна (один канал), но даже один пост двигает рынок: аудитория входит. Каждый пост = вход, исход решает обученный exit (он уже доказал, что отделяет памп от stop hunt).
- **auto** (по умолчанию) — матрица включается только если корреляция **жизнеспособна** (строгий критерий: явные кластеры + достаточное событийное перекрытие + неслучайная острота связей) И реально дала сигнал. Иначе → single.

```ts
predict(items, { mode: "auto" });    // по умолчанию
predict(items, { mode: "matrix" });  // принудительно корреляция
predict(items, { mode: "single" });  // принудительно fallback
// result.usedMode — каким режимом фактически отработал
// result.viability — почему: { viable, maxSharedEvents, strongEdges, multiChannelClusters, reason }
```

### Два канала с плохой корреляцией → откат в single

Важный случай: два канала ещё **не** гарантируют matrix-режим. Если их пересечение шумовое (Jaccard случайно перевалил порог на 1-2 событиях, нет острых связей, граф тривиален) — `viability.viable = false`, и auto откатывается в single, чтобы не выдать ложный сигнал на случайном совпадении. Порог строгий по умолчанию и переопределяется:

```ts
predict(items, { viability: { minSharedEvents: 10, minStrongEdges: 2 } });
```

Важно: в single-режиме reliability считается на выборке «все посты», поэтому `reliable` может стать `true` даже на одном канале — если связка пост+exit даёт значимый положительный эдж на K-fold.

## Как ставится метка (stop hunting не пройдёт)

Метку обучения ставит НЕ close-to-close, а **точная симуляция твоего prod-выхода по 1m-свечам** (`replayExit`):

- **moonbag** (long) — hard stop ниже входа; **gravebag** (short) — выше.
- **trailing take** — откат от пикового PnL при `currentProfit ≥ 0`.
- **peak staleness** — пик достиг порога, но протух по времени (цена может вообще не идти к цели).
- **life-cap** (`staleMinutes`) — потолок жизни позиции = **эмпирический импакт-горизонт**, подбирается grid'ом.
- Выбивание по SL **откатывает метрику к последнему плюсовому trailing-пику**.

Почему это ловит stop hunt: прокол в ловушке не дотягивает до trailingTake, а откат бьёт hard stop → метка отрицательная, **даже если** `close[t+H]` случайно положительный. Path-aware replay видит путь по OHLC, а не две точки.

## Обучение

`train`/`fit` подбирает **и пороги детектора, и параметры prod-выхода** одним grid'ом под time-series K-fold. Objective — `shrinkage-expectancy` (усадка к нулю при малой выборке: не даёт влюбиться в один жирный аутлайер).

```ts
const model = await PumpMatrix.fit(history, getCandles, {
  folds: 4,
  grid: {
    // детектор
    windowK: [2, 3, 5], minClusters: [2, 3],
    jaccardThreshold: [0.2, 0.3, 0.4], lagPeakThreshold: [0.4, 0.5, 0.6],
    // prod-выход
    trailingTake: [0.5, 1.0, 2.0], hardStop: [1.0, 2.0, 3.0],
    stalenessSinceProfit: [1.0], stalenessSinceMinutes: [240],
    staleMinutes: [60, 240, 720, 1440], // импакт-горизонт ищется эмпирически
  },
});
```

## Доверие к обучению

`confidence = support × stability × significance` (каждое 0..1):

| ось | растёт когда |
|---|---|
| support | больше сделок |
| stability | эдж в каждом фолде, не в одном |
| significance | эдж статистически ≠ 0 |

`reliable = confidence ≥ порог И N ≥ минимум`. На малой выборке `false` (либа работает, но честно предупреждает); по мере роста данных переключается в `true` без правок кода. Один канал → матрица авторства пуста → `reliable: false` по построению.

## Запуск

```bash
npm i
npm test        # vitest run — 98 тестов (replay, volume, invert, plan, progress, tensor)
npm run build
```
