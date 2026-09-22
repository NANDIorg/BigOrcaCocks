export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'needs_input'
  | 'review'
  | 'done'

export const TASK_STATUSES: TaskStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'needs_input',
  'review',
  'done'
]

export const STATUS_TITLES: Record<TaskStatus, string> = {
  backlog: 'Бэклог',
  ready: 'Готовы',
  in_progress: 'В работе',
  needs_input: 'Нужен ответ',
  review: 'Ревью',
  done: 'Сделано'
}

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'shell'

export const AGENT_TITLES: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  shell: 'Оболочка'
}

export interface Task {
  id: string
  title: string
  spec: string
  status: TaskStatus
  deps: string[]
  agent: AgentKind
  worktree?: string
  branch?: string
  dispatchId?: string
  /** Замечания после ревью, попадут в промпт при перезапуске. */
  feedback?: string
  createdAt: number
  updatedAt: number
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

export const EVENT_TYPES: EventType[] = ['task_ready', 'worker_done', 'question', 'escalation', 'question_answered']

export interface OrcaEvent {
  id: string
  type: EventType
  taskId?: string
  dispatchId?: string
  payload: Record<string, unknown>
  createdAt: number
  consumedBy?: string
}
