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
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  needs_input: 'Needs input',
  review: 'Review',
  done: 'Done'
}

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'shell'

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
}

export type EventType =
  | 'task_ready'
  | 'worker_done'
  | 'question'
  | 'escalation'
  | 'gate_answered'

export interface OrcaEvent {
  id: string
  type: EventType
  taskId?: string
  dispatchId?: string
  payload: Record<string, unknown>
  createdAt: number
  consumedBy?: string
}
