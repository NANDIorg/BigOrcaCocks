/**
 * Глобальные задачи — верхний уровень двухуровневой доски (см. docs/nested-kanban.md).
 * Глобальная задача — это прогон (`Run`), её подзадачи — задачи с `Task.runId === run.id`.
 * Здесь — чистое представление для API и renderer: без Node и без store, только данные.
 */
import type { BoardColumn, ColumnKind, HumanRequest, Run, StageChange, StatusChange, Task, TaskPriority } from './types'
import type { RunGit } from './run-branch'
import type { WfStage } from './workflow'
import { DEFAULT_TASK_PRIORITY, isTaskPriority } from './types.ts'
import { activeDuration, taskActiveTime } from './active-time.ts'

/** Название «Входящих» — служебной глобальной задачи для задач без глобальной. */
export const INBOX_TITLE = 'Входящие'

/**
 * Виды колонок, в которых хранится глобальная задача (`Run.status`): сюда её ставят система и человек.
 * Системная колонка review на верхнем уровне — «Проверка» (`GLOBAL_REVIEW_TITLE`): работа закрыта и ждёт
 * приёмки человеком. Готовы (и пользовательские) — этапы подзадач на локальном канбане; на верхнем уровне их нет.
 */
export const GLOBAL_COLUMN_KINDS = ['backlog', 'in_progress', 'review', 'done'] as const
export type GlobalColumnKind = (typeof GLOBAL_COLUMN_KINDS)[number]

/**
 * Колонки, которые показывает глобальный канбан: хранимые плюс needs_input. В needs_input карточка
 * попадает только вычисленно — задача не сделана, и в прогоне есть pending-запрос к человеку
 * (`hasPendingRequest`); человек решил запрос — карточка сама возвращается в свою колонку. Руками туда не ставится.
 */
export const GLOBAL_BOARD_KINDS: readonly ColumnKind[] = ['backlog', 'in_progress', 'needs_input', 'review', 'done']

/**
 * Заголовок колонки kind=review на глобальном канбане. У подзадач review — ревью кода агентом, у глобальной
 * задачи — приёмка результата человеком, поэтому название колонки проекта здесь подменяется.
 */
export const GLOBAL_REVIEW_TITLE = 'Проверка'

/** Уточнение человека при возврате глобальной задачи с проверки в работу (`Run.returns`). */
export interface GlobalTaskReturn {
  at: number
  text: string
}

