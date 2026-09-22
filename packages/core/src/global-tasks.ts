/**
 * Глобальные задачи — верхний уровень двухуровневой доски (см. docs/nested-kanban.md).
 * Глобальная задача — это прогон (`Run`), её подзадачи — задачи с `Task.runId === run.id`.
 * Здесь — чистое представление для API и renderer: без Node и без store, только данные.
 */
import type { BoardColumn, ColumnKind, Question, Run, Task } from './types'

/** Название «Входящих» — служебной глобальной задачи для задач без глобальной. */
export const INBOX_TITLE = 'Входящие'

/**
 * Виды колонок, в которых хранится глобальная задача (`Run.status`): сюда её ставят система и человек.
 * Готовы/Ревью (и пользовательские) — этапы подзадач на локальном канбане; на верхнем уровне их нет.
 */
export const GLOBAL_COLUMN_KINDS = ['backlog', 'in_progress', 'done'] as const
export type GlobalColumnKind = (typeof GLOBAL_COLUMN_KINDS)[number]

/**
 * Колонки, которые показывает глобальный канбан: хранимые плюс needs_input. В needs_input карточка
 * попадает только вычисленно — задача не сделана, и хотя бы одна подзадача ждёт человека
 * (`waitingForHuman`); ответил человек — карточка сама возвращается в свою колонку. Руками туда не ставится.
 */
export const GLOBAL_BOARD_KINDS: readonly ColumnKind[] = ['backlog', 'in_progress', 'needs_input', 'done']

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
  /** Подзадачи, которые ждут человека (`waitingForHuman`); > 0 и задача в работе — карточка в needs_input. */
  waiting: number
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

/** Колонки проекта, которые показывает глобальный канбан (порядок проекта сохраняется), включая needs_input. */
export function globalBoardColumns(columns: readonly BoardColumn[]): BoardColumn[] {
  return columns.filter((c) => GLOBAL_BOARD_KINDS.includes(c.kind))
}

/** Колонки, куда глобальную задачу можно поставить (создание, перенос): без вычисляемой needs_input. */
export function globalStoredColumns(columns: readonly BoardColumn[]): BoardColumn[] {
  return columns.filter((c) => (GLOBAL_COLUMN_KINDS as readonly ColumnKind[]).includes(c.kind))
}

/**
 * Вопрос адресован человеку: координатор передал его (`forHuman`) или отвечать больше некому —
 * «Входящие», глобальная задача без координатора или координатор уже закончил (`runs finish`).
 */
export function questionForHuman(q: Pick<Question, 'forHuman'>, run: Pick<Run, 'inbox' | 'coordinatorPtyId' | 'finishedAt'> | undefined): boolean {
  if (q.forHuman) return true
  return !run || run.inbox === true || !run.coordinatorPtyId || run.finishedAt !== undefined
}

/**
 * Подзадача ждёт человека: готов ответ для человека (задача-ответ `answerFor: 'human'` в колонке
 * needs_input; review — старые данные, до переноса таких ответов в needs_input) или открыт вопрос, адресованный человеку (`questionForHuman`).
 */
export function waitingForHuman(
  task: Pick<Task, 'id' | 'answerFor'>,
  kind: ColumnKind | undefined,
  questions: readonly Question[],
  run: Pick<Run, 'inbox' | 'coordinatorPtyId' | 'finishedAt'> | undefined
): boolean {
  if (task.answerFor === 'human' && (kind === 'needs_input' || kind === 'review')) return true
  return questions.some((q) => q.taskId === task.id && !q.answeredAt && questionForHuman(q, run))
}

/**
 * Куда встаёт глобальная задача из колонки этого вида: ready — ещё не начата (backlog),
 * needs_input/review/custom — работа идёт (in_progress). Неизвестная колонка — backlog.
 */
export function globalColumnKind(kind: ColumnKind | undefined): GlobalColumnKind {
  if (kind === 'backlog' || kind === 'in_progress' || kind === 'done') return kind
  if (kind === 'ready' || kind === undefined) return 'backlog'
  return 'in_progress'
}

/**
 * Хранимый статус глобальной задачи → id колонки, где она может храниться (backlog / in_progress / done).
 * Статус из другой колонки (старые данные, ручная правка, needs_input) сводится к ближайшей — карточка
 * не пропадает с доски. Колонки нужного вида нет — первая подходящая; подходящих нет — статус как есть.
 */
export function globalTaskStatus(status: string | undefined, columns: readonly BoardColumn[]): string | undefined {
  const visible = globalStoredColumns(columns)
  if (status !== undefined && visible.some((c) => c.id === status)) return status
  const target = globalColumnKind(columns.find((c) => c.id === status)?.kind)
  return visible.find((c) => c.kind === target)?.id ?? visible[0]?.id ?? status
}

/**
 * Прогон → карточка. Статус сведён к колонке глобального канбана (globalTaskStatus); несделанная задача,
 * у которой подзадачи ждут человека, показывается в колонке needs_input (если она есть в проекте).
 */
export function toGlobalTask(
  run: Run,
  tasks: readonly Task[],
  columns: readonly BoardColumn[],
  questions: readonly Question[] = []
): GlobalTask {
  const columnKind = (status: string): ColumnKind | undefined => columns.find((c) => c.id === status)?.kind
  const updatedAt = run.updatedAt ?? run.createdAt
  const own = tasks.filter((t) => t.runId === run.id)
  const activityAt = own.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), updatedAt)
  const waiting = own.filter((t) => waitingForHuman(t, columnKind(t.status), questions, run)).length
  const stored = globalTaskStatus(run.status, columns) ?? 'backlog'
  const needsInput = columns.find((c) => c.kind === 'needs_input')?.id
  const status = waiting > 0 && needsInput && columnKind(stored) !== 'done' ? needsInput : stored
  return {
    id: run.id,
    title: globalTaskTitle(run),
    description: run.objective,
    status,
    inbox: run.inbox === true,
    createdAt: run.createdAt,
    updatedAt,
    activityAt,
    closedAt: run.closedAt,
    finishedAt: run.finishedAt,
    coordinatorPtyId: run.coordinatorPtyId,
    coordinatorAgent: run.coordinatorAgent,
    progress: globalTaskProgress(run.id, tasks, columnKind),
    waiting
  }
}

/** Все карточки в порядке создания. */
export function toGlobalTasks(
  runs: readonly Run[],
  tasks: readonly Task[],
  columns: readonly BoardColumn[],
  questions: readonly Question[] = []
): GlobalTask[] {
  return [...runs].sort((a, b) => a.createdAt - b.createdAt).map((run) => toGlobalTask(run, tasks, columns, questions))
}
