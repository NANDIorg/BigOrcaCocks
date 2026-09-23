import type {
  Dispatch, OrcaEvent, Run, Task, TaskStatus, AgentKind, EventType, Question,
  BoardColumn, ColumnKind, SystemColumnKind, AnswerAudience,
  HumanRequest, RequestOption, RequestResolution, TaskPriority
} from './types.ts'
import {
  ANSWER_AUDIENCES, DEFAULT_COLUMNS, DEFAULT_ROLE_ID, DEFAULT_TASK_PRIORITY, MAX_ANSWER_LENGTH, REQUEST_ACTIONS,
  TASK_PRIORITIES, isTaskPriority, normalizeOptions
} from './types.ts'
import { DEFAULT_AGENT } from './agents.ts'
import { trackActiveTime } from './active-time.ts'
import {
  defaultWorkflow, nextStage, startStage, wfNodeTitle, type WfAction, type WfOutcome, type WfStage, type Workflow
} from './workflow.ts'
import {
  globalStoredColumns, globalColumnKind, globalTaskInProgress, globalTaskStatus, toGlobalTask, toGlobalTasks,
  type GlobalColumnKind, type GlobalTask
} from './global-tasks.ts'

export interface StoreSnapshot {
  tasks: Task[]
  dispatches: Dispatch[]
  events: OrcaEvent[]
  questions: Question[]
  runs: Run[]
  /** Запросы к человеку. Нет в снапшотах до их появления — тогда при загрузке идёт миграция. */
  requests: HumanRequest[]
}

export interface Persistence {
  load(): Partial<StoreSnapshot> | null
  save(snapshot: StoreSnapshot): void
}

/** Сколько символов ответа кладётся в событие (worker_done, answer_accepted); остальное — через `task answer`. */
export const EVENT_ANSWER_LIMIT = 2000

/** Сколько символов текста (вопрос, причина, summary) кладётся в request_created; целиком — в самом запросе. */
export const EVENT_TITLE_LIMIT = 300

function short(text: string): string {
  return text.length > EVENT_TITLE_LIMIT ? `${text.slice(0, EVENT_TITLE_LIMIT - 1)}…` : text
}

/** Поля ответа для payload события: обрезанный текст и признак answerTruncated. Ставить последними. */
function eventAnswer(text: string): { answer: string; answerTruncated?: true } {
  return text.length > EVENT_ANSWER_LIMIT ? { answer: text.slice(0, EVENT_ANSWER_LIMIT), answerTruncated: true } : { answer: text }
}

/** Глубокая копия графа: правка графа проекта после создания прогона не должна менять снимок. */
function snapshotWorkflow(wf: Workflow): Workflow {
  return JSON.parse(JSON.stringify(wf)) as Workflow
}

/** Этап первого гейта (gate/human) на пути от старта; дальше исходом next. Нет такого — undefined. */
function firstGateStage(wf: Workflow, roleId: string): WfStage | undefined {
  const ctx = { roleId }
  let step = startStage(wf, ctx)
  for (let i = 0; i < wf.nodes.length && step.action.type === 'start_worker'; i += 1) {
    step = nextStage(wf, step.stage, 'next', ctx)
  }
  return step.action.type === 'create_gate' || step.action.type === 'request_human' ? step.stage : undefined
}