/** Сводка координатора «что сделано» (`Run.summary`, `runs finish --summary`). */
export interface GlobalTaskSummary {
  at: number
  /** Markdown. */
  text: string
}

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
  /** Приоритет (`Run.priority`); у прогона без поля или с неизвестным значением — normal. */
  priority: TaskPriority
  inbox: boolean
  /** Тип задачи (`Run.typeId`); нет — «Входящие» или прогон до типов: действует тип проекта по умолчанию. */
  typeId?: string
  /**
   * Название типа из снимка прогона (`Run.taskType.title`) — на момент создания; живое название (тип могли
   * переименовать) UI берёт из библиотеки по `typeId`.
   */
  typeTitle?: string
  createdAt: number
  updatedAt: number
  /** Последнее изменение карточки или любой её подзадачи — «время» на карточке. */
  activityAt: number
  /** Pending-запросы к человеку в прогоне; > 0 и задача не сделана — карточка в needs_input. */
  waiting: number
  /** Прогон закрыт: все подзадачи дошли до done (run_done) или закрыт вручную. */
  closedAt?: number
  finishedAt?: number
  coordinatorPtyId?: string
  coordinatorAgent?: Run['coordinatorAgent']
  /** Уточнения человека при возвратах с проверки в работу, по порядку (`Run.returns`); нет — не возвращали. */
  returns?: GlobalTaskReturn[]
  /** Итоговая сводка координатора (`Run.summary`); нет — не передавал. */
  summary?: GlobalTaskSummary
  /** Ветка глобальной задачи (`Run.git`, копия); нет — подзадачи сливаются в текущую ветку корня. */
  git?: RunGit
  /**
   * История смены колонки (`Run.statusHistory`, копия): хранимые статусы — «Нужен ответ» карточка получает на лету
   * по запросам, в истории его нет. Нет — прогон от старого main (renderer обновился по HMR раньше).
   */
  statusHistory?: StatusChange[]
  /** Воркфлоу идёт по глобальной задаче (`Run.workflowScope`); нет — старый движок по подзадачам или «Входящие». */
  workflowScope?: 'run'
  /** Позиция на графе (`Run.stage`, копия); нет — граф не начат или прогон старого формата. */
  stage?: WfStage
  /** История входов в этапы (`Run.stageHistory`, копия); нет — как у `stage`. */
  stageHistory?: StageChange[]
  progress: GlobalTaskProgress
  /**
   * Основное время — сколько сама глобальная задача была в работе (`Run.activeMs`): закрытые отрезки, мс.
   * Копится, только пока карточка показана в колонке kind=in_progress; в «Нужен ответ», бэклоге и done стоит.
   * Нет поля — своё время неизвестно (прогон от старого кода) или карточка от старого main: показывать только
   * сумму подзадач. Длительность — `globalOwnDuration`.
   */
  ownActiveMs?: number
  /** Начало текущего отрезка основного времени; нет — стоит. */
  ownActiveSince?: number
  /** Когда задача впервые вошла в работу (`Run.startedAt`); нет — ещё не была «В работе» (или карточка от старого main). */
  startedAt?: number
  /**
   * Сумма времени работы подзадач (`taskActiveTime`): закрытые отрезки, мс. Параллельные подзадачи
   * складываются — это трудозатраты агентов, а не календарное время.
   */
  subtasksActiveMs: number
  /** Начала текущих отрезков подзадач в работе: пусто — сумма стоит; длительность — `globalSubtasksDuration`. */
  subtasksActiveSince: number[]
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

/** Время работы подзадач прогона: сумма закрытых отрезков и начала идущих. */
export function globalSubtasksTime(runId: string, tasks: readonly Task[]): Pick<GlobalTask, 'subtasksActiveMs' | 'subtasksActiveSince'> {
  let subtasksActiveMs = 0
  const subtasksActiveSince: number[] = []
  for (const t of tasks) {
    if (t.runId !== runId) continue
    const a = taskActiveTime(t)
    if (!a) continue
    subtasksActiveMs += a.closedMs
    if (a.since !== undefined) subtasksActiveSince.push(a.since)
  }
  return { subtasksActiveMs, subtasksActiveSince }
}

/** Сумма времени подзадач на момент now: закрытое время плюс идущие отрезки. */
export function globalSubtasksDuration(g: Pick<GlobalTask, 'subtasksActiveMs' | 'subtasksActiveSince'>, now: number): number {
  return g.subtasksActiveSince.reduce((sum, since) => sum + Math.max(0, now - since), g.subtasksActiveMs)
}

/** Основное время глобальной задачи на момент now; своё время неизвестно — undefined. */
export function globalOwnDuration(g: Pick<GlobalTask, 'ownActiveMs' | 'ownActiveSince'>, now: number): number | undefined {
  if (g.ownActiveMs === undefined && g.ownActiveSince === undefined) return undefined
  return activeDuration({ closedMs: g.ownActiveMs ?? 0, ...(g.ownActiveSince !== undefined ? { since: g.ownActiveSince } : {}) }, now)
}

/**
 * Колонки проекта, которые показывает глобальный канбан (порядок проекта сохраняется), включая needs_input.
 * Колонка review называется «Проверка» (`GLOBAL_REVIEW_TITLE`), id и цвет — от колонки проекта.
 */
