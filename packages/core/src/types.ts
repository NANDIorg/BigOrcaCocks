import type { AgentKind } from './agents'
export type { AgentKind }

// ---------- роли ----------

/** Роль проекта: кто выполняет задачу (агент + модель). */
export interface Role {
  id: string
  title: string
  agent: AgentKind
  /** Модель агента; пусто — по умолчанию. */
  model?: string
  /** Уровень рассуждений агента (см. effortOptions); пусто — по умолчанию. */
  effort?: string
  /**
   * Системный промпт роли: инструкции пользователя, которые дописываются к служебной инструкции Orca
   * (skills/worker.md или coordinator.md) при каждом запуске агента этой роли. Пусто — поля нет, поведение прежнее.
   */
  systemPrompt?: string
}

export const DEFAULT_ROLES: Role[] = [
  { id: 'coordinator', title: 'Координатор', agent: 'claude' },
  { id: 'developer', title: 'Программист', agent: 'claude' },
  { id: 'reviewer', title: 'Ревьюер', agent: 'claude' },
  { id: 'qa', title: 'QA', agent: 'claude' }
]

export const DEFAULT_ROLE_ID = 'developer'

/**
 * Служебная инструкция Orca + системный промпт роли одним текстом. Блок роли идёт после служебной
 * инструкции и не заменяет её; текст роли вставляется как есть (переносы строк, кавычки), обрезаются
 * только пробелы по краям. Нет роли или промпт пустой — служебная инструкция без изменений.
 */
export function withRoleInstructions(system: string, role: Pick<Role, 'title' | 'systemPrompt'> | undefined): string {
  const own = role?.systemPrompt?.trim()
  if (!own) return system
  return `${system}\n\n# Инструкции роли «${role!.title}»\n\n${own}`
}

// ---------- колонки ----------

/** Системные виды колонок: по ним store переводит задачи автоматически. */
export type SystemColumnKind = 'backlog' | 'ready' | 'in_progress' | 'needs_input' | 'review' | 'done'

/** Вид колонки: системная или произвольная пользовательская. */
export type ColumnKind = SystemColumnKind | 'custom'

export const SYSTEM_COLUMN_KINDS: SystemColumnKind[] = [
  'backlog',
  'ready',
  'in_progress',
  'needs_input',
  'review',
  'done'
]

export interface BoardColumn {
  id: string
  title: string
  /** Цвет заголовка, hex. */
  color: string
  kind: ColumnKind
}

/** 8 предустановленных цветов заголовка колонки. */
export const COLUMN_COLORS: { value: string; title: string }[] = [
  { value: '#6b6f7c', title: 'Серый' },
  { value: '#7b86f5', title: 'Синий' },
  { value: '#f08a3a', title: 'Оранжевый' },
  { value: '#e8b04a', title: 'Жёлтый' },
  { value: '#b57bee', title: 'Фиолетовый' },
  { value: '#5ad1cc', title: 'Бирюзовый' },
  { value: '#e5484d', title: 'Красный' },
  { value: '#2ea043', title: 'Зелёный' }
]

/** Колонки по умолчанию: id === kind, цвета — первые шесть из COLUMN_COLORS. */
export const DEFAULT_COLUMNS: BoardColumn[] = [
  { id: 'backlog', title: 'Бэклог', color: COLUMN_COLORS[0].value, kind: 'backlog' },
  { id: 'ready', title: 'Готовы', color: COLUMN_COLORS[1].value, kind: 'ready' },
  { id: 'in_progress', title: 'В работе', color: COLUMN_COLORS[2].value, kind: 'in_progress' },
  { id: 'needs_input', title: 'Нужен ответ', color: COLUMN_COLORS[3].value, kind: 'needs_input' },
  { id: 'review', title: 'Ревью', color: COLUMN_COLORS[4].value, kind: 'review' },
  { id: 'done', title: 'Сделано', color: COLUMN_COLORS[5].value, kind: 'done' }
]

/** Статус задачи — id колонки доски (см. BoardColumn). */
export type TaskStatus = string

/** @deprecated Колонки берутся из настроек проекта, это только дефолт. */
export const TASK_STATUSES: TaskStatus[] = DEFAULT_COLUMNS.map((c) => c.id)

/** @deprecated Названия колонок берутся из настроек проекта, это только дефолт. */
export const STATUS_TITLES: Record<string, string> = Object.fromEntries(
  DEFAULT_COLUMNS.map((c) => [c.id, c.title])
)

// ---------- прогоны ----------

/** Прогон: один координатор со своим набором задач. В проекте их может быть несколько. */
export interface Run {
  id: string
  objective: string
  createdAt: number
  /** Все задачи прогона дошли до kind=done (или прогон закрыт вручную). */
  closedAt?: number
  /** PTY координатора прогона. */
  coordinatorPtyId?: string
  /** Агент координатора: по нему решается, закрывать ли его терминал после run_done. */
  coordinatorAgent?: AgentKind
  /**
   * Координатор сообщил, что закончил работу по завершённому прогону (`orca-board runs finish`
   * последней командой, после run_done и сводки) — сигнал закрыть его терминал.
   */
  finishedAt?: number
}

// ---------- задачи ----------

export interface Task {
  id: string
  title: string
  spec: string
  /** Id колонки доски. */
  status: TaskStatus
  deps: string[]
  /** Прогон, к которому относится задача; нет — задача создана из UI вне прогона. */
  runId?: string
  /** Роль проекта: агент и модель берутся из неё; `agent` — снимок на момент создания/запуска. */
  roleId: string
  agent: AgentKind
  worktree?: string
  branch?: string
  dispatchId?: string
  /** Замечания после ревью, попадут в промпт при перезапуске. */
  feedback?: string
  createdAt: number
  updatedAt: number
  /** Первый startDispatch. */
  startedAt?: number
  /** Момент попадания в колонку kind=done. */
  doneAt?: number
}

export type DispatchOutcome = 'done' | 'failed' | 'unknown'

export interface Dispatch {
  id: string
  taskId: string
  ptyId: string
  startedAt: number
  endedAt?: number
  outcome?: DispatchOutcome
  summary?: string
  files?: string[]
  /** Уже отправили эскалацию «нет вывода». */
  stuckNotified?: boolean
}

export interface Question {
  id: string
  taskId: string
  dispatchId?: string
  question: string
  options: string[]
  answer?: string
  createdAt: number
  answeredAt?: number
}

export type EventType =
  | 'task_ready'
  | 'worker_done'
  | 'question'
  | 'escalation'
  | 'question_answered'
  | 'run_done'

export const EVENT_TYPES: EventType[] = [
  'task_ready',
  'worker_done',
  'question',
  'escalation',
  'question_answered',
  'run_done'
]

export interface OrcaEvent {
  id: string
  type: EventType
  taskId?: string
  dispatchId?: string
  payload: Record<string, unknown>
  createdAt: number
  consumedBy?: string
}
