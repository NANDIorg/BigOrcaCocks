import type { Dispatch, OrcaEvent, Task, TaskStatus, AgentKind, EventType, Question } from './types'

export interface StoreSnapshot {
  tasks: Task[]
  dispatches: Dispatch[]
  events: OrcaEvent[]
  questions: Question[]
}

export interface Persistence {
  load(): Partial<StoreSnapshot> | null
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
  private questions = new Map<string, Question>()
  private events: OrcaEvent[] = []
  private listeners = new Set<() => void>()

  constructor(private persistence?: Persistence) {
    const snap = persistence?.load()
    if (snap) {
      snap.tasks?.forEach((t) => this.tasks.set(t.id, t))
      snap.dispatches?.forEach((d) => this.dispatches.set(d.id, d))
      snap.questions?.forEach((q) => this.questions.set(q.id, q))
      this.events = snap.events ?? []
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
      tasks: this.listTasks(),
      dispatches: [...this.dispatches.values()],
      events: [...this.events],
      questions: [...this.questions.values()]
    }
  }

  // ---------- tasks ----------

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  createTask(input: { title: string; spec?: string; deps?: string[]; agent?: AgentKind }): Task {
    const now = Date.now()
    const task: Task = {
      id: newId('task'),
      title: input.title,
      spec: input.spec ?? '',
      status: 'backlog',
      deps: (input.deps ?? []).filter((d) => this.tasks.has(d)),
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
    this.promoteReady()
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

  // ---------- dispatches ----------

  getDispatch(id: string): Dispatch | undefined {
    return this.dispatches.get(id)
  }

  startDispatch(taskId: string, ptyId: string, dispatchId = newId('disp')): Dispatch {
    const task = this.mustTask(taskId)
    const dispatch: Dispatch = { id: dispatchId, taskId, ptyId, startedAt: Date.now() }
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
    let changed = false
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
        reason: `процесс завершился с кодом ${exitCode} без orca-board done`
      })
      changed = true
    }
    if (changed) this.commit()
  }

  /** Живые dispatch'и (без endedAt). */
  activeDispatches(): Dispatch[] {
    return [...this.dispatches.values()].filter((d) => !d.endedAt)
  }

  /** Воркер молчит слишком долго — одна эскалация на dispatch. */
  markStuck(dispatchId: string, silentMs: number): void {
    const d = this.mustDispatch(dispatchId)
    if (d.stuckNotified || d.endedAt) return
    d.stuckNotified = true
    const task = this.mustTask(d.taskId)
    this.pushEvent('escalation', {
      taskId: task.id,
      dispatchId,
      reason: `нет вывода ${Math.round(silentMs / 60000)} мин`
    })
    this.commit()
  }

  /** Ревью не прошло: задача обратно в ready с замечаниями. */
  rejectReview(taskId: string, feedback: string): Task {
    const task = this.mustTask(taskId)
    task.feedback = feedback
    task.status = 'ready'
    task.updatedAt = Date.now()
    this.commit()
    return task
  }

  // ---------- questions ----------

  ask(input: { taskId: string; dispatchId?: string; question: string; options?: string[] }): Question {
    const task = this.mustTask(input.taskId)
    const q: Question = {
      id: newId('q'),
      taskId: task.id,
      dispatchId: input.dispatchId,
      question: input.question,
      options: input.options ?? [],
      createdAt: Date.now()
    }
    this.questions.set(q.id, q)
    task.status = 'needs_input'
    task.updatedAt = Date.now()
    this.pushEvent('question', { taskId: task.id, dispatchId: q.dispatchId, questionId: q.id, question: q.question, options: q.options })
    this.commit()
    return q
  }

  answer(questionId: string, answer: string): Question {
    const q = this.questions.get(questionId)
    if (!q) throw new Error(`question not found: ${questionId}`)
    q.answer = answer
    q.answeredAt = Date.now()
    const task = this.mustTask(q.taskId)
    const stillOpen = [...this.questions.values()].some((x) => x.taskId === task.id && !x.answeredAt)
    if (!stillOpen && task.status === 'needs_input') task.status = 'in_progress'
    task.updatedAt = Date.now()
    this.pushEvent('question_answered', { taskId: task.id, dispatchId: q.dispatchId, questionId, answer })
    this.commit()
    return q
  }

  getQuestion(id: string): Question | undefined {
    return this.questions.get(id)
  }

  openQuestions(): Question[] {
    return [...this.questions.values()].filter((q) => !q.answeredAt)
  }

  // ---------- events ----------

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

  /** Забрать непрочитанные события заданных типов и пометить их прочитанными. */
  consumeEvents(types: EventType[], consumer: string): OrcaEvent[] {
    const hit = this.events.filter((e) => !e.consumedBy && types.includes(e.type))
    if (hit.length === 0) return []
    hit.forEach((e) => (e.consumedBy = consumer))
    this.persistence?.save(this.snapshot())
    return hit
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