export function globalBoardColumns(columns: readonly BoardColumn[]): BoardColumn[] {
  return columns
    .filter((c) => GLOBAL_BOARD_KINDS.includes(c.kind))
    .map((c) => (c.kind === 'review' ? { ...c, title: GLOBAL_REVIEW_TITLE } : c))
}

/** Колонки, куда глобальную задачу можно поставить (создание, перенос): без вычисляемой needs_input. */
export function globalStoredColumns(columns: readonly BoardColumn[]): BoardColumn[] {
  return columns.filter((c) => (GLOBAL_COLUMN_KINDS as readonly ColumnKind[]).includes(c.kind))
}

/**
 * Запрос ждёт человека. Единственный источник «Нужен ответ» — и для глобальной карточки, и для колонки
 * подзадачи, и для счётчиков: статус хранится в запросе, а не выводится из колонок и координатора.
 */
export function isPendingRequest(r: Pick<HumanRequest, 'status'>): boolean {
  return r.status === 'pending'
}

/** Pending-запросы прогона (`runId`) или подзадачи (`taskId`). */
export function pendingRequestsOf(requests: readonly HumanRequest[], where: { runId?: string; taskId?: string }): HumanRequest[] {
  return requests.filter((r) => isPendingRequest(r) && (where.runId === undefined || r.runId === where.runId) && (where.taskId === undefined || r.taskId === where.taskId))
}

/** Есть ли pending-запрос у прогона/подзадачи. */
export function hasPendingRequest(requests: readonly HumanRequest[], where: { runId?: string; taskId?: string }): boolean {
  return pendingRequestsOf(requests, where).length > 0
}

/**
 * Куда встаёт глобальная задача из колонки этого вида: ready — ещё не начата (backlog),
 * needs_input/custom — работа идёт (in_progress). Неизвестная колонка — backlog.
 */
export function globalColumnKind(kind: ColumnKind | undefined): GlobalColumnKind {
  if (kind === 'backlog' || kind === 'in_progress' || kind === 'review' || kind === 'done') return kind
  if (kind === 'ready' || kind === undefined) return 'backlog'
  return 'in_progress'
}

/**
 * Хранимый статус глобальной задачи → id колонки, где она может храниться (backlog / in_progress / review / done).
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
 * Колонка, в которой показывается карточка: хранимый статус, сведённый к глобальному канбану (globalTaskStatus);
 * несделанная задача с pending-запросами (`waiting` > 0) — в needs_input, если такая колонка есть в проекте.
 * Карточка в done или review (работа закрыта) в needs_input не поднимается.
 */
export function globalDisplayStatus(run: Pick<Run, 'status'>, columns: readonly BoardColumn[], waiting: number): string {
  const stored = globalTaskStatus(run.status, columns) ?? 'backlog'
  const needsInput = columns.find((c) => c.kind === 'needs_input')?.id
  const storedKind = columns.find((c) => c.id === stored)?.kind
  return waiting > 0 && needsInput && storedKind !== 'done' && storedKind !== 'review' ? needsInput : stored
}

/**
 * Идёт ли сейчас собственное время глобальной задачи: карточка показана в колонке kind=in_progress.
 * «Нужен ответ» — ожидание человека, как у подзадач, время стоит.
 */
export function globalTaskInProgress(run: Pick<Run, 'id' | 'status'>, columns: readonly BoardColumn[], requests: readonly HumanRequest[]): boolean {
  const status = globalDisplayStatus(run, columns, pendingRequestsOf(requests, { runId: run.id }).length)
  return columns.find((c) => c.id === status)?.kind === 'in_progress'
}

/** Что нужно знать о глобальной задаче, чтобы решить, можно ли сменить её тип. */
export interface RunTypeLockInput {
  inbox?: boolean
  /** `Run.startedAt` / `GlobalTask.startedAt`. */
  startedAt?: number
  coordinatorPtyId?: string
  /** Число подзадач. */
  subtasks: number
  /** Вид колонки, где стоит карточка. */
  statusKind: ColumnKind | undefined
}

