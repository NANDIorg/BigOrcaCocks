import type {
  Dispatch, OrcaEvent, Run, Task, TaskStatus, AgentKind, EventType, Question,
  BoardColumn, ColumnKind, SystemColumnKind, AnswerAudience
} from './types.ts'
import { ANSWER_AUDIENCES, DEFAULT_COLUMNS, DEFAULT_ROLE_ID, MAX_ANSWER_LENGTH } from './types.ts'
import { DEFAULT_AGENT } from './agents.ts'
import {
  globalStoredColumns, globalColumnKind, globalTaskStatus, toGlobalTask, toGlobalTasks,
  type GlobalColumnKind, type GlobalTask
} from './global-tasks.ts'

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
  // Не parameter property: node --test (type stripping) их не поддерживает.
  private readonly persistence?: Persistence

  constructor(persistence?: Persistence, columns?: () => BoardColumn[]) {
    this.persistence = persistence
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
      const migrated = this.migrateGlobalTasks()
      if (this.migrateHumanAnswers() || migrated) this.persistence?.save(this.snapshot())
    }
  }

  /**
   * Миграция к глобальным задачам (docs/nested-kanban.md): прогон без status получает колонку
   * (закрыт → done, иначе in_progress), прогон в колонке подзадач сводится к колонке глобального канбана
   * (globalTaskStatus), задачи без прогона уходят во «Входящие» — так у каждой
   * задачи есть глобальная. run_done при этом не шлётся: «Входящие» из одних done сразу закрыты.
   * Возвращает true, если что-то поменялось (тогда снапшот сохраняется сразу — id «Входящих» стабилен).
   */
  private migrateGlobalTasks(): boolean {
    let changed = false
    for (const run of this.runs.values()) {
      if (run.status === undefined) {
        run.status = this.columnId(run.closedAt !== undefined ? 'done' : 'in_progress')
        run.updatedAt ??= run.createdAt
        changed = true
        continue
      }
      // Глобальная задача из колонки подзадач (ready/needs_input/review/custom) — в ближайшую колонку глобального канбана.
      const status = globalTaskStatus(run.status, this.columns())
      if (status !== undefined && status !== run.status) {
        run.status = status
        changed = true
      }
    }
    const orphans = [...this.tasks.values()].filter((t) => t.runId === undefined || !this.runs.has(t.runId))
    if (orphans.length > 0) {
      const inbox = this.inbox() ?? this.addRun({ objective: '', inbox: true }, Math.min(...orphans.map((t) => t.createdAt)))
      orphans.forEach((t) => (t.runId = inbox.id))
      const tasks = [...this.tasks.values()].filter((t) => t.runId === inbox.id)
      const allDone = tasks.every((t) => this.isKind(t, 'done'))
      if (allDone) inbox.closedAt ??= Date.now()
      inbox.status = this.columnId(allDone ? 'done' : 'in_progress')
      changed = true
    }
    return changed
  }

  /**
   * Сданный ответ для человека, застрявший в review (сдан до переноса таких ответов в needs_input или
   * main-процессом со старым кодом — `electron-vite dev` не пересобирает main без перезапуска), — в needs_input.
   * Возвращает true, если что-то поменялось.
   */
  private migrateHumanAnswers(): boolean {
    let changed = false
    for (const task of this.tasks.values()) {
      if (this.isKind(task, 'review') && this.humanAnswerReady(task)) {
        task.status = this.columnId('needs_input')
        changed = true
      }
    }
    return changed
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
    if (this.columnKind(status) === 'done') {
      // Подзадача впервые дошла до done после переоткрытия прогона — автозакрытие снова разрешено.
      const run = task.doneAt === undefined && task.runId !== undefined ? this.runs.get(task.runId) : undefined
      if (run) run.reopenedAt = undefined
      task.doneAt ??= Date.now()
    } else task.doneAt = undefined
    task.updatedAt = Date.now()
  }

  // ---------- tasks ----------

  /** Задачи в колонках kind=in_progress (колонки кастомные — по kind, не по id); для счётчика в списке проектов. */
  inProgressCount(): number {
    let n = 0
    for (const t of this.tasks.values()) if (this.isKind(t, 'in_progress')) n++
    return n
  }

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
    /** Задача-ответ: кто читает ответ. Нет — обычная задача. */
    answerFor?: AnswerAudience
  }): Task {
    if (input.answerFor !== undefined && !ANSWER_AUDIENCES.includes(input.answerFor)) {
      throw new Error(`answerFor: ожидается ${ANSWER_AUDIENCES.join(' или ')}, получено ${String(input.answerFor)}`)
    }
    const now = Date.now()
    // Подзадача всегда внутри глобальной задачи: без runId — во «Входящие»; чужой/несуществующий — ошибка.
    const run = input.runId !== undefined ? this.mustRun(input.runId) : (this.inbox() ?? this.addRun({ objective: '', inbox: true }))
    const deps = (input.deps ?? []).filter((d) => this.tasks.has(d))
    const foreign = deps.filter((d) => this.tasks.get(d)!.runId !== run.id)
    if (foreign.length > 0) throw new Error(`зависимости из другой глобальной задачи: ${foreign.join(', ')}`)
    const task: Task = {
      id: newId('task'),
      title: input.title,
      spec: input.spec ?? '',
      status: this.columnId('backlog'),
      deps,
      roleId: input.roleId ?? DEFAULT_ROLE_ID,
      agent: input.agent ?? DEFAULT_AGENT,
      runId: run.id,
      ...(input.answerFor ? { answerFor: input.answerFor } : {}),
      createdAt: now,
      updatedAt: now
    }
    this.tasks.set(task.id, task)
    // Новая работа в закрытой глобальной задаче: прогон снова открыт, run_done придёт по её завершении.
    if (run.closedAt !== undefined) this.reopenRun(run)
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

  /**
   * Перенести все задачи и глобальные задачи из колонки fromId в toId (при удалении колонки).
   * Возвращает число перенесённых.
   */
  reassignColumn(fromId: string, toId: string): number {
    let moved = 0
    for (const task of this.tasks.values()) {
      if (task.status !== fromId) continue
      this.setStatus(task, toId)
      moved += 1
    }
    for (const run of this.runs.values()) {
      if (run.status !== fromId) continue
      run.status = toId
      run.updatedAt = Date.now()
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
    const run = this.addRun({ objective, coordinatorPtyId })
    this.commit()
    return run
  }

  /** Новый прогон без commit. Статус по умолчанию — колонка kind=backlog. */
  private addRun(fields: Partial<Omit<Run, 'id' | 'createdAt'>> & { objective: string }, createdAt = Date.now()): Run {
    const run: Run = { status: this.columnId('backlog'), ...fields, id: newId('run'), createdAt, updatedAt: createdAt }
    this.runs.set(run.id, run)
    return run
  }

  /** Вид колонки глобального канбана, где стоит прогон (скрытые колонки сведены, см. globalColumnKind). */
  private globalKind(run: Run): GlobalColumnKind {
    return globalColumnKind(run.status === undefined ? undefined : this.columnKind(run.status))
  }

  private inbox(): Run | undefined {
    return [...this.runs.values()].find((r) => r.inbox)
  }

  /**
   * Закрытый прогон снова открыт: автозакрытие ждёт новой подзадачи в done; карточка из done — в работу.
   * Непрочитанные run_done прошлого закрытия гасятся, чтобы новый координатор не получил их сразу.
   */
  private reopenRun(run: Run): void {
    for (const e of this.events) {
      if (e.type === 'run_done' && e.payload.runId === run.id && !e.consumedBy) e.consumedBy = 'reopen'
    }
    run.closedAt = undefined
    run.finishedAt = undefined
    run.reopenedAt = Date.now()
    if (run.status === undefined || this.globalKind(run) === 'done') run.status = this.columnId('in_progress')
    run.updatedAt = Date.now()
  }

  /**
   * Координатор запущен на прогоне (новом или повторно на существующей глобальной задаче):
   * закрытый прогон переоткрывается, карточка — в колонку kind=in_progress.
   */
  setRunPty(runId: string, ptyId: string, agent?: AgentKind): Run {
    const run = this.mustRun(runId)
    if (run.closedAt !== undefined) this.reopenRun(run)
    run.coordinatorPtyId = ptyId
    run.coordinatorAgent = agent
    run.status = this.columnId('in_progress')
    run.updatedAt = Date.now()
    this.commit()
    return run
  }

  // ---------- global tasks ----------

  /** Карточки глобальных задач с прогрессом подзадач, в порядке создания. */
  listGlobalTasks(): GlobalTask[] {
    return toGlobalTasks(this.listRuns(), this.listTasks(), this.columns(), [...this.questions.values()])
  }

  getGlobalTask(id: string): GlobalTask {
    return toGlobalTask(this.mustRun(id), this.listTasks(), this.columns(), [...this.questions.values()])
  }

  /** Подзадачи глобальной задачи (только её), в порядке создания. Нет такой — ошибка. */
  listSubtasks(runId: string): Task[] {
    this.mustRun(runId)
    return this.listTasks().filter((t) => t.runId === runId)
  }

  /** Глобальная задача без координатора. Нужно название или описание; status — id колонки (по умолчанию backlog). */
  createGlobalTask(input: { title?: string; description?: string; status?: string }): GlobalTask {
    const title = input.title?.trim() || undefined
    const objective = input.description ?? ''
    if (!title && !objective.trim()) throw new Error('укажи название или описание глобальной задачи')
    if (input.status !== undefined) this.assertGlobalColumn(input.status)
    const run = this.addRun({ objective, ...(title ? { title } : {}), ...(input.status !== undefined ? { status: input.status } : {}) })
    this.commit()
    return this.getGlobalTask(run.id)
  }

  /** Переименовать/сменить описание. Подзадачи не трогает; координатору правка не доходит (он уже получил цель). */
  updateGlobalTask(id: string, patch: { title?: string; description?: string }): GlobalTask {
    const run = this.mustRun(id)
    if (patch.title === undefined && patch.description === undefined) throw new Error('укажи название и/или описание')
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) throw new Error('название не может быть пустым')
      run.title = title
    }
    if (patch.description !== undefined) run.objective = patch.description
    run.updatedAt = Date.now()
    this.commit()
    return this.getGlobalTask(id)
  }

  /**
   * Ручное перемещение карточки по колонкам проекта. Статусы подзадач не меняются.
   * В колонку kind=done — человек объявил глобальную задачу сделанной: открытый прогон закрывается
   * с `run_done {manual: true}`, чтобы координатор (если ждёт) закончил, а приложение закрыло его терминал.
   * Уже закрытый прогон повторно не закрывается. Из done в другую колонку — прогон снова открыт (reopenRun).
   */
  moveGlobalTask(id: string, status: string): GlobalTask {
    const run = this.mustRun(id)
    this.assertGlobalColumn(status)
    if (this.columnKind(status) === 'done') {
      if (run.closedAt === undefined) this.closeDone(run, true)
    } else if (run.closedAt !== undefined) {
      this.reopenRun(run)
    }
    run.status = status
    run.updatedAt = Date.now()
    this.commit()
    return this.getGlobalTask(id)
  }

  /**
   * Удалить глобальную задачу. С подзадачами — только `cascade: true`, и тогда удаляются и они
   * (с их вопросами), сирот не остаётся. Подзадача с живым воркером — ошибка. Живого координатора
   * проверяет main (store не знает о PTY).
   */
  deleteGlobalTask(id: string, opts: { cascade?: boolean } = {}): { deleted: string; tasks: string[] } {
    this.mustRun(id)
    const children = [...this.tasks.values()].filter((t) => t.runId === id)
    if (children.length > 0 && !opts.cascade) {
      throw new Error(`у глобальной задачи ${children.length} подзадач(и) — удаление только вместе с ними (cascade)`)
    }
    const ids = new Set(children.map((t) => t.id))
    const busy = this.activeDispatches().filter((d) => ids.has(d.taskId))
    if (busy.length > 0) throw new Error(`подзадачи в работе (${busy.map((d) => d.taskId).join(', ')}) — сначала останови воркеров`)
    for (const taskId of ids) this.tasks.delete(taskId)
    for (const q of [...this.questions.values()]) if (ids.has(q.taskId)) this.questions.delete(q.id)
    // Зависимости между глобальными запрещены при создании, но старые данные могли их содержать.
    for (const t of this.tasks.values()) if (t.deps.some((d) => ids.has(d))) t.deps = t.deps.filter((d) => !ids.has(d))
    this.runs.delete(id)
    this.promoteReady()
    this.commit()
    return { deleted: id, tasks: [...ids] }
  }

  private assertColumn(status: string): void {
    if (!this.columnKind(status)) throw new Error(`колонки с id «${status}» нет на доске`)
  }

  /**
   * Глобальная задача встаёт только в backlog / in_progress / done. В needs_input карточка попадает
   * сама, пока подзадачи ждут человека (toGlobalTask), — руками туда нельзя.
   */
  private assertGlobalColumn(status: string): void {
    this.assertColumn(status)
    if (this.columnKind(status) === 'needs_input') {
      throw new Error(`колонка «${status}» заполняется сама: там глобальные задачи, где подзадачи ждут ответа человека`)
    }
    if (!globalStoredColumns(this.columns()).some((c) => c.id === status)) {
      throw new Error(`колонка «${status}» — только для подзадач; глобальная задача: бэклог, в работе или сделано`)
    }
  }

  /**
   * Закрыть прогон вручную. Карточку из kind=in_progress (туда её ставит сама система) — в done, как при
   * автозакрытии; ручную расстановку по другим колонкам не трогает. run_done не шлёт.
   * Идемпотентно: повторный вызов closedAt не меняет.
   */
  closeRun(id: string): Run {
    const run = this.mustRun(id)
    if (run.closedAt === undefined) {
      run.closedAt = Date.now()
      if (run.status !== undefined && this.globalKind(run) === 'in_progress') run.status = this.columnId('done')
      run.updatedAt = run.closedAt
      this.commit()
    }
    return run
  }

  /**
   * Координатор закончил работу по прогону (`runs finish`). Для закрытого прогона — просто сигнал.
   * Незакрытый прогон, в котором все подзадачи уже в kind=done, закрывается здесь же с run_done:
   * это повторный запуск координатора без новой работы (или новую подзадачу удалили) — автозакрытие
   * ждёт новой подзадачи в done и само не сработает. У свежего прогона нужна хотя бы одна подзадача.
   * Иначе ошибка: до run_done координатору ещё есть что делать. Повторный вызов обновляет время.
   */
  finishRun(id: string): Run {
    const run = this.mustRun(id)
    if (run.closedAt === undefined) {
      const tasks = [...this.tasks.values()].filter((t) => t.runId === run.id)
      const idle = tasks.every((t) => this.isKind(t, 'done')) && (tasks.length > 0 || run.reopenedAt !== undefined)
      if (!idle) throw new Error(`run not closed: ${id} — дождись run_done`)
      // Координатор сам сообщил о конце — ждать этот run_done ему уже не нужно.
      const done = this.closeDone(run)
      if (done) done.consumedBy = 'runs finish'
    }
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
      // Переоткрытый прогон: ждём, пока хоть одна подзадача дойдёт до done после переоткрытия (setStatus снимет метку).
      if (run.reopenedAt !== undefined) continue
      this.closeDone(run)
    }
  }

  /**
   * Закрыть прогон как завершённый: карточка в done и событие run_done (его и возвращает).
   * `manual` — карточку перенёс в done человек (подзадачи могут быть не закрыты), в событии `manual: true`.
   * «Входящим» run_done не шлётся: у них нет координатора, событие некому забрать.
   */
  private closeDone(run: Run, manual = false): OrcaEvent | undefined {
    run.closedAt = Date.now()
    run.reopenedAt = undefined
    run.status = this.columnId('done')
    run.updatedAt = run.closedAt
    if (run.inbox) return undefined
    return this.pushEvent('run_done', { runId: run.id, objective: run.objective, ...(manual ? { manual: true } : {}) })
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

  /**
   * Явное завершение воркером через `orca-board done`. У задачи-ответа ответ обязателен и уходит
   * в событие worker_done вместе с `answerFor` — координатор решает по нему, принимать ли ответ сам.
   * Ответ для человека (`answerFor: 'human'`) ждёт его в needs_input, остальное — в review.
   */
  finishDispatch(dispatchId: string, summary: string, files: string[] = [], answer?: string): Dispatch {
    const dispatch = this.mustDispatch(dispatchId)
    const task = this.mustTask(dispatch.taskId)
    const text = answer?.trim() ? answer : undefined
    if (task.answerFor && !text) {
      throw new Error('задача-ответ: передай ответ — orca-board done --summary "..." --answer-file <файл.md>')
    }
    if (text && text.length > MAX_ANSWER_LENGTH) {
      throw new Error(`ответ длиннее ${MAX_ANSWER_LENGTH} символов — сократи его`)
    }
    dispatch.endedAt = Date.now()
    dispatch.outcome = 'done'
    dispatch.summary = summary
    dispatch.files = files
    if (text) dispatch.answer = text
    this.setStatus(task, this.columnId(task.answerFor === 'human' ? 'needs_input' : 'review'))
    this.pushEvent('worker_done', {
      taskId: task.id, dispatchId, summary, files,
      ...(task.answerFor ? { answerFor: task.answerFor } : {}),
      ...(text ? { answer: text } : {})
    })
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

  /**
   * Приёмка (`review accept`, «Принять» в UI): задача → done, worktree и ветка забыты (git-часть делает main).
   * Ответ для человека (`answerFor: 'human'`) принимает человек — координатор узнаёт об этом из
   * `answer_accepted` (с текстом ответа) и продолжает работу: иначе он ждал бы, пока ему напишут в терминал.
   * `decision` — что человек решил по ответу («Решение / что делать дальше»): уходит в событие, по нему
   * координатор заводит задачи. Повторная приёмка задачи в done события не шлёт.
   */
  acceptTask(taskId: string, decision?: string): Task {
    const task = this.mustTask(taskId)
    if (task.answerFor === 'human' && !this.isKind(task, 'done')) {
      const d = task.dispatchId ? this.dispatches.get(task.dispatchId) : undefined
      this.pushEvent('answer_accepted', {
        taskId: task.id, dispatchId: d?.id, answerFor: task.answerFor,
        ...(d?.summary ? { summary: d.summary } : {}),
        ...(d?.answer ? { answer: d.answer } : {}),
        ...(decision?.trim() ? { decision: decision.trim() } : {})
      })
    }
    // Событие — до commit в updateTask: если задача последняя, run_done придёт после answer_accepted.
    return this.updateTask(taskId, { status: this.columnId('done'), worktree: undefined, branch: undefined })
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
    // Воркер жив — ответ дойдёт до него (ask или терминал), иначе задачу надо перезапустить.
    const live = task.dispatchId !== undefined && !this.dispatches.get(task.dispatchId)?.endedAt
    if (!stillOpen && this.isKind(task, 'needs_input') && !this.humanAnswerReady(task)) {
      // Обратно в поток: воркер жив — работает дальше, иначе задача ждёт запуска.
      this.setStatus(task, this.columnId(live ? 'in_progress' : 'ready'))
    }
    task.updatedAt = Date.now()
    // workerLive: false и задача в ready — координатору сделать `worker start` (ответ будет в промпте).
    this.pushEvent('question_answered', {
      taskId: task.id, dispatchId: q.dispatchId, questionId, question: q.question, answer,
      workerLive: live, status: task.status
    })
    this.commit()
    return q
  }

  /**
   * Координатор передал вопрос человеку: вопрос остаётся открытым, подзадача стоит в needs_input,
   * глобальная задача показывается там же, пока человек не ответит. Отвеченный вопрос передать нельзя.
   */
  forwardQuestion(questionId: string): Question {
    const q = this.questions.get(questionId)
    if (!q) throw new Error(`question not found: ${questionId}`)
    if (q.answeredAt) throw new Error(`на вопрос ${questionId} уже ответили`)
    q.forHuman = true
    const task = this.mustTask(q.taskId)
    if (!this.isKind(task, 'done')) this.setStatus(task, this.columnId('needs_input'))
    task.updatedAt = Date.now()
    this.commit()
    return q
  }

  /** Задача-ответ для человека сдана и ждёт, пока человек её примет или уточнит. */
  private humanAnswerReady(task: Task): boolean {
    const d = task.dispatchId ? this.dispatches.get(task.dispatchId) : undefined
    return task.answerFor === 'human' && d?.outcome === 'done' && d.answer !== undefined
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
