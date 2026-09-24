/**
 * Таблица цен моделей для статистики проекта (docs/architecture.md, «Статистика → Стоимость»). Без Node:
 * её же может показать renderer. Новая модель — строка в `MODEL_PRICES`, код менять не нужно.
 */
import type { ModelPrice } from './types'

/**
 * $ за миллион токенов, первые руки API Anthropic (цены проверены 2026-09-24 по справочнику Claude API).
 * Запись в кэш: 5 мин — 1,25× входа, 1 час — 2×; чтение — 0,1× (у Fable 5.1 и Opus 5.5 — отдельная цена).
 * Модели других провайдеров (codex и т. п.) не указаны: их токены идут в `unpricedTokens`, а не в выдуманную цену.
 */
export const MODEL_PRICES: ModelPrice[] = [
  { match: ['claude-fable-5-1'], input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  { match: ['claude-fable-5', 'claude-mythos-5'], input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  { match: ['claude-opus-5-5'], input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  {
    match: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10
  },
  { match: ['claude-opus-4-1', 'claude-opus-4-2025'], input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  { match: ['claude-sonnet-5'], input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  {
    match: ['claude-sonnet-4', 'claude-3-7-sonnet'],
    input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6
  },
  { match: ['claude-haiku-4-5'], input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  { match: ['claude-3-5-haiku'], input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 }
]

/** Цена модели по id из транскрипта: выигрывает самый длинный префикс; нет — `undefined` (стоимость неизвестна). */
export function findModelPrice(model: string, prices: ModelPrice[] = MODEL_PRICES): ModelPrice | undefined {
  let best: ModelPrice | undefined
  let bestLen = 0
  for (const p of prices) {
    for (const m of p.match) {
      if (m.length > bestLen && model.startsWith(m)) {
        best = p
        bestLen = m.length
      }
    }
  }
  return best
}

/** Токены одной записи для цены: запись в кэш разделена по TTL (транскрипт без деления — всё в `cacheWrite5m`). */
export interface PricedTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/** Стоимость токенов модели, $; модель не в таблице — `undefined`. */
export function tokensCost(model: string, t: PricedTokens, prices: ModelPrice[] = MODEL_PRICES): number | undefined {
  const p = findModelPrice(model, prices)
  if (!p) return undefined
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead +
    t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) / 1_000_000
}