/**
 * Почему тип глобальной задачи сменить нельзя; undefined — можно. Тип задаёт роли, правила и граф прогона,
 * поэтому он меняется только до начала работы: карточка в бэклоге, ни разу не была «В работе» (`startedAt`),
 * координатор не запускался и подзадач нет — иначе идущие подзадачи остались бы с ролями и этапами старого типа.
 * «Входящие» — служебная задача без типа.
 */
export function runTypeLockReason(x: RunTypeLockInput): string | undefined {
  if (x.inbox) return '«Входящие» — служебная задача, у неё нет своего типа'
  if (x.startedAt !== undefined) return 'задача уже была «В работе»'
  if (x.coordinatorPtyId !== undefined) return 'по задаче уже запускался координатор'
  if (x.subtasks > 0) return `у задачи уже есть подзадачи (${x.subtasks})`
  if (x.statusKind !== 'backlog') return 'тип меняется только, пока задача в бэклоге'
  return undefined
}

/** Можно ли сменить тип глобальной задачи (`runTypeLockReason`). */
export function canChangeRunType(x: RunTypeLockInput): boolean {
  return runTypeLockReason(x) === undefined
}

/** Прогон → карточка; колонка — `globalDisplayStatus`. */
export function toGlobalTask(
  run: Run,
  tasks: readonly Task[],
  columns: readonly BoardColumn[],
  requests: readonly HumanRequest[] = []
): GlobalTask {
  const columnKind = (status: string): ColumnKind | undefined => columns.find((c) => c.id === status)?.kind
  const updatedAt = run.updatedAt ?? run.createdAt
  const own = tasks.filter((t) => t.runId === run.id)
  const activityAt = own.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), updatedAt)
  const waiting = pendingRequestsOf(requests, { runId: run.id }).length
  const status = globalDisplayStatus(run, columns, waiting)
  return {
    id: run.id,
    title: globalTaskTitle(run),
    description: run.objective,
    status,
    priority: isTaskPriority(run.priority) ? run.priority : DEFAULT_TASK_PRIORITY,
    inbox: run.inbox === true,
    ...(run.typeId !== undefined ? { typeId: run.typeId } : {}),
    ...(run.taskType ? { typeTitle: run.taskType.title } : {}),
    createdAt: run.createdAt,
    updatedAt,
    activityAt,
    closedAt: run.closedAt,
    finishedAt: run.finishedAt,
    coordinatorPtyId: run.coordinatorPtyId,
    coordinatorAgent: run.coordinatorAgent,
    ...(run.returns && run.returns.length > 0 ? { returns: run.returns.map((r) => ({ ...r })) } : {}),
    ...(run.summary ? { summary: { ...run.summary } } : {}),
    ...(run.git ? { git: { ...run.git } } : {}),
    ...(run.statusHistory ? { statusHistory: run.statusHistory.map((h) => ({ ...h })) } : {}),
    ...(run.workflowScope ? { workflowScope: run.workflowScope } : {}),
    ...(run.stage ? { stage: { nodeId: run.stage.nodeId, visits: { ...run.stage.visits } } } : {}),
    ...(run.stageHistory ? { stageHistory: run.stageHistory.map((h) => ({ ...h })) } : {}),
    progress: globalTaskProgress(run.id, tasks, columnKind),
    ...(run.activeMs !== undefined ? { ownActiveMs: run.activeMs } : {}),
    ...(run.activeSince !== undefined ? { ownActiveSince: run.activeSince } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...globalSubtasksTime(run.id, tasks),
    waiting
  }
}

/** Все карточки в порядке создания. */
export function toGlobalTasks(
  runs: readonly Run[],
  tasks: readonly Task[],
  columns: readonly BoardColumn[],
  requests: readonly HumanRequest[] = []
): GlobalTask[] {
  return [...runs].sort((a, b) => a.createdAt - b.createdAt).map((run) => toGlobalTask(run, tasks, columns, requests))
}
