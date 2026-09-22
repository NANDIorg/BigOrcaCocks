/**
 * Глобальные задачи — верхний уровень двухуровневой доски (см. docs/nested-kanban.md).
 * Глобальная задача — это прогон (`Run`), её подзадачи — задачи с `Task.runId === run.id`.
 * Здесь — чистое представление для API и renderer: без Node и без store, только данные.
 */
import type { ColumnKind, Run, Task } from './types'

/** Название «Входящих» — служебной глобальной задачи для задач без глобальной. */
export const INBOX_TITLE = 'Входящие'

/** Длина названия, выведенного из описания. */
const DERIVED_TITLE_MAX = 80

/** Прогресс подзадач глобальной задачи. */
export interface GlobalTaskProgress {
  /** Всего подзадач. */
  total: number
  /** Из них в колонке kind=done. */
  done: number
  /** Число подзадач по id колонки (только непустые). */
  byStatus: Record<string, number>
  /** Число подзадач по kind колонки (только непустые; неизвестная колонка — не считается). */
  byKind: Partial<Record<ColumnKind, number>>
}

/** Карточка глобальной задачи для API и UI. */
export interface GlobalTask {
  id: string
  title: string
  description: string
  /** Id колонки проекта. */
  status: string
  inbox: boolean
  createdAt: number
  updatedAt: number
  /** Последнее изменение карточки или любой её подзадачи — «время» на карточке. */
  activityAt: number
  /** Прогон закрыт: все подзадачи дошли до done (run_done) или закрыт вручную. */
  closedAt?: number
  finishedAt?: number
  coordinatorPtyId?: string
  coordinatorAgent?: Run['coordinatorAgent']
  progress: GlobalTaskProgress
}

/** Название карточки: заданное, иначе первая непустая строка описания (обрезанная), иначе id. */
export function globalTaskTitle(run: Pick<Run, 'id' | 'title' | 'objective' | 'inbox'>): string {
  const own = run.title?.trim()
  if (own) return own
  if (run.inbox) return INBOX_TITLE
  const line = run.objective.split('\n').map((l) => l.trim()).find(Boolean)
  if (!line) return run.id
  return line.length > DERIVED_TITLE_MAX ? `${line.slice(0, DERIVED_TITLE_MAX - 1)}…` : line
}

export function globalTaskProgress(
  runId: string,
  tasks: readonly Task[],
  columnKind: (status: string) => ColumnKind | undefined
): GlobalTaskProgress {
  const progress: GlobalTaskProgress = { total: 0, done: 0, byStatus: {}, byKind: {} }
  for (const t of tasks) {
    if (t.runId !== runId) continue
    progress.total += 1
    progress.byStatus[t.status] = (progress.byStatus[t.status] ?? 0) + 1
    const kind = columnKind(t.status)
    if (kind) progress.byKind[kind] = (progress.byKind[kind] ?? 0) + 1
    if (kind === 'done') progress.done += 1
  }
  return progress
}

/**
 * Прогон → карточка. `fallbackStatus` — колонка для прогона без status (снапшот до миграции;
 * store мигрирует при загрузке, так что в живых данных это не встречается).
 */
export function toGlobalTask(
  run: Run,
  tasks: readonly Task[],
  columnKind: (status: string) => ColumnKind | undefined,
  fallbackStatus = 'backlog'
): GlobalTask {
  const updatedAt = run.updatedAt ?? run.createdAt
  const activityAt = tasks.reduce((max, t) => (t.runId === run.id && t.updatedAt > max ? t.updatedAt : max), updatedAt)
  return {
    id: run.id,
    title: globalTaskTitle(run),
    description: run.objective,
    status: run.status ?? fallbackStatus,
    inbox: run.inbox === true,
    createdAt: run.createdAt,
    updatedAt,
    activityAt,
    closedAt: run.closedAt,
    finishedAt: run.finishedAt,
    coordinatorPtyId: run.coordinatorPtyId,
    coordinatorAgent: run.coordinatorAgent,
    progress: globalTaskProgress(run.id, tasks, columnKind)
  }
}

/** Все карточки в порядке создания. */
export function toGlobalTasks(
  runs: readonly Run[],
  tasks: readonly Task[],
  columnKind: (status: string) => ColumnKind | undefined,
  fallbackStatus?: string
): GlobalTask[] {
  return [...runs]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((run) => toGlobalTask(run, tasks, columnKind, fallbackStatus))
}
