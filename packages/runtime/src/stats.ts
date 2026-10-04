/**
 * Статистика проекта в runtime (docs/architecture.md → «Статистика»): снапшот store + транскрипты агентов на диске →
 * `buildProjectStats` (core). Считается по запросу, в store пишутся только найденные id сессий codex.
 */
import { join } from 'node:path'
import {
  buildGlobalTaskStats, buildProjectStats, buildTaskStats, statsRangeStart, statsSessions,
  type BoardColumn, type GlobalTaskStats, type ProjectStats, type StatsRange, type StatsSession, type StoreSnapshot, type TaskStats,
  type TaskStore, type Workflow
} from '@orca-board/core'
import { collectSessionUsage, TranscriptCache, transcriptEnv, type TranscriptEnv } from './transcripts.ts'
export type StatsMessageKey = 'stats.noTask' | 'stats.noGlobal' | 'stats.badRange'
export interface StatsMessages { Error: new (key: StatsMessageKey, params?: Record<string, string | number>) => Error }

/** Хост передаёт store, корень репозитория, названия ролей и состояние процессов. */
export interface StatsDeps {
  store: TaskStore
  repoRoot: string
  columns: readonly BoardColumn[]
  roleTitle: (roleId: string) => string | undefined
  isAlive: (ptyId: string) => boolean
  now?: number
  env?: TranscriptEnv
  cache?: TranscriptCache
  isCurrent?: () => boolean
  commit?: <T>(operation: () => T) => T
}

export interface ProjectStatsDeps extends StatsDeps {
  projectId: string
  range: StatsRange
}

export interface TaskStatsDeps extends StatsDeps {
  taskId: string
  /** Граф прогона задачи: названия этапов, которых нет в `StageChange.title` (запись миграции). */
  workflow?: Workflow
}

export interface GlobalTaskStatsDeps extends StatsDeps {
  runId: string
}

export function createStatsServices({ messages }: { messages: StatsMessages }) {
  /** Один кэш на runtime: повторный запрос дочитывает только дописанное. */
  const sharedCache = new TranscriptCache()

  /** Расход сессий снапшота, отобранных `include`; найденные id сессий codex запоминаются в store. */
  async function collectUsage(deps: StatsDeps, snap: StoreSnapshot, now: number, include: (s: StatsSession) => boolean) {
    const tasks = new Map(snap.tasks.map((t) => [t.id, t]))
    const identities = new Map(snap.dispatches.map(d => [d.id, deps.store.getDispatch(d.id)]))
    const collected = await collectSessionUsage(statsSessions(snap), {
      env: deps.env ?? transcriptEnv(),
      cache: deps.cache ?? sharedCache,
      repoRoot: deps.repoRoot,
      // Worktree воркера — как в startWorker; у задач от старого кода поля может не быть.
      worktree: (taskId) => tasks.get(taskId)?.worktree ?? join(deps.repoRoot, '..', '.orca-worktrees', taskId),
      now,
      include
    })
    // Snapshot отделён от store: после await тот же id мог получить другой dispatch.
    const captured = new Map(snap.dispatches.map(d => [d.id, d]))
    for (const [dispatchId, sessionId] of collected.found) {
      if (deps.isCurrent && !deps.isCurrent()) break
      const before = captured.get(dispatchId); const current = deps.store.getDispatch(dispatchId)
      if (!before || !current || current !== identities.get(dispatchId) || current.sessionId || !deps.store.getTask(current.taskId)
        || current.taskId !== before.taskId || current.ptyId !== before.ptyId
        || current.startedAt !== before.startedAt || current.agent !== before.agent) continue
      const write = () => deps.store.setDispatchSessionId(dispatchId, sessionId)
      if (deps.commit) deps.commit(write)
      else write()
    }
    return collected
  }

  async function projectStats(deps: ProjectStatsDeps): Promise<ProjectStats> {
    const now = deps.now ?? Date.now()
    const snap = structuredClone(deps.store.snapshot())
    const from = statsRangeStart(deps.range, now) ?? -Infinity
    // Закрытая до периода сессия с мёртвым PTY в период не попадёт — её транскрипт не читаем.
    const collected = await collectUsage(deps, snap, now, (s) => s.endedAt === undefined || s.endedAt >= from || deps.isAlive(s.ptyId))
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

  /**
   * Статистика задачи: расход — сессии самой задачи и её проверок (`Task.gateFor`); транскрипты остальных задач
   * не читаются. Неизвестная задача — ошибка из `buildTaskStats`, но проверяем заранее: иначе зря обошли бы диск.
   */
  async function taskStats(deps: TaskStatsDeps): Promise<TaskStats> {
    const now = deps.now ?? Date.now()
    const snap = structuredClone(deps.store.snapshot())
    if (!snap.tasks.some((t) => t.id === deps.taskId)) throw new messages.Error('stats.noTask', { id: deps.taskId })
    const ids = new Set([deps.taskId, ...snap.tasks.filter((t) => t.gateFor?.taskId === deps.taskId).map((t) => t.id)])
    const collected = await collectUsage(deps, snap, now, (s) => s.taskId !== undefined && ids.has(s.taskId))
    return buildTaskStats({
      taskId: deps.taskId,
      now,
      tasks: snap.tasks,
      runs: snap.runs,
      dispatches: snap.dispatches,
      requests: snap.requests,
      questions: snap.questions,
      columns: deps.columns,
      ...(deps.workflow ? { workflow: deps.workflow } : {}),
      usage: (s) => collected.usage.get(s.key),
      isAlive: deps.isAlive,
      roleTitle: deps.roleTitle
    })
  }

  /** Статистика глобальной задачи: сессии её подзадач (с проверками) и координатора этого прогона. */
  async function globalTaskStats(deps: GlobalTaskStatsDeps): Promise<GlobalTaskStats> {
    const now = deps.now ?? Date.now()
    const snap = structuredClone(deps.store.snapshot())
    if (!snap.runs.some((r) => r.id === deps.runId)) throw new messages.Error('stats.noGlobal', { id: deps.runId })
    const ids = new Set(snap.tasks.filter((t) => t.runId === deps.runId).map((t) => t.id))
    const collected = await collectUsage(
      deps, snap, now,
      (s) => s.runId === deps.runId && (s.kind === 'coordinator' || (s.taskId !== undefined && ids.has(s.taskId)))
    )
    return buildGlobalTaskStats({
      runId: deps.runId,
      now,
      tasks: snap.tasks,
      runs: snap.runs,
      dispatches: snap.dispatches,
      requests: snap.requests,
      questions: snap.questions,
      columns: deps.columns,
      usage: (s) => collected.usage.get(s.key),
      isAlive: deps.isAlive,
      roleTitle: deps.roleTitle
    })
  }

  return { projectStats, taskStats, globalTaskStats }
}
