import type { Dispatch, OrcaEvent, Task, TaskStatus, AgentKind, EventType } from './types'

export interface StoreSnapshot {
  tasks: Task[]
  dispatches: Dispatch[]
  events: OrcaEvent[]
}

export interface Persistence {
  load(): StoreSnapshot | null
  save(snapshot: StoreSnapshot): void
}

let counter = 0
export function newId(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`
}

/**
 * Единственный владелец состояния доски. Живёт в main-процессе Electron.
 * Переход задачи в `ready` — автоматический, когда все deps в `done`.
 */
export class TaskStore {
  private tasks = new Map<string, Task>()
  private dispatches = new Map<string, Dispatch>()
  private events: OrcaEvent[] = []
  private listeners = new Set<() => void>()

  constructor(private persistence?: Persistence) {
    const snap = persistence?.load()
    if (snap) {
      snap.tasks.forEach((t) => this.tasks.set(t.id, t))
      snap.dispatches.forEach((d) => this.dispatches.set(d.id, d))
      this.events = snap.events
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(): void {
    this.persistence?.save(this.snapshot())
    this.listeners.forEach((fn) => fn())
  }

  snapshot(): StoreSnapshot {
    return {
      tasks: [...this.tasks.values()],
      dispatches: [...this.dispatches.values()],
      events: [...this.events]
    }
  }

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  createTask(input: {
    title: string
    spec?: string
    deps?: string[]
    agent?: AgentKind
  }): Task {
    const now = Date.now()
    const task: Task = {
      id: newId('task'),
      title: input.title,
      spec: input.spec ?? '',
      status: 'backlog',
      deps: input.deps ?? [],
      agent: input.agent ?? 'claude',
      createdAt: now,
      updatedAt: now
    }
    this.tasks.set(task.id, task)
    this.promoteReady()
    this.commit()
    return task
  }

  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task {
    const task = this.mustTask(id)
    Object.assign(task, patch, { updatedAt: Date.now() })
    this.promoteReady()
    this.commit()
    return task
  }

  moveTask(id: string, status: TaskStatus): Task {
    return this.updateTask(id, { status })
  }

  deleteTask(id: string): void {
    this.tasks.delete(id)
    this.commit()
  }

  /** backlog → ready, если все зависимости закрыты. */
  private promoteReady(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'backlog') continue
      const depsDone = task.deps.every((d) => this.tasks.get(d)?.status === 'done')
      if (depsDone) {
        task.status = 'ready'
        this.pushEvent('task_ready', { taskId: task.id })
      }
    }
  }

  startDispatch(taskId: string, ptyId: string): Dispatch {
    const task = this.mustTask(taskId)
    const dispatch: Dispatch = {
      id: newId('disp'),
      taskId,
      ptyId,
      startedAt: Date.now()
    }
    this.dispatches.set(dispatch.id, dispatch)
    task.dispatchId = dispatch.id
    task.status = 'in_progress'
    task.updatedAt = Date.now()
    this.commit()
    return dispatch
  }

  /** Явное завершение воркером через `orca-board done`. */
  finishDispatch(dispatchId: string, summary: string, files: string[] = []): Dispatch {
    const dispatch = this.mustDispatch(dispatchId)
    dispatch.endedAt = Date.now()
    dispatch.outcome = 'done'
    dispatch.summary = summary
    dispatch.files = files
    const task = this.mustTask(dispatch.taskId)
    task.status = 'review'
    task.updatedAt = Date.now()
    this.pushEvent('worker_done', { taskId: task.id, dispatchId, summary, files })
    this.commit()
    return dispatch
  }

  /** PTY закрылся без `done` — это не успех, это `unknown`. */
  ptyExited(ptyId: string, exitCode: number): void {
    for (const dispatch of this.dispatches.values()) {
      if (dispatch.ptyId !== ptyId || dispatch.endedAt) continue
      dispatch.endedAt = Date.now()
      dispatch.outcome = exitCode === 0 ? 'unknown' : 'failed'
      const task = this.mustTask(dispatch.taskId)
      task.status = 'needs_input'
      task.updatedAt = Date.now()
      this.pushEvent('escalation', {
        taskId: task.id,
        dispatchId: dispatch.id,
        reason: `pty exited with code ${exitCode} without explicit done`
      })
    }
    this.commit()
  }

  pushEvent(type: EventType, payload: Record<string, unknown>): OrcaEvent {
    const event: OrcaEvent = {
      id: newId('evt'),
      type,
      taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
      dispatchId: typeof payload.dispatchId === 'string' ? payload.dispatchId : undefined,
      payload,
      createdAt: Date.now()
    }
    this.events.push(event)
    return event
  }

  listEvents(): OrcaEvent[] {
    return [...this.events]
  }

  private mustTask(id: string): Task {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`task not found: ${id}`)
    return task
  }

  private mustDispatch(id: string): Dispatch {
    const dispatch = this.dispatches.get(id)
    if (!dispatch) throw new Error(`dispatch not found: ${id}`)
    return dispatch
  }
}
