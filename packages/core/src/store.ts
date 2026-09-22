import type {
  Dispatch, OrcaEvent, Run, Task, TaskStatus, AgentKind, EventType, Question,
  BoardColumn, ColumnKind, SystemColumnKind
} from './types'
import { DEFAULT_COLUMNS, DEFAULT_ROLE_ID } from './types'
import { DEFAULT_AGENT } from './agents'

export interface StoreSnapshot {
  tasks: Task[]
  dispatches: Dispatch[]
  events: OrcaEvent[]
  questions: Question[]
  runs: Run[]
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
 * Статус задачи — id колонки; автоматические переходы идут по `kind` колонки
 * (backlog → ready, когда все deps в done; in_progress при запуске и т.д.).
 * Колонки приходят снаружи функцией — их хранит проект, а не store.
 */
export class TaskStore {
  private tasks = new Map<string, Task>()
  private dispatches = new Map<string, Dispatch>()
  private questions = new Map<string, Question>()
  private runs = new Map<string, Run>()
  private events: OrcaEvent[] = []
  private listeners = new Set<() => void>()
  private readonly columnsFn: () => BoardColumn[]

  constructor(private persistence?: Persistence, columns?: () => BoardColumn[]) {
    this.columnsFn = columns ?? (() => DEFAULT_COLUMNS)
    const snap = persistence?.load()
    if (snap) {
      // Миграция на лету: у старых задач нет roleId. Статусы старых задач совпадают
      // с id дефолтных колонок (backlog, ready, ...), их переводить не нужно.
      snap.tasks?.forEach((t) => this.tasks.set(t.id, { ...t, roleId: t.roleId ?? DEFAULT_ROLE_ID }))
      snap.dispatches?.forEach((d) => this.dispatches.set(d.id, d))
      snap.questions?.forEach((q) => this.questions.set(q.id, q))
      // Старые снапшоты без runs — просто нет прогонов.
      snap.runs?.forEach((r) => this.runs.set(r.id, r))
      this.events = snap.events ?? []
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(): void {
    this.closeFinishedRuns()
    this.persistence?.save(this.snapshot())
    this.listeners.forEach((fn) => fn())
  }

  snapshot(): StoreSnapshot {
    return {
      tasks: this.listTasks(),
      dispatches: [...this.dispatches.values()],
      events: [...this.events],
      questions: [...this.questions.values()],
      runs: this.listRuns()
    }
  }

  // ---------- columns ----------

  columns(): BoardColumn[] {
    return this.columnsFn()
  }

  /** Id первой колонки с таким kind; если такой нет — сам kind как запасной вариант. */
  columnId(kind: SystemColumnKind): string {
    return this.columns().find((c) => c.kind === kind)?.id ?? kind
  }

  columnKind(id: string): ColumnKind | undefined {
    return this.columns().find((c) => c.id === id)?.kind
  }

  private isKind(task: Task, kind: SystemColumnKind): boolean {
    return this.columnKind(task.status) === kind
  }

  /** Все смены статуса идут здесь: следим за doneAt при входе/выходе из колонки done. */
  private setStatus(task: Task, status: TaskStatus): void {
    task.status = status
    if (this.columnKind(status) === 'done') task.doneAt ??= Date.now()
    else task.doneAt = undefined
    task.updatedAt = Date.now()
  }

  // ---------- tasks ----------

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /** Валидность roleId проверяет main (роли живут в проекте), store её не знает. */
  createTask(input: {
    title: string
    spec?: string
    deps?: string[]
    roleId?: string
    agent?: AgentKind
    runId?: string
  }): Task {
    const now = Date.now()
    const task: Task = {
      id: newId('task'),
      title: input.title,
      spec: input.spec ?? '',
      status: this.columnId('backlog'),
      deps: (input.deps ?? []).filter((d) => this.tasks.has(d)),
      roleId: input.roleId ?? DEFAULT_ROLE_ID,
      agent: input.agent ?? DEFAULT_AGENT,
      runId: input.runId,
      createdAt: now,
      updatedAt: now
    }
    this.tasks.set(task.id, task)
    this.promoteReady()
    this.commit()
    return task
  }

  /** runId задачи неизменен: принадлежность прогону задаётся только при создании. */
  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt' | 'runId'>>): Task {
    const task = this.mustTask(id)
    const { status, ...rest } = patch as Partial<Task>
    delete rest.runId
    Object.assign(task, rest, { updatedAt: Date.now() })
    if (status !== undefined) this.setStatus(task, status)
    this.promoteReady()
    this.commit()
    return task
  }

  /**
   * Правка названия/описания из UI или CLI. Задачу в работе (kind=in_progress) править нельзя:
   * воркер уже получил задание в промпт, и правка его не догонит.
   */
  editTask(id: string, patch: { title?: string; spec?: string }): Task {
    const task = this.mustTask(id)
    if (this.isKind(task, 'in_progress')) throw new Error('задача в работе — сначала дождись воркера или перезапусти её')
    const next: { title?: string; spec?: string } = {}
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) throw new Error('название не может быть пустым')
      next.title = title
    }
    if (patch.spec !== undefined) next.spec = patch.spec
    return this.updateTask(id, next)
  }

  moveTask(id: string, status: string): Task {
    if (!this.columnKind(status)) throw new Error(`колонки с id «${status}» нет на доске`)
    return this.updateTask(id, { status })
  }

