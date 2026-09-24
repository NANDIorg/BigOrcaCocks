/**
 * Общие кирпичи статистики проекта и задачи (`stats.ts`, `task-stats.ts`): накопитель расхода, группы разбивок,
 * длительность сессии. Внутренний модуль core — наружу через `index.ts` не экспортируется. Без Node.
 */
import type { StatsRow, StatsUsage, TokenUsage } from './types.ts'
import type { PricedTokens } from './pricing.ts'
import type { SessionUsage, StatsSession, UsageRecord } from './stats.ts'

export const UNKNOWN_MODEL = 'unknown'

export function modelTitle(m: string): string {
  return m === UNKNOWN_MODEL ? 'Модель неизвестна' : m
}

export function recordTotal(r: PricedTokens): number {
  return r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h
}

/** Накопитель среза: токены «неизвестны», пока не добавили сессию с данными или запись. */
export class Acc {
  tokens?: TokenUsage
  cost?: number
  unpricedTokens = 0
  unpricedModels = new Set<string>()
  sessions = 0
  sessionsWithUsage = 0
  agentMs = 0

  known(): TokenUsage {
    this.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    return this.tokens
  }

  record(r: UsageRecord, cost: number | undefined): void {
    const t = this.known()
    t.input += r.input
    t.output += r.output
    t.cacheRead += r.cacheRead
    t.cacheWrite += r.cacheWrite5m + r.cacheWrite1h
    if (cost === undefined) {
      this.unpricedTokens += recordTotal(r)
      this.unpricedModels.add(r.model)
    } else this.cost = (this.cost ?? 0) + cost
  }

  session(withUsage: boolean, ms: number): void {
    this.sessions++
    if (withUsage) {
      this.sessionsWithUsage++
      this.known()
    }
    this.agentMs += ms
  }

  usage(): StatsUsage {
    return {
      ...(this.tokens ? { tokens: { ...this.tokens } } : {}),
      ...(this.cost !== undefined ? { costUsd: this.cost } : {}),
      unpricedTokens: this.unpricedTokens,
      unpricedModels: [...this.unpricedModels].sort(),
      sessions: this.sessions,
      sessionsWithUsage: this.sessionsWithUsage,
      agentMs: this.agentMs
    }
  }
}

function tokensTotal(t: TokenUsage | undefined): number {
  return t ? t.input + t.output + t.cacheRead + t.cacheWrite : -1
}

/** Порядок строк разбивок: стоимость → токены → время агентов, по убыванию; при равенстве — по ключу. */
export function compareRows(a: StatsRow, b: StatsRow): number {
  return (b.costUsd ?? -1) - (a.costUsd ?? -1) ||
    tokensTotal(b.tokens) - tokensTotal(a.tokens) ||
    b.agentMs - a.agentMs ||
    a.key.localeCompare(b.key)
}

/** Группа накопителей по ключу (роль, модель…) с подписью. */
export class Group {
  private accs = new Map<string, { acc: Acc; title: string }>()

  get(key: string, title: () => string): Acc {
    let e = this.accs.get(key)
    if (!e) {
      e = { acc: new Acc(), title: title() }
      this.accs.set(key, e)
    }
    return e.acc
  }

  rows(): StatsRow[] {
    return [...this.accs].map(([key, e]) => ({ key, title: e.title, ...e.acc.usage() })).sort(compareRows)
  }
}

/**
 * Границы сессии на момент `now`. `end` — конец: `endedAt`, у сессии без него — `now`, если PTY жив, иначе
 * последнее сообщение транскрипта (упало приложение); неизвестен — undefined, и время сессии не считается.
 * `clippedEnd` — конец, обрезанный `now`. `lastActivity` — последняя активность: агент мог писать и после
 * `endedAt` (dispatch закрыт `done`, а терминал жив).
 */
export function sessionSpan(
  s: Pick<StatsSession, 'ptyId' | 'startedAt' | 'endedAt'>,
  usage: SessionUsage | undefined,
  now: number,
  isAlive: (ptyId: string) => boolean
): { end: number | undefined; clippedEnd: number; lastActivity: number } {
  const end = s.endedAt ?? (isAlive(s.ptyId) ? now : usage?.lastAt)
  const clippedEnd = Math.min(end ?? s.startedAt, now)
  const lastActivity = Math.max(clippedEnd, Math.min(usage?.lastAt ?? -Infinity, now))
  return { end, clippedEnd, lastActivity }
}

/**
 * Модель сессии для счётчика и времени — та, что потратила больше всего токенов; транскрипта нет — снимок роли
 * (`fallback`), и тот не всегда есть — `unknown`.
 */
export function sessionModel(usage: SessionUsage | undefined, fallback: string | undefined): string {
  const perModel = new Map<string, number>()
  for (const r of usage?.records ?? []) perModel.set(r.model || UNKNOWN_MODEL, (perModel.get(r.model || UNKNOWN_MODEL) ?? 0) + recordTotal(r))
  return [...perModel].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback ?? UNKNOWN_MODEL
}
