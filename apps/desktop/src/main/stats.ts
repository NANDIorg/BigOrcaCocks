/**
 * Статистика проекта в main (docs/architecture.md → «Статистика»): снапшот store + транскрипты агентов на диске →
 * `buildProjectStats` (core). Считается по запросу, в store пишутся только найденные id сессий codex.
 */
import { join } from 'node:path'
import {
  buildGlobalTaskStats, buildProjectStats, buildTaskStats, statsRangeStart, statsSessions,
  type BoardColumn, type GlobalTaskStats, type ProjectStats, type StatsRange, type StatsSession, type StoreSnapshot, type TaskStats,
  type TaskStore, type Workflow
} from '@orca-board/core'
import { collectSessionUsage, TranscriptCache, transcriptEnv, type TranscriptEnv } from './transcripts'

/** Что нужно любой статистике из main: store, корень репозитория и то, что знает только main. */
export interface StatsDeps {
  store: TaskStore
  repoRoot: string
  columns: readonly BoardColumn[]
  roleTitle: (roleId: string) => string | undefined
  isAlive: (ptyId: string) => boolean
  now?: number
  env?: TranscriptEnv
  cache?: TranscriptCache
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

/** Кэш транскриптов на процесс: повторный запрос дочитывает только дописанное. */
const sharedCache = new TranscriptCache()

/** Расход сессий снапшота, отобранных `include`; найденные id сессий codex запоминаются в store. */
async function collectUsage(deps: StatsDeps, snap: StoreSnapshot, now: number, include: (s: StatsSession) => boolean) {
  const tasks = new Map(snap.tasks.map((t) => [t.id, t]))
  const collected = await collectSessionUsage(statsSessions(snap), {
    env: deps.env ?? transcriptEnv(),
    cache: deps.cache ?? sharedCache,
    repoRoot: deps.repoRoot,
    // Worktree воркера — как в startWorker; у задач от старого кода поля может не быть.
    worktree: (taskId) => tasks.get(taskId)?.worktree ?? join(deps.repoRoot, '..', '.orca-worktrees', taskId),
    now,
    include
  })
  for (const [dispatchId, sessionId] of collected.found) deps.store.setDispatchSessionId(dispatchId, sessionId)
  return collected
}

export async function projectStats(deps: ProjectStatsDeps): Promise<ProjectStats> {
  const now = deps.now ?? Date.now()
  const snap = deps.store.snapshot()
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
export async function taskStats(deps: TaskStatsDeps): Promise<TaskStats> {
  const now = deps.now ?? Date.now()
  const snap = deps.store.snapshot()
  if (!snap.tasks.some((t) => t.id === deps.taskId)) throw new Error(`статистика: задачи ${deps.taskId} нет в проекте`)
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
export async function globalTaskStats(deps: GlobalTaskStatsDeps): Promise<GlobalTaskStats> {
  const now = deps.now ?? Date.now()
  const snap = deps.store.snapshot()
  if (!snap.runs.some((r) => r.id === deps.runId)) throw new Error(`статистика: глобальной задачи ${deps.runId} нет в проекте`)
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
