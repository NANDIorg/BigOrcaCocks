/**
 * Статистика проекта (docs/architecture.md, «Статистика»): чистые функции без Node — их использует main
 * (сбор) и renderer (пустое состояние, подписи периода).
 */
import type { ProjectStats, StatsRange, StatsUsage } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Начало периода, epoch ms: скользящее окно от `now`; `all` — без начала. */
export function statsRangeStart(range: StatsRange, now: number): number | undefined {
  if (range === '7d') return now - 7 * DAY_MS
  if (range === '30d') return now - 30 * DAY_MS
  return undefined
}

/** Расход без данных: токенов нет (неизвестно), а не нули. */
export function emptyStatsUsage(): StatsUsage {
  return { unpricedTokens: 0, unpricedModels: [], sessions: 0, sessionsWithUsage: 0, agentMs: 0 }
}

/** Статистика проекта без единой сессии и задачи — пустой проект и заглушка main до реализации сбора. */
export function emptyProjectStats(projectId: string, range: StatsRange, now: number): ProjectStats {
  const from = statsRangeStart(range, now)
  const counts = (): ProjectStats['tasks'] => ({ total: 0, byStatus: {}, created: 0, done: 0 })
  return {
    projectId,
    range,
    ...(from === undefined ? {} : { from }),
    generatedAt: now,
    totals: emptyStatsUsage(),
    tasks: counts(),
    globalTasks: counts(),
    dispatches: { total: 0, done: 0, failed: 0, unknown: 0, running: 0 },
    coordinatorLaunches: 0,
    taskTime: { samples: 0 },
    byRole: [],
    byModel: [],
    byAgent: [],
    byGlobalTask: [],
    byTask: [],
    byDay: []
  }
}
