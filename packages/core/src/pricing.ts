/**
 * Таблица цен моделей для статистики проекта (docs/architecture.md, «Статистика → Стоимость»). Без Node:
 * её же может показать renderer. Новая модель — строка в `MODEL_PRICES`, код менять не нужно.
 */
import type { ModelPrice } from './types'

/** Цена OpenAI: чтение из кэша — `cached`, запись в кэш — `write` (нет отдельной цены — как обычный вход). */
function openai(exact: string, input: number, cached: number, output: number, write: number = input): ModelPrice {
  return { match: [], exact: [exact], input, output, cacheRead: cached, cacheWrite5m: write, cacheWrite1h: write }
}

/**
 * $ за миллион токенов, Standard-tier API OpenAI: https://developers.openai.com/api/docs/pricing, проверено 2026-09-25.
 * Codex CLI пишет в rollout и `input_tokens` (включая кэш), и `cached_input_tokens`: кэшированная часть идёт по
 * `cacheRead`, остальное — по `input` (`parseCodexLine` в `apps/desktop/src/main/transcripts.ts`).
 * Не учтено: надбавка длинного контекста (запрос свыше ~272K входных токенов — вход ×2, выход ×1,5): в rollout
 * прирост считается по накопительному счётчику, размер отдельного запроса неизвестен, поэтому стоимость таких
 * запросов может быть занижена. Batch/Flex/Priority тоже не различаются — берётся Standard.
 * Нет на странице цен, а значит и здесь: gpt-5-codex, gpt-5.1-codex(-max/-mini), gpt-5.2-codex, gpt-5.3-codex-spark,
 * codex-auto-review (служебная модель авто-ревью codex) — они «без цены», пока OpenAI их не опубликует.
 */
const OPENAI_PRICES: ModelPrice[] = [
  openai('gpt-6-astra', 10, 1, 50, 12.5),
  openai('gpt-6-sol', 2, 0.2, 10, 2.5),
  openai('gpt-6-luna', 0.1, 0.01, 0.5, 0.125),
  openai('gpt-5.6-sol', 4, 0.4, 20, 5),
  openai('gpt-5.6-terra', 2, 0.2, 12, 2.5),
  openai('gpt-5.6-luna', 0.2, 0.02, 1.2, 0.25),
  openai('gpt-5.5', 5, 0.5, 30),
  openai('gpt-5.4', 2.5, 0.25, 15),
  openai('gpt-5.4-mini', 0.75, 0.075, 4.5),
  openai('gpt-5.4-nano', 0.2, 0.02, 1.25),
  openai('gpt-5.3-codex', 1.75, 0.175, 14),
  openai('gpt-5.2', 1.75, 0.175, 14),
  openai('gpt-5.1', 1.25, 0.125, 10),
  openai('gpt-5', 1.25, 0.125, 10),
  openai('gpt-5-mini', 0.25, 0.025, 2),
  openai('gpt-5-nano', 0.05, 0.005, 0.4),
  openai('o3', 2, 0.5, 8),
  openai('o4-mini', 1.1, 0.275, 4.4),
  openai('gpt-4.1', 2, 0.5, 8)
]

/**
 * $ за миллион токенов, первые руки API Anthropic (цены проверены 2026-09-24 по справочнику Claude API).
 * Запись в кэш: 5 мин — 1,25× входа, 1 час — 2×; чтение — 0,1× (у Fable 5.1 и Opus 5.5 — отдельная цена).
 * Модели вне таблицы (в том числе новые id codex) не оцениваются: их токены идут в `unpricedTokens`, а не в выдуманную цену.
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
  { match: ['claude-3-5-haiku'], input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6 },
  ...OPENAI_PRICES
]

/** Снапшот модели OpenAI: `-2026-04-23` или `-20260423` после базового id. */
const SNAPSHOT_SUFFIX = /^-(\d{4}-\d{2}-\d{2}|\d{8})$/

function matchesExact(model: string, id: string): boolean {
  const m = model.toLowerCase().slice(model.lastIndexOf('/') + 1)
  return m === id || (m.startsWith(id) && SNAPSHOT_SUFFIX.test(m.slice(id.length)))
}

/**
 * Цена модели по id из транскрипта: по префиксу `match` выигрывает самый длинный; `exact` — только точный id или
 * снапшот с датой. Нет — `undefined` (стоимость неизвестна).
 */
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
    for (const id of p.exact ?? []) {
      if (id.length > bestLen && matchesExact(model, id)) {
        best = p
        bestLen = id.length
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
