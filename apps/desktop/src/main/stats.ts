/**
 * Статистика проекта в main (docs/architecture.md → «Статистика»): снапшот store + транскрипты агентов на диске →
 * `buildProjectStats` (core). Считается по запросу, в store пишутся только найденные id сессий codex.
 */
import { join } from 'node:path'
import { buildProjectStats, statsRangeStart, statsSessions, type BoardColumn, type ProjectStats, type StatsRange, type TaskStore } from '@orca-board/core'
import { collectSessionUsage, TranscriptCache, transcriptEnv, type TranscriptEnv } from './transcripts'

export interface ProjectStatsDeps {
  projectId: string
  range: StatsRange
  store: TaskStore
  repoRoot: string
  columns: readonly BoardColumn[]
  roleTitle: (roleId: string) => string | undefined
  isAlive: (ptyId: string) => boolean
  now?: number
  env?: TranscriptEnv
  cache?: TranscriptCache
}

/** Кэш транскриптов на процесс: повторный запрос дочитывает только дописанное. */
const sharedCache = new TranscriptCache()

export async function projectStats(deps: ProjectStatsDeps): Promise<ProjectStats> {
  const now = deps.now ?? Date.now()
  const snap = deps.store.snapshot()
  const from = statsRangeStart(deps.range, now) ?? -Infinity
  const tasks = new Map(snap.tasks.map((t) => [t.id, t]))
  const collected = await collectSessionUsage(statsSessions(snap), {
    env: deps.env ?? transcriptEnv(),
    cache: deps.cache ?? sharedCache,
    repoRoot: deps.repoRoot,
    // Worktree воркера — как в startWorker; у задач от старого кода поля может не быть.
    worktree: (taskId) => tasks.get(taskId)?.worktree ?? join(deps.repoRoot, '..', '.orca-worktrees', taskId),
    now,
    // Закрытая до периода сессия с мёртвым PTY в период не попадёт — её транскрипт не читаем.
    include: (s) => s.endedAt === undefined || s.endedAt >= from || deps.isAlive(s.ptyId)
  })
  for (const [dispatchId, sessionId] of collected.found) deps.store.setDispatchSessionId(dispatchId, sessionId)
  return buildProjectStats({
    projectId: deps.projectId,
    range: deps.range,
    now,
    tasks: snap.tasks,
    runs: snap.runs,
    dispatches: snap.dispatches,
    columns: deps.columns,
    usage: (s) => collected.usage.get(s.key),
    isAlive: deps.isAlive,
    roleTitle: deps.roleTitle
  })
}