  /** Перенести все задачи из колонки fromId в toId (при удалении колонки). Возвращает число перенесённых. */
  reassignColumn(fromId: string, toId: string): number {
    let moved = 0
    for (const task of this.tasks.values()) {
      if (task.status !== fromId) continue
      this.setStatus(task, toId)
      moved += 1
    }
    if (moved > 0) {
      this.promoteReady()
      this.commit()
    }
    return moved
  }

  deleteTask(id: string): void {
    this.tasks.delete(id)
    this.promoteReady()
    this.commit()
  }

  /** backlog → ready, если все зависимости закрыты (по kind колонок). */
  private promoteReady(): void {
    for (const task of this.tasks.values()) {
      if (!this.isKind(task, 'backlog')) continue
      const depsDone = task.deps.every((d) => {
        const dep = this.tasks.get(d)
        return dep !== undefined && this.isKind(dep, 'done')
      })
      if (depsDone) {
        this.setStatus(task, this.columnId('ready'))
        this.pushEvent('task_ready', { taskId: task.id })
      }
    }
  }

  // ---------- runs ----------

  listRuns(): Run[] {
    return [...this.runs.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  getRun(id: string): Run | undefined {
    return this.runs.get(id)
  }

  createRun(objective: string, coordinatorPtyId?: string): Run {
    const run: Run = { id: newId('run'), objective, createdAt: Date.now(), coordinatorPtyId }
    this.runs.set(run.id, run)
    this.commit()
    return run
  }

  setRunPty(runId: string, ptyId: string, agent?: AgentKind): Run {
    const run = this.mustRun(runId)
    run.coordinatorPtyId = ptyId
    run.coordinatorAgent = agent
    this.commit()
    return run
  }

  /** Закрыть прогон вручную. Идемпотентно: повторный вызов closedAt не меняет. */
  closeRun(id: string): Run {
    const run = this.mustRun(id)
    if (run.closedAt === undefined) {
      run.closedAt = Date.now()
      this.commit()
    }
    return run
  }

  /**
   * Координатор закончил работу по прогону (`runs finish`). Только для закрытого прогона: до run_done
   * координатору ещё есть что делать. Повторный вызов обновляет время — считается последний сигнал.
   */
  finishRun(id: string): Run {
    const run = this.mustRun(id)
    if (run.closedAt === undefined) throw new Error(`run not closed: ${id} — дождись run_done`)
    run.finishedAt = Date.now()
    this.commit()
    return run
  }

  /**
   * Прогон с задачами, у которого все задачи в kind=done, закрывается с событием run_done.
   * Вызывается из commit(), поэтому ловит любую смену статуса и удаление задач.
   * Закрытый прогон повторно не закрывается и run_done не шлёт.
   */
  private closeFinishedRuns(): void {
    for (const run of this.runs.values()) {
      if (run.closedAt !== undefined) continue
      const tasks = [...this.tasks.values()].filter((t) => t.runId === run.id)
      if (tasks.length === 0 || !tasks.every((t) => this.isKind(t, 'done'))) continue
      run.closedAt = Date.now()
      this.pushEvent('run_done', { runId: run.id, objective: run.objective })
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
    task.startedAt ??= Date.now()
    this.setStatus(task, this.columnId('in_progress'))
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
    this.setStatus(task, this.columnId('review'))
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
      this.setStatus(task, this.columnId('needs_input'))
      this.pushEvent('escalation', {
        taskId: task.id,
        dispatchId: dispatch.id,
        reason: `процесс завершился с кодом ${exitCode} без orca-board done`
      })
      changed = true
    }
    if (changed) this.commit()
  }

  /**
   * Закрыть живые dispatch'и задачи (перед kill PTY: иначе ptyExited примет kill за падение
   * и утащит задачу в needs_input). Статус задачи не трогает. Возвращает закрытые dispatch'и.
   */
  closeDispatches(taskId: string): Dispatch[] {
    const closed = [...this.dispatches.values()].filter((d) => d.taskId === taskId && !d.endedAt)
    if (closed.length === 0) return []
    for (const d of closed) {
      d.endedAt = Date.now()
      d.outcome = 'unknown'
    }
    this.commit()
    return closed
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
    this.setStatus(task, this.columnId('ready'))
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
    this.setStatus(task, this.columnId('needs_input'))
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
    if (!stillOpen && this.isKind(task, 'needs_input')) this.setStatus(task, this.columnId('in_progress'))
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

  /**
   * Забрать непрочитанные события заданных типов и пометить их прочитанными.
   * С runId — только события этого прогона: по задаче прогона или payload.runId (run_done).
   */
  consumeEvents(types: EventType[], consumer: string, runId?: string): OrcaEvent[] {
    const inRun = (e: OrcaEvent): boolean =>
      e.payload.runId === runId || (e.taskId !== undefined && this.tasks.get(e.taskId)?.runId === runId)
    const hit = this.events.filter(
      (e) => !e.consumedBy && types.includes(e.type) && (runId === undefined || inRun(e))
    )
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

  private mustRun(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new Error(`run not found: ${id}`)
    return run
  }

  private mustDispatch(id: string): Dispatch {
    const dispatch = this.dispatches.get(id)
    if (!dispatch) throw new Error(`dispatch not found: ${id}`)
    return dispatch
  }
}