let counter = 0
/** Значение приходит из CLI/IPC строкой без проверки — неизвестное отвергаем с перечнем допустимых. */
function assertPriority(p: unknown): asserts p is TaskPriority {
  if (!isTaskPriority(p)) throw new Error(`приоритет: ожидается ${TASK_PRIORITIES.join(', ')}, получено «${String(p)}»`)
}

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
  private requests = new Map<string, HumanRequest>()
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
      // Варианты старых вопросов — строки.
      snap.questions?.forEach((q) => this.questions.set(q.id, { ...q, options: normalizeOptions(q.options as (string | RequestOption)[]) }))
      // Старые снапшоты без runs — просто нет прогонов.
      snap.runs?.forEach((r) => this.runs.set(r.id, r))
      snap.requests?.forEach((r) => this.requests.set(r.id, r))
      this.events = snap.events ?? []
      // До closeStaleDispatches: задача «В работе» от старого кода должна войти в него с открытым отрезком.
      const active = this.migrateActiveTime()
      const priority = this.migrateTaskPriority()
      const runPriority = this.migrateRunPriority()
      const migrated = this.migrateGlobalTasks()
      const stale = this.closeStaleDispatches()
      const requests = this.migrateRequests(snap.requests === undefined)
      const stages = this.migrateStages()
      // После статусов и запросов: от них зависит, идёт ли собственное время глобальной задачи.
      const own = this.migrateRunActiveTime()
      const synced = this.syncRunActiveTime()
      if (active || priority || runPriority || stale || requests || stages || migrated || own || synced) this.persistence?.save(this.snapshot())
    }
  }

  /**
   * Запросы к человеку при загрузке. PTY не переживают перезапуск, значит и координаторов нет: открытые
   * вопросы текущих dispatch'ей, ещё не адресованные человеку, уходят ему (как `escalateOpenQuestions`, но
   * без событий). `legacy` — снапшот до HumanRequest (одноразовая миграция): сданный ответ для человека
   * (в needs_input или review) → запрос answer; задача в needs_input, которой после этого ждать нечего,
   * — упавший воркер: запрос escalation. Возвращает true, если что-то поменялось.
   */
  private migrateRequests(legacy: boolean): boolean {
    let changed = false
    if (legacy) {
      for (const task of this.tasks.values()) {
        if (task.answerFor !== 'human' || !(this.isKind(task, 'needs_input') || this.isKind(task, 'review'))) continue
        const d = this.lastDispatch(task)
        if (d?.outcome !== 'done' || d.answer === undefined) continue
        this.createRequest(task, { kind: 'answer', title: d.summary || 'Ответ готов', body: d.answer, dispatchId: d.id }, false)
        changed = true
      }
    }
    for (const q of this.openQuestions()) {
      if (this.pendingRequest((r) => r.questionId === q.id) || (q.forHuman && !legacy) || !this.currentQuestion(q)) continue
      this.addQuestionRequest(q, undefined, false)
      changed = true
    }
    if (legacy) {
      for (const task of this.tasks.values()) {
        if (!this.isKind(task, 'needs_input') || this.hasPending(task.id)) continue
        const d = this.lastDispatch(task)
        if (d && (d.outcome === 'failed' || d.outcome === 'unknown')) {
          this.createRequest(task, { kind: 'escalation', title: 'процесс завершился без orca-board done', dispatchId: d.id }, false)
        } else this.setStatus(task, this.columnId('ready'))
        changed = true
      }
    }
    return changed
  }

  /**
   * Задачи, сданные в ревью кодом до воркфлоу, встают на первый гейт дефолтного графа — ревью, где они
   * и ждут. Id ноды ревью в дефолте один и тот же с ролью reviewer и без неё, поэтому роли проекта не нужны.
   * Задачи-ответы и задачи-гейты идут мимо воркфлоу. Событий нет: это не переход, а восстановление позиции.
   * Возвращает true, если что-то поменялось.
   */
  private migrateStages(): boolean {
    let changed = false
    for (const task of this.tasks.values()) {
      if (task.stage || task.answerFor || task.gateFor || !this.isKind(task, 'review')) continue
      const stage = firstGateStage(defaultWorkflow([]), task.roleId)
      if (!stage) continue
      task.stage = stage
      changed = true
    }
    return changed
  }

  /**
   * Время работы у задач от кода до `activeMs`/`activeSince`: сумма закрытых запусков воркера (dispatch) —
   * лучшее, что известно о том, сколько задача была в работе. Задача в kind=in_progress получает открытый
   * отрезок от начала живого запуска (нет его — от updatedAt, момента переноса). Не бывавшие в работе
   * (ни startedAt, ни запусков) остаются без полей — «не запускалась». Возвращает true, если что-то поменялось.
   */
  private migrateActiveTime(): boolean {
    let changed = false
    for (const task of this.tasks.values()) {
      if (task.activeMs !== undefined || task.activeSince !== undefined) continue
      const runs = [...this.dispatches.values()].filter((d) => d.taskId === task.id)
      const inProgress = this.isKind(task, 'in_progress')
      if (!inProgress && task.startedAt === undefined && runs.length === 0) continue
      task.activeMs = runs.reduce((sum, d) => sum + (d.endedAt !== undefined ? Math.max(0, d.endedAt - d.startedAt) : 0), 0)
      if (inProgress) {
        const live = runs.filter((d) => d.endedAt === undefined).sort((a, b) => b.startedAt - a.startedAt)[0]
        task.activeSince = live?.startedAt ?? task.updatedAt
      }
      changed = true
    }
    return changed
  }

  /**
   * Собственное время глобальных задач от кода до `Run.activeMs`/`activeSince`. Прошлых отрезков не восстановить:
   * смены статуса прогона не журналируются, а сумма подзадач — трудозатраты агентов, не время карточки в работе.
   * Поэтому прогон, который сейчас в работе, получает открытый отрезок от `updatedAt` (последняя правка —
   * обычно перенос в работу или запуск координатора), остальные остаются без полей — «своё время неизвестно»,
   * UI показывает только сумму подзадач, пока прогон снова не войдёт в работу. Возвращает true, если что-то поменялось.
   */
  private migrateRunActiveTime(): boolean {
    let changed = false
    const requests = this.listRequests()
    for (const run of this.runs.values()) {
      if (run.activeMs !== undefined || run.activeSince !== undefined) continue
      if (!globalTaskInProgress(run, this.columns(), requests)) continue
      run.activeMs = 0
      run.activeSince = run.updatedAt ?? run.createdAt
      changed = true
    }
    return changed
  }

  /**
   * Собственное время глобальных задач: отрезок открыт, пока карточка показана в kind=in_progress
   * (`globalTaskInProgress` — хранимый статус и pending-запросы). Статус прогона меняется во многих местах,
   * а «Нужен ответ» зависит ещё и от запросов, поэтому пересчёт — одним проходом из commit(), а не в каждом
   * присваивании `run.status`. Возвращает true, если что-то поменялось.
   */
  private syncRunActiveTime(now = Date.now()): boolean {
    let changed = false
    const requests = this.listRequests()
    for (const run of this.runs.values()) {
      const before = run.activeSince
      trackActiveTime(run, globalTaskInProgress(run, this.columns(), requests), now)
      if (run.activeSince !== before) changed = true
    }
    return changed
  }

  /**
   * PTY не переживают перезапуск приложения, а при quit ptyExited может не успеть записать endedAt.
   * Все dispatch без endedAt при загрузке — мёртвые: закрываем с outcome 'unknown', задачу «В работе»
   * возвращаем в ready (иначе worker start отказывает «уже в работе»). Задача в needs_input с открытым
   * вопросом остаётся ждать ответа — после него answer() сам переведёт её в ready.
   */
  private closeStaleDispatches(): boolean {
    let changed = false
    const now = Date.now()
    for (const d of this.dispatches.values()) {
      if (d.endedAt) continue
      d.endedAt = now
      d.outcome = 'unknown'
      changed = true
      const task = this.tasks.get(d.taskId)
      if (task && task.dispatchId === d.id && this.isKind(task, 'in_progress')) this.setStatus(task, this.columnId('ready'))
    }
    return changed
  }

  /**
   * Задачи из снапшотов до приоритетов (или с неизвестным значением, руками правленный state) получают
   * normal: поле обязательное, и renderer сортирует по нему. Возвращает true, если что-то поменялось.
   */
  private migrateTaskPriority(): boolean {
    let changed = false
    for (const task of this.tasks.values()) {
      if (isTaskPriority(task.priority)) continue
      task.priority = DEFAULT_TASK_PRIORITY
      changed = true
    }
    return changed
  }

  /**
   * Глобальные задачи (прогоны) из снапшотов до приоритетов или с неизвестным значением получают normal —
   * как задачи в `migrateTaskPriority`. Возвращает true, если что-то поменялось.
   */
  private migrateRunPriority(): boolean {
    let changed = false
    for (const run of this.runs.values()) {
      if (isTaskPriority(run.priority)) continue
      run.priority = DEFAULT_TASK_PRIORITY
      changed = true
    }
    return changed
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

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(): void {
    this.closeFinishedRuns()
    this.syncRunActiveTime()
    this.persistence?.save(this.snapshot())
    this.listeners.forEach((fn) => fn())
  }

  snapshot(): StoreSnapshot {
    return {
      tasks: this.listTasks(),
      dispatches: [...this.dispatches.values()],
      events: [...this.events],
      questions: [...this.questions.values()],
      runs: this.listRuns(),
      requests: this.listRequests()
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

  /**
   * Все смены статуса идут здесь: следим за doneAt при входе/выходе из колонки done и за временем работы
   * (отрезок открыт, пока задача в kind=in_progress, — `trackActiveTime`).
   */
  private setStatus(task: Task, status: TaskStatus): void {
    task.status = status
    trackActiveTime(task, this.columnKind(status) === 'in_progress', Date.now())
    if (this.columnKind(status) === 'done') {
      // Сделанной задаче ждать от человека нечего (перенесли вручную, приняли).
      this.cancelRequests((r) => r.taskId === task.id)
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
    /** Нет — normal. */
    priority?: TaskPriority
  }): Task {
    if (input.priority !== undefined) assertPriority(input.priority)
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
      priority: input.priority ?? DEFAULT_TASK_PRIORITY,
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
    if (rest.priority !== undefined) assertPriority(rest.priority)
    delete rest.runId
    // Время работы ведёт только setStatus: правка не должна сбить накопленное.
    delete rest.activeMs
    delete rest.activeSince
    Object.assign(task, rest, { updatedAt: Date.now() })
    if (status !== undefined) this.setStatus(task, status)
    this.promoteReady()
    this.commit()
    return task
  }

  /**
   * Правка названия/описания/приоритета из UI или CLI. Название и описание задачи в работе (kind=in_progress)
   * править нельзя: воркер уже получил задание в промпт, и правка его не догонит. Приоритет меняется в любой
   * колонке: в промпт он не попадает и на статус, dispatch и воркфлоу не влияет — только на порядок показа.
   */
  editTask(id: string, patch: { title?: string; spec?: string; priority?: TaskPriority }): Task {
    const task = this.mustTask(id)
    const text = patch.title !== undefined || patch.spec !== undefined
    if (text && this.isKind(task, 'in_progress')) throw new Error('задача в работе — сначала дождись воркера или перезапусти её')
    const next: { title?: string; spec?: string; priority?: TaskPriority } = {}
    if (patch.priority !== undefined) {
      assertPriority(patch.priority)
      next.priority = patch.priority
    }
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
    for (const r of [...this.requests.values()]) if (r.taskId === id) this.requests.delete(r.id)
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

  /** `workflow` — граф проекта сейчас: прогон хранит его снимок (см. `Run.workflow`). */
  createRun(objective: string, coordinatorPtyId?: string, workflow?: Workflow): Run {
    const run = this.addRun({ objective, coordinatorPtyId, ...(workflow ? { workflow: snapshotWorkflow(workflow) } : {}) })
    this.commit()
    return run
  }

  /**
   * Граф прогона: снимок, а у прогона без снимка (от кода до воркфлоу, «Входящие») — дефолтный граф по
   * ролям проекта `roleIds` (их передаёт вызывающий код, как и граф в `createRun`).
   */
  runWorkflow(runId: string | undefined, roleIds: readonly string[] = []): Workflow {
    const run = runId !== undefined ? this.runs.get(runId) : undefined
    return run?.workflow ?? defaultWorkflow(roleIds.map((id) => ({ id })))
  }

  /**
   * Переход задачи по воркфлоу прогона: `nextStage` по исходу `outcome` текущего этапа. Задача без `stage`
   * входит в граф из старта (только `next`). Меняет только `stage` — колонку, воркера, гейт и мерж по
   * `action` делает исполнитель в main. Событие `stage_changed`, если этап сменился, и `workflow_blocked`,
   * если дальше идти нельзя. `roleIds` — роли проекта: для дефолтного графа и проверки роли гейта.
   */
  advanceStage(taskId: string, outcome: WfOutcome, opts: { roleIds?: readonly string[] } = {}): { task: Task; action: WfAction } {
    const task = this.mustTask(taskId)
    if (task.answerFor) throw new Error(`задача ${taskId} — задача-ответ, она идёт мимо воркфлоу`)
    if (task.gateFor) throw new Error(`задача ${taskId} — проверка задачи ${task.gateFor.taskId}, у неё нет своего этапа`)
    if (!task.stage && outcome !== 'next') {
      throw new Error(`задача ${taskId} ещё не в воркфлоу: войти в него можно только исходом next, получено ${outcome}`)
    }
    const wf = this.runWorkflow(task.runId, opts.roleIds)
    const ctx = { roleId: task.roleId, ...(opts.roleIds ? { roleIds: opts.roleIds } : {}) }
    const step = task.stage ? nextStage(wf, task.stage, outcome, ctx) : startStage(wf, ctx)
    const from = task.stage?.nodeId
    const moved = step.stage.nodeId !== from && step.stage.nodeId !== ''
    if (moved) {
      task.stage = step.stage
      task.updatedAt = Date.now()
      const node = wf.nodes.find((n) => n.id === step.stage.nodeId)
      this.pushEvent('stage_changed', {
        taskId, runId: task.runId, ...(from !== undefined ? { from } : {}), to: step.stage.nodeId, outcome,
        ...(node ? { nodeType: node.type, title: wfNodeTitle(node) } : {})
      })
    }
    if (step.action.type === 'blocked') {
      this.pushEvent('workflow_blocked', { taskId, runId: task.runId, nodeId: step.action.nodeId, reason: short(step.action.reason) })
    }
    this.commit()
    return { task, action: step.action }
  }

  /** Новый прогон без commit. Статус по умолчанию — колонка kind=backlog. */
  private addRun(fields: Partial<Omit<Run, 'id' | 'createdAt'>> & { objective: string }, createdAt = Date.now()): Run {
    const run: Run = { status: this.columnId('backlog'), priority: DEFAULT_TASK_PRIORITY, ...fields, id: newId('run'), createdAt, updatedAt: createdAt }
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
    return toGlobalTasks(this.listRuns(), this.listTasks(), this.columns(), this.listRequests())
  }

  getGlobalTask(id: string): GlobalTask {
    return toGlobalTask(this.mustRun(id), this.listTasks(), this.columns(), this.listRequests())
  }

  /** Подзадачи глобальной задачи (только её), в порядке создания. Нет такой — ошибка. */
  listSubtasks(runId: string): Task[] {
    this.mustRun(runId)
    return this.listTasks().filter((t) => t.runId === runId)
  }

  /**
   * Глобальная задача без координатора. Нужно название или описание; status — id колонки (по умолчанию backlog),
   * priority — по умолчанию normal.
   */
  createGlobalTask(input: { title?: string; description?: string; status?: string; priority?: TaskPriority; workflow?: Workflow }): GlobalTask {
    const title = input.title?.trim() || undefined
    const objective = input.description ?? ''
    if (!title && !objective.trim()) throw new Error('укажи название или описание глобальной задачи')
    if (input.status !== undefined) this.assertGlobalColumn(input.status)
    if (input.priority !== undefined) assertPriority(input.priority)
    const run = this.addRun({
      objective,
      ...(title ? { title } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.workflow ? { workflow: snapshotWorkflow(input.workflow) } : {})
    })
    this.commit()
    return this.getGlobalTask(run.id)
  }

  /**
   * Переименовать/сменить описание/приоритет. Подзадачи не трогает (их приоритет свой); координатору правка
   * не доходит (он уже получил цель). Приоритет меняется в любой колонке — он влияет только на порядок показа.
   */
  updateGlobalTask(id: string, patch: { title?: string; description?: string; priority?: TaskPriority }): GlobalTask {
    const run = this.mustRun(id)
    if (patch.title === undefined && patch.description === undefined && patch.priority === undefined) {
      throw new Error('укажи название, описание и/или приоритет')
    }
    // Проверка до правок: неизвестный приоритет не должен оставить карточку наполовину изменённой.
    if (patch.priority !== undefined) assertPriority(patch.priority)
    const title = patch.title?.trim()
    if (patch.title !== undefined && !title) throw new Error('название не может быть пустым')
    if (title) run.title = title
    if (patch.description !== undefined) run.objective = patch.description
    if (patch.priority !== undefined) run.priority = patch.priority
    run.updatedAt = Date.now()
    this.commit()
    return this.getGlobalTask(id)
  }

  /**
   * Ручное перемещение карточки по колонкам проекта. Статусы подзадач не меняются.
   * В колонку kind=done — человек объявил глобальную задачу сделанной: открытый прогон закрывается
   * с `run_done {manual: true}`, чтобы координатор (если ждёт) закончил, а приложение закрыло его терминал.
   * Уже закрытый прогон повторно не закрывается. Из done в другую колонку — прогон снова открыт (reopenRun).
   * В done запросы прогона к человеку отменяются (cancelled): отвечать больше незачем.
   */
  moveGlobalTask(id: string, status: string): GlobalTask {
    const run = this.mustRun(id)
    this.assertGlobalColumn(status)
    if (this.columnKind(status) === 'done') {
      this.cancelRequests((r) => r.runId === run.id)
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
    for (const r of [...this.requests.values()]) if (r.runId === id || ids.has(r.taskId)) this.requests.delete(r.id)
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
    // Новый запуск начинает с чистого листа: запросы прошлых запусков (сданный ответ, эскалация, вопрос
    // умершего воркера) больше не ждут человека. Ответы на прошлые вопросы — в промпте запуска.
    this.cancelRequests((r) => r.taskId === task.id)
    task.dispatchId = dispatch.id
    task.startedAt ??= Date.now()
    this.setStatus(task, this.columnId('in_progress'))
    this.commit()
    return dispatch
  }

  /**
   * Явное завершение воркером через `orca-board done`. У задачи-ответа ответ обязателен и уходит
   * в событие worker_done вместе с `answerFor` — координатор решает по нему, принимать ли ответ сам.
   * Ответ для человека (`answerFor: 'human'`) — запрос answer к человеку (needs_input), остальное — в review.
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
    // Запуск сдал работу: его вопрос и прошлый ответ человека больше не ждут (сам вопрос остаётся открытым).
    this.cancelRequests((r) => r.taskId === task.id)
    let request: HumanRequest | undefined
    if (task.answerFor === 'human') {
      request = this.createRequest(task, { kind: 'answer', title: summary.trim() || 'Ответ готов', body: text, dispatchId }, false)
    } else this.setStatus(task, this.columnId('review'))
    // Ответ — последним и обрезанным: строка события в мониторе координатора обрезается, поля до него
    // должны дойти целиком. Полный текст — `orca-board task answer --task <id>`.
    this.pushEvent('worker_done', {
      taskId: task.id, dispatchId, summary, files,
      ...(task.answerFor ? { answerFor: task.answerFor } : {}),
      ...(request ? { requestId: request.id } : {}),
      ...(text ? eventAnswer(text) : {})
    })
    if (request) this.requestCreated(request)
    this.commit()
    return dispatch
  }

  /**
   * PTY закрылся без `done` — это не успех, это `unknown`/`failed`. Координатору — событие escalation,
   * человеку — запрос escalation («Перезапустить» / «Скрыть»), если это текущий запуск задачи и воркер не
   * ждал ответа человека на свой вопрос (тогда ответ сам вернёт задачу в поток — в ready).
   */
  ptyExited(ptyId: string, exitCode: number): void {
    let changed = false
    for (const dispatch of this.dispatches.values()) {
      if (dispatch.ptyId !== ptyId || dispatch.endedAt) continue
      dispatch.endedAt = Date.now()
      dispatch.outcome = exitCode === 0 ? 'unknown' : 'failed'
      const task = this.mustTask(dispatch.taskId)
      const reason = `процесс завершился с кодом ${exitCode} без orca-board done`
      this.pushEvent('escalation', { taskId: task.id, dispatchId: dispatch.id, reason })
      const current = task.dispatchId === dispatch.id && !this.isKind(task, 'done')
      const asked = this.pendingRequest((r) => r.taskId === task.id && r.kind === 'question')
      if (current && !asked) this.createRequest(task, { kind: 'escalation', title: reason, dispatchId: dispatch.id })
      else this.settleTask(task)
      changed = true
    }
    if (changed) this.commit()
  }

  /**
   * Закрыть живые dispatch'и задачи (перед kill PTY: иначе ptyExited примет kill за падение
   * и заведёт эскалацию). Статус задачи не трогает. Возвращает закрытые dispatch'и.
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
      reason: `нет вывода ${Math.round(silentMs / 60000)} мин`,
      stuck: true
    })
    this.commit()
  }

  /**
   * Эскалация координатору от main (например, «Уточнить»/«Перезапустить» решены, а воркер не стартовал):
   * событие escalation с причиной, статус задачи не трогает.
   */
  escalate(taskId: string, reason: string, extra: Record<string, unknown> = {}): OrcaEvent {
    const task = this.mustTask(taskId)
    const event = this.pushEvent('escalation', { taskId: task.id, reason: short(reason), ...extra })
    this.commit()
    return event
  }

  /**
   * Приёмка (`review accept`, «Принять» в UI): задача → done, worktree и ветка забыты (git-часть делает main).
   * Ответ для человека (`answerFor: 'human'`) принимает человек: это решение его запроса answer
   * (см. resolveRequest), координатор узнаёт о нём из `answer_accepted` и продолжает работу.
   * `decision` — что человек решил по ответу («Решение / что делать дальше»): уходит в событие, по нему
   * координатор заводит задачи. Принять можно только ответ последнего запуска (assertAnswerAcceptable).
   * Повторная приёмка задачи в done события не шлёт.
   */
  acceptTask(taskId: string, decision?: string): Task {
    const task = this.mustTask(taskId)
    if (task.answerFor === 'human' && !this.isKind(task, 'done')) {
      this.applyAccept(task, this.pendingRequest((r) => r.taskId === task.id && r.kind === 'answer'), decision)
    }
    // Событие — до commit в updateTask: если задача последняя, run_done придёт после answer_accepted.
    return this.updateTask(taskId, { status: this.columnId('done'), worktree: undefined, branch: undefined })
  }

  /**
   * Проверка до git-части приёмки в main: ответ для человека принимается, только если последний запуск
   * задачи сдал ответ (`done --answer-file`). Иначе (перезапуск после «Уточнить» упал, воркер ещё работает)
   * человек принял бы устаревший ответ.
   */
  assertAnswerAcceptable(taskId: string): void {
    const task = this.mustTask(taskId)
    if (task.answerFor !== 'human' || this.isKind(task, 'done')) return
    const d = this.lastDispatch(task)
    if (d?.outcome !== 'done' || d.answer === undefined) {
      throw new Error('принять нечего: последний запуск задачи не сдал ответ')
    }
  }

  /** «Принять» ответ для человека без commit: закрыть запрос answer и отправить answer_accepted. */
  private applyAccept(task: Task, request: HumanRequest | undefined, decision?: string): void {
    this.assertAnswerAcceptable(task.id)
    const d = this.lastDispatch(task)!
    if (request && request.dispatchId !== undefined && request.dispatchId !== d.id) {
      throw new Error(`запрос ${request.id} относится к прошлому запуску задачи`)
    }
    const text = decision?.trim() || undefined
    if (request) this.closeRequest(request, 'resolved', { action: 'accept', ...(text ? { text } : {}) })
    // decision — сразу после taskId, ответ — последним и обрезанным (см. finishDispatch).
    this.pushEvent('answer_accepted', {
      taskId: task.id,
      ...(text ? { decision: text } : {}),
      ...(d.summary ? { summary: d.summary } : {}),
      ...(request ? { requestId: request.id } : {}),
      dispatchId: d.id, answerFor: task.answerFor,
      ...(d.answer ? eventAnswer(d.answer) : {})
    })
  }

  /**
   * Полный ответ задачи-ответа (`orca-board task answer`): в событиях он обрезан. Берётся из последнего
   * dispatch задачи; `decision` — из последнего `answer_accepted` по задаче.
   */
  taskAnswer(taskId: string): {
    taskId: string; answerFor?: AnswerAudience; dispatchId?: string; summary?: string; decision?: string; answer?: string
  } {
    const task = this.mustTask(taskId)
    const d = this.lastDispatch(task)
    const accepted = [...this.events].reverse().find((e) => e.type === 'answer_accepted' && e.taskId === task.id)
    const decision = typeof accepted?.payload.decision === 'string' ? accepted.payload.decision : undefined
    return {
      taskId: task.id,
      ...(task.answerFor ? { answerFor: task.answerFor } : {}),
      ...(d ? { dispatchId: d.id } : {}),
      ...(d?.summary ? { summary: d.summary } : {}),
      ...(decision ? { decision } : {}),
      ...(d?.answer ? { answer: d.answer } : {})
    }
  }

  /**
   * Ревью не прошло: задача обратно в ready с замечаниями. У ответа для человека, который ждёт решения,
   * это «Уточнить» (resolveRequest clarify): запрос решён, событие answer_clarified.
   */
  rejectReview(taskId: string, feedback: string): Task {
    const task = this.mustTask(taskId)
    const request = this.pendingRequest((r) => r.taskId === task.id && r.kind === 'answer')
    if (request) this.applyClarify(task, request, feedback)
    else {
      task.feedback = feedback
      this.setStatus(task, this.columnId('ready'))
    }
    this.commit()
    return task
  }

  /**
   * Переоткрыть задачу (`orca-board task reopen`): из любой колонки, кроме in_progress, — в ready;
   * feedback выставляется, только если передан (без него остаётся прежний). Ждущий ответ для человека —
   * это «Уточнить», как в rejectReview (уточнение обязательно). Прочие ждущие запросы задачи отменяются:
   * воркер начнёт заново. Задачу с живым воркером переоткрыть нельзя — для неё `worker restart`.
   */
  reopenTask(taskId: string, feedback?: string): Task {
    const task = this.mustTask(taskId)
    if (this.isKind(task, 'in_progress') || this.workerLive(task)) {
      throw new Error(`задача ${task.id} в работе — перезапусти воркера: orca-board worker restart`)
    }
    const text = feedback?.trim() || undefined
    const request = this.pendingRequest((r) => r.taskId === task.id && r.kind === 'answer')
    if (request) this.applyClarify(task, request, text ?? '')
    else {
      if (text) task.feedback = text
      this.setStatus(task, this.columnId('ready'))
    }
    this.cancelRequests((r) => r.taskId === task.id)
    this.commit()
    return task
  }

  /** «Уточнить» без commit: feedback, ready, answer_clarified (воркера стартует main). */
  private applyClarify(task: Task, request: HumanRequest, feedback: string): void {
    const text = feedback.trim()
    if (!text) throw new Error('уточнение не может быть пустым')
    this.closeRequest(request, 'resolved', { action: 'clarify', text })
    task.feedback = text
    this.setStatus(task, this.columnId('ready'))
    this.pushEvent('answer_clarified', { taskId: task.id, feedback: short(text), requestId: request.id, dispatchId: request.dispatchId })
  }

  // ---------- questions ----------

  /**
   * Вопрос воркера (`orca-board ask`). Спрашивать может только текущий живой запуск задачи; без dispatch
   * (от имени координатора/человека) — только по несделанной задаче. Идемпотентно: пока у запуска есть
   * открытый вопрос, повторный ask возвращает его (инструмент оборвал ask по таймауту — воркер переспросил).
   * Адресат фиксируется здесь: `coordinatorAlive` (живость PTY координатора знает только main) — вопрос
   * ждёт координатора, задача в работе; иначе сразу запрос к человеку (needs_input).
   */
  ask(
    input: { taskId: string; dispatchId?: string; question: string; options?: readonly (string | RequestOption)[]; context?: string },
    opts: { coordinatorAlive?: boolean } = {}
  ): Question {
    const task = this.mustTask(input.taskId)
    if (input.dispatchId !== undefined) {
      const d = this.mustDispatch(input.dispatchId)
      if (d.taskId !== task.id || task.dispatchId !== d.id || d.endedAt) {
        throw new Error(`спрашивать может только текущий живой запуск задачи ${task.id}`)
      }
    } else if (this.isKind(task, 'done')) throw new Error(`задача ${task.id} уже сделана`)
    const existing = this.openQuestions().find((q) => q.taskId === task.id && q.dispatchId === input.dispatchId)
    if (existing) return existing
    const question = input.question.trim()
    if (!question) throw new Error('вопрос не может быть пустым')
    const q: Question = {
      id: newId('q'),
      taskId: task.id,
      dispatchId: input.dispatchId,
      question,
      options: normalizeOptions(input.options),
      ...(input.context?.trim() ? { context: input.context.trim() } : {}),
      createdAt: Date.now()
    }
    this.questions.set(q.id, q)
    const forHuman = opts.coordinatorAlive !== true
    this.pushEvent('question', {
      taskId: task.id, dispatchId: q.dispatchId, questionId: q.id, question: short(q.question),
      ...(forHuman ? { forHuman: true } : {}), options: q.options.map((o) => o.label)
    })
    if (forHuman) this.addQuestionRequest(q)
    this.commit()
    return q
  }

  /**
   * Ответ на вопрос (координатор, человек, resolveRequest). Отвеченный вопрос — ошибка: второй ответ
   * воркер получил бы вдогонку к первому. Запрос к человеку по вопросу закрывается; задача без других
   * запросов — обратно в поток: воркер жив — работает дальше, иначе ready (координатор сделает worker start).
   */
  answer(questionId: string, answer: string): Question {
    const q = this.mustQuestion(questionId)
    this.applyAnswer(q, answer)
    this.commit()
    return q
  }

  private applyAnswer(q: Question, answer: string, resolution?: RequestResolution): void {
    if (q.answeredAt) throw new Error(`на вопрос ${q.id} уже ответили: ${q.answer ?? ''}`)
    if (!answer.trim()) throw new Error('ответ не может быть пустым')
    q.answer = answer
    q.answeredAt = Date.now()
    const task = this.mustTask(q.taskId)
    const request = this.pendingRequest((r) => r.questionId === q.id)
    if (request) this.closeRequest(request, 'resolved', resolution ?? { action: 'answer', text: answer })
    this.settleTask(task)
    task.updatedAt = Date.now()
    // workerLive: false и задача в ready — координатору сделать `worker start` (ответ будет в промпте).
    this.pushEvent('question_answered', {
      taskId: task.id, dispatchId: q.dispatchId, questionId: q.id,
      ...(request ? { requestId: request.id } : {}),
      question: q.question, answer, workerLive: this.workerLive(task), status: task.status
    })
  }

  /**
   * Координатор передал вопрос человеку: вопрос остаётся открытым, по нему — запрос к человеку
   * (`note` — мнение координатора, попадает в текст запроса), событие request_created. Отвеченный вопрос
   * передать нельзя; уже переданный — повторно не передаётся.
   */
  forwardQuestion(questionId: string, note?: string): Question {
    const q = this.mustQuestion(questionId)
    if (q.answeredAt) throw new Error(`на вопрос ${questionId} уже ответили`)
    if (q.forHuman) return q
    this.addQuestionRequest(q, note)
    this.commit()
    return q
  }

  /**
   * Координатор прогона умер (main зовёт это по выходу его PTY): открытые вопросы текущих запусков,
   * которые ждали координатора, уходят человеку. Возвращает созданные запросы.
   */
  escalateOpenQuestions(runId: string): HumanRequest[] {
    this.mustRun(runId)
    const created = this.openQuestions()
      .filter((q) => !q.forHuman && this.tasks.get(q.taskId)?.runId === runId && this.currentQuestion(q))
      .map((q) => this.addQuestionRequest(q))
    if (created.length > 0) this.commit()
    return created
  }

  getQuestion(id: string): Question | undefined {
    return this.questions.get(id)
  }

  openQuestions(): Question[] {
    return [...this.questions.values()].filter((q) => !q.answeredAt)
  }

  /** Вопрос от текущего запуска задачи (или без запуска): вопрос прошлого запуска уже никому не нужен. */
  private currentQuestion(q: Question): boolean {
    return q.dispatchId === undefined || this.tasks.get(q.taskId)?.dispatchId === q.dispatchId
  }

  /** Вопрос → запрос к человеку (адресат — человек). Тело: контекст вопроса и заметка координатора. */
  private addQuestionRequest(q: Question, note?: string, emit = true): HumanRequest {
    q.forHuman = true
    const body = [q.context, note?.trim() ? `**Координатор:** ${note.trim()}` : undefined].filter(Boolean).join('\n\n')
    return this.createRequest(this.mustTask(q.taskId), {
      kind: 'question', title: q.question, ...(body ? { body } : {}), options: q.options, questionId: q.id, dispatchId: q.dispatchId
    }, emit)
  }

  // ---------- requests ----------

  listRequests(): HumanRequest[] {
    return [...this.requests.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Запросы, которые ждут человека; с runId — только этого прогона. */
  pendingRequests(runId?: string): HumanRequest[] {
    return this.listRequests().filter((r) => r.status === 'pending' && (runId === undefined || r.runId === runId))
  }

  getRequest(id: string): HumanRequest | undefined {
    return this.requests.get(id)
  }

  /**
   * Решение человека по запросу — одна транзакция (один commit) и одно событие:
   * - question + answer (вариант `optionId` и/или `text`) → ответ на вопрос, `question_answered`;
   * - answer + accept (`text` — решение) → задача в done, `answer_accepted`. Git-часть приёмки (слить ветку,
   *   убрать worktree) делает main до вызова; main может звать и `acceptTask` — это тот же переход;
   * - answer + clarify (`text` — уточнение) → задача в ready с feedback, `answer_clarified`; воркера стартует main;
   * - escalation + restart → задача в ready, `request_resolved`; воркера стартует main;
   * - escalation + dismiss → задача из «Нужен ответ» в ready (воркер мёртв), `request_resolved`.
   * Решённый или отменённый запрос — ошибка «уже решено».
   */
  resolveRequest(id: string, resolution: RequestResolution): HumanRequest {
    const request = this.requests.get(id)
    if (!request) throw new Error(`request not found: ${id}`)
    if (request.status !== 'pending') throw new Error(`уже решено: запрос ${id} ${request.status === 'cancelled' ? 'отменён' : 'решён'}`)
    if (!REQUEST_ACTIONS[request.kind].includes(resolution.action)) {
      throw new Error(`запрос ${request.kind}: действие ${resolution.action} недопустимо — ${REQUEST_ACTIONS[request.kind].join(', ')}`)
    }
    const task = this.mustTask(request.taskId)
    const text = resolution.text?.trim() || undefined
    switch (resolution.action) {
      case 'answer': {
        const q = this.mustQuestion(request.questionId ?? '')
        const option = resolution.optionId !== undefined ? request.options.find((o) => o.id === resolution.optionId) : undefined
        if (resolution.optionId !== undefined && !option) throw new Error(`варианта «${resolution.optionId}» у запроса ${id} нет`)
        const answer = [option?.label, text].filter(Boolean).join(' — ')
        if (!answer) throw new Error('нужен ответ: вариант или текст')
        this.applyAnswer(q, answer, { action: 'answer', ...(option ? { optionId: option.id } : {}), ...(text ? { text } : {}) })
        break
      }
      case 'accept':
        this.applyAccept(task, request, text)
        task.worktree = undefined
        task.branch = undefined
        this.setStatus(task, this.columnId('done'))
        this.promoteReady()
        break
      case 'clarify':
        this.applyClarify(task, request, text ?? '')
        break
      case 'restart':
      case 'dismiss':
        this.closeRequest(request, 'resolved', { action: resolution.action, ...(text ? { text } : {}) })
        if (resolution.action === 'restart' && !this.isKind(task, 'done')) this.setStatus(task, this.columnId('ready'))
        else this.settleTask(task)
        this.pushEvent('request_resolved', {
          taskId: task.id, action: resolution.action, requestId: request.id, kind: request.kind, dispatchId: request.dispatchId
        })
        break
    }
    this.commit()
    return request
  }

  /**
   * Новый запрос к человеку без commit. Задача (если не сделана) — в needs_input: колонка подзадачи
   * держится тем же предикатом, что и глобальная карточка, — есть pending-запрос. `emit` — событие
   * request_created (без него — миграция при загрузке и finishDispatch, который шлёт его после worker_done).
   */
  private createRequest(
    task: Task,
    fields: Pick<HumanRequest, 'kind' | 'title'> & Partial<Pick<HumanRequest, 'body' | 'options' | 'questionId' | 'dispatchId'>>,
    emit = true
  ): HumanRequest {
    const request: HumanRequest = {
      id: newId('req'),
      runId: task.runId ?? '',
      taskId: task.id,
      ...(fields.dispatchId !== undefined ? { dispatchId: fields.dispatchId } : {}),
      kind: fields.kind,
      status: 'pending',
      title: fields.title,
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      options: fields.options ?? [],
      ...(fields.questionId !== undefined ? { questionId: fields.questionId } : {}),
      createdAt: Date.now()
    }
    this.requests.set(request.id, request)
    if (!this.isKind(task, 'done') && !this.isKind(task, 'needs_input')) this.setStatus(task, this.columnId('needs_input'))
    if (emit) this.requestCreated(request)
    return request
  }

  /** Событие request_created: короткое, полный текст — в запросе по requestId. */
  private requestCreated(r: HumanRequest): void {
    this.pushEvent('request_created', {
      taskId: r.taskId, requestId: r.id, kind: r.kind, title: short(r.title), runId: r.runId,
      ...(r.dispatchId ? { dispatchId: r.dispatchId } : {}),
      ...(r.questionId ? { questionId: r.questionId } : {})
    })
  }

  private closeRequest(r: HumanRequest, status: 'resolved' | 'cancelled', resolution?: RequestResolution): void {
    r.status = status
    r.resolvedAt = Date.now()
    if (resolution) r.resolution = resolution
  }

  /** Отменить pending-запросы (без события): ждать человека больше незачем. */
  private cancelRequests(match: (r: HumanRequest) => boolean): void {
    for (const r of this.requests.values()) if (r.status === 'pending' && match(r)) this.closeRequest(r, 'cancelled')
  }

  private pendingRequest(match: (r: HumanRequest) => boolean): HumanRequest | undefined {
    for (const r of this.requests.values()) if (r.status === 'pending' && match(r)) return r
    return undefined
  }

  private hasPending(taskId: string): boolean {
    return this.pendingRequest((r) => r.taskId === taskId) !== undefined
  }

  /**
   * Задача в needs_input, которой больше нечего ждать от человека, — обратно в поток: воркер жив —
   * in_progress, иначе ready. Другие колонки не трогает (задачу могли перенести руками).
   */
  private settleTask(task: Task): void {
    if (!this.isKind(task, 'needs_input') || this.hasPending(task.id)) return
    this.setStatus(task, this.columnId(this.workerLive(task) ? 'in_progress' : 'ready'))
  }

  private workerLive(task: Task): boolean {
    const d = this.lastDispatch(task)
    return d !== undefined && d.endedAt === undefined
  }

  private lastDispatch(task: Task): Dispatch | undefined {
    return task.dispatchId ? this.dispatches.get(task.dispatchId) : undefined
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

  /**
   * Вернуть события в непрочитанные: забрали, но доставить не смогли (запись в сокет не удалась) —
   * следующий `check` получит их снова.
   */
  releaseEvents(ids: readonly string[]): void {
    const set = new Set(ids)
    let changed = false
    for (const e of this.events) {
      if (set.has(e.id) && e.consumedBy) {
        e.consumedBy = undefined
        changed = true
      }
    }
    if (changed) this.persistence?.save(this.snapshot())
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

  private mustQuestion(id: string): Question {
    const q = this.questions.get(id)
    if (!q) throw new Error(`question not found: ${id}`)
    return q
  }

  private mustDispatch(id: string): Dispatch {
    const dispatch = this.dispatches.get(id)
    if (!dispatch) throw new Error(`dispatch not found: ${id}`)
    return dispatch
  }
}
