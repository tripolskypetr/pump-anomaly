import { beforeAll, afterAll } from "vitest";

/**
 * Прогрессбар по умолчанию пишет в stdout (casual API: обучил — видишь прогресс).
 * В тестах это лишний шум и ломает вывод раннера, поэтому глушим process.stdout.write
 * на время прогона. Сама логика прогресса при этом исполняется (дефолтный путь
 * stdoutProgress остаётся под тестом), просто запись подавляется.
 *
 * Тесты, которым нужен сам прогресс (progress.test.ts), передают свой onProgress-
 * коллектор и не зависят от stdout.
 */

const realWrite = process.stdout.write.bind(process.stdout);

beforeAll(() => {
  // @ts-expect-error — подменяем сигнатуру на no-op, возвращаем true как настоящий write
  process.stdout.write = () => true;
});

afterAll(() => {
  process.stdout.write = realWrite;
});
