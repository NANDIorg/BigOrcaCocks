import type {
  AgentSession,
  Dispatch, OrcaEvent, Run, Task, TaskStatus, AgentKind, EventType, Question,
  BoardColumn, ColumnKind, SystemColumnKind, AnswerAudience,
  HumanRequest, RequestOption, RequestResolution, TaskPriority, DispatchShowcase, StageChange
} from './types.ts'
import {
  ANSWER_AUDIENCES, DEFAULT_COLUMNS, DEFAULT_ROLE_ID, DEFAULT_TASK_PRIORITY, MAX_ANSWER_LENGTH, REQUEST_ACTIONS,
  TASK_PRIORITIES, isTaskPriority, normalizeOptions, normalizeShowcase
} from './types.ts'
import { DEFAULT_AGENT } from './agents.ts'
import { isTaskRole } from './prompts.ts'
import { trackActiveTime } from './active-time.ts'
import { recordStage, recordStatus, withStatusSource } from './status-history.ts'
import {
  WORKFLOW_VERSION, defaultWorkflow, legacyDefaultWorkflow, nextRunStage, nextStage, runStageAction,
  startRunStage, startStage, toTaskScopeWorkflow, wfNodeTitle, wfWorkRoleIds, wfWorkStage,
  type WfAction, type WfNode, type WfNodeType, type WfOutcome, type WfShowcase, type WfStage, type WfWorkStage, type Workflow
} from './workflow.ts'
import {
  globalStoredColumns, globalColumnKind, globalTaskInProgress, globalTaskStatus, globalTaskTitle, runTypeLockReason,
  toGlobalTask, toGlobalTasks,
  type GlobalColumnKind, type GlobalTask
} from './global-tasks.ts'
import type { RunTypeInput, TaskTypeSnapshot } from './task-types.ts'
import type { RunGit } from './run-branch.ts'

/**
 * Версия формата файла доски. Растёт, когда снапшот меняется так, что старая версия приложения его не поймёт
 * (не при каждом новом необязательном поле). Файл без `formatVersion` — до появления поля, то есть версия 1.
 */
export const STORE_FORMAT_VERSION = 1

export interface StoreSnapshot {
  /** Нет в файлах до появления поля — `TaskStore` при загрузке проставляет и сохраняет (`migrateFormatVersion`). */
  formatVersion: number
  tasks: Task[]
  dispatches: Dispatch[]
  events: OrcaEvent[]
  questions: Question[]
  runs: Run[]
  /** Запросы к человеку. Нет в снапшотах до их появления — тогда при загрузке идёт миграция. */
  requests: HumanRequest[]
}

/**
 * Отказ открывать доску, сохранённую более новой версией: старый код молча потерял бы неизвестные ему поля при первой
 * же записи. Образец — проверка версии графа в `validateWorkflow` (`workflow.ts`). Пустая/старая версия — не ошибка.
 */
export function assertStoreFormat(formatVersion: unknown): void {
  if (formatVersion === undefined) return
  if (!Number.isInteger(formatVersion) || (formatVersion as number) < 1) {
    throw new Error(`доска: неизвестная версия формата: ${String(formatVersion)}`)
  }
  if ((formatVersion as number) > STORE_FORMAT_VERSION) {
    throw new Error(`доска сохранена более новой версией (формат ${String(formatVersion)}, приложение знает только ${STORE_FORMAT_VERSION}) — обновите приложение`)
  }
}

/** Снимок запуска воркера для `startDispatch`: поля `Dispatch` для статистики, все необязательные. */
export type DispatchLaunch = Partial<Pick<Dispatch, 'roleId' | 'agent' | 'model' | 'sessionId'>>

/** Запуск координатора для `setRunPty`: сессия без времени и PTY — их ставит store. */
export type CoordinatorLaunch = Omit<AgentSession, 'ptyId' | 'startedAt' | 'endedAt'>

/** Объект без полей со значением `undefined`: в сохранённом состоянии пустые поля не пишутся. */
function definedFields<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
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

/** Текст решения человека для payload события: как `eventAnswer`, но поля `decision` / `decisionTruncated`. */
function eventDecision(text: string): { decision: string; decisionTruncated?: true } {
  return text.length > EVENT_ANSWER_LIMIT ? { decision: text.slice(0, EVENT_ANSWER_LIMIT), decisionTruncated: true } : { decision: text }
}

/**
 * Текстовое поле payload события: не длиннее `EVENT_ANSWER_LIMIT`, обрезанное помечено `<ключ>Truncated`. Полный
 * текст — в самом прогоне (`TaskStore.runStage`): строка события в мониторе координатора обрезается.
 */
function eventText(key: string, text: string): Record<string, string | true> {
  return text.length > EVENT_ANSWER_LIMIT
    ? { [key]: text.slice(0, EVENT_ANSWER_LIMIT), [`${key}Truncated`]: true }
    : { [key]: text }
}

/**
 * Запасной граф для `runWorkflow`, если у прогона нет снимка: граф типа прогона (или типа проекта по умолчанию
 * для «Входящих»), иначе — дефолтный по ролям `roleIds`. Оба приходят от вызывающего кода: store в библиотеку
 * типов не ходит.
 */
export interface RunWorkflowFallback {
  roleIds?: readonly string[]
  workflow?: Workflow
}

/** Опции переходов воркфлоу глобальной задачи: запасной граф и роли (как у `advanceStage`) и то, что попадёт в новый этап. */
export interface RunStageOptions extends RunWorkflowFallback {
  /** Коммит ветки глобальной задачи на входе в этап (`StageChange.commit`); определяет main. */
  commit?: string
  /** Замечания проверки или человека, вернувших в работу; в `Run.returns` и `stage_started`. */
  feedback?: string
  /** Решение человека на ноде `human` (текст «Принять»). */
  decision?: string
  /** Ответы человека на этапе «Вопрос человеку». */
  answers?: string
}

/** Где стоит глобальная задача на графе и что для этого нужно знать координатору (`TaskStore.runStage`). */
export interface RunStageInfo {
  runId: string
  nodeId: string
  type: WfNodeType
  title: string
  /** Какой по счёту заход в ноду: возврат по reject увеличивает. */
  visit: number
  /** Роль этапа «Вопрос человеку». */
  roleId?: string
  /** Роли этапа «Работа»; нет — этап не ограничивает роли подзадач (любые рабочие роли типа). */
  roleIds?: string[]
  instructions?: string
  showcase?: WfShowcase
  feedback?: string
  decision?: string
  answers?: string
  /** Подзадачи текущего захода этапа. */
  tasks: string[]
  /** Когда закрылась последняя из них (`Run.stageTasksDoneAt`); нет — этап ещё работает. */
  tasksDoneAt?: number
}

/** Необязательная часть `finishDispatch`: показ человеку и запасной граф прогона (как у `advanceStage`). */
export interface FinishDispatchOptions {
  /** Показ из `orca-board done`: `text` — markdown, `files` — пути в ветке задачи. Проверяет `normalizeShowcase`. */
  showcase?: { text?: string; files?: readonly string[] }
  fallback?: RunWorkflowFallback
}

/** Старая форма запасного графа — только роли (`runWorkflow(runId, roleIds)`). */
function isRoleIdList(x: readonly string[] | RunWorkflowFallback): x is readonly string[] {
  return Array.isArray(x)
}

function snapshotWorkflow(wf: Workflow): Workflow {
  return JSON.parse(JSON.stringify(wf)) as Workflow
}

/**
 * Где идёт воркфлоу нового прогона: граф версии 2 ведёт глобальную задачу (`workflowScope: 'run'`). Прогон типа задачи
 * без своего графа тоже (граф даст запасной вариант — граф типа или `defaultWorkflow`). Прогон вовсе без типа и графа
 * (вызывающий код до воркфлоу, тесты) и с графом версии 1 остаётся на старом движке по подзадачам — поле не ставится.
 * Приложение всегда создаёт прогон с типом (`runTypeInput`), поэтому новые прогоны получают `'run'`.
 */
function runScopeFields(graph: Workflow | undefined, typed = false): Pick<Run, 'workflowScope'> {
  return graph ? (graph.version >= WORKFLOW_VERSION ? { workflowScope: 'run' } : {}) : typed ? { workflowScope: 'run' } : {}
}

/** Поля нового прогона из его типа (копии) или, по-старому, из одного графа. */
function runTypeFields(type: Workflow | RunTypeInput | undefined): Pick<Run, 'typeId' | 'taskType' | 'workflow' | 'workflowScope'> {
  if (!type) return runScopeFields(undefined)
  if (!('typeId' in type)) return { workflow: snapshotWorkflow(type), ...runScopeFields(type) }
  return {
    typeId: type.typeId,
    taskType: JSON.parse(JSON.stringify(type.snapshot)) as TaskTypeSnapshot,
    ...(type.workflow ? { workflow: snapshotWorkflow(type.workflow) } : {}),
    ...runScopeFields(type.workflow, true)
  }
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
      // До любых записей: снапшот из будущего формата не открываем и не перезаписываем.
      assertStoreFormat(snap.formatVersion)
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
      // Первой: переходы остальных миграций (воркер умер — задача в ready) ложатся в историю после стартовой записи.
      const history = this.migrateStatusHistory()
      // До closeStaleDispatches: задача «В работе» от старого кода должна войти в него с открытым отрезком.
      const active = this.migrateActiveTime()
      const priority = this.migrateTaskPriority()
      const runPriority = this.migrateRunPriority()
      const migrated = this.migrateGlobalTasks()
      const stale = this.closeStaleDispatches()
      const requests = this.migrateRequests(snap.requests === undefined)
      const stages = this.migrateStages()
      // После migrateStages: задача, вставшая на гейт миграцией, тоже получает запись.
      const stageHistory = this.migrateStageHistory()
      // После статусов и запросов: от них зависит, идёт ли собственное время глобальной задачи.
      const own = this.migrateRunActiveTime()
      const started = this.migrateRunStarted()
      const synced = this.syncRunActiveTime()
      const format = this.migrateFormatVersion(snap.formatVersion)
      if (format || history || active || priority || runPriority || stale || requests || stages || stageHistory || migrated || own || started || synced) this.persistence?.save(this.snapshot())
    }
  }

  /**
   * Файл без `formatVersion` — до появления поля (версия 1): само поле проставит `snapshot()`, а конструктору
   * остаётся сохранить файл. Возвращает true, если версии не было. Проверка «из будущего» — `assertStoreFormat`, до миграций.
   */
  private migrateFormatVersion(formatVersion: unknown): boolean {
    return formatVersion === undefined
  }

  /**
   * Задачи и глобальные задачи от кода до истории статусов получают стартовую запись: текущая колонка с
   * `migrated: true` на момент последней правки (`updatedAt`). Прошлые переходы не восстановить — они нигде не
   * журналировались, а пустая история выглядела бы как «статус не менялся с создания». Запись с отметкой
   * честно говорит «была в этой колонке уже тогда», и следующий переход ляжет после неё. Прогон без status
   * (снапшот до глобальных задач) пропускается: колонку ему даёт `migrateGlobalTasks`, и она попадёт в историю
   * обычным переходом. Возвращает true, если что-то поменялось.
   */
  private migrateStatusHistory(): boolean {
    let changed = false
    const start = (entity: Task | Run, status: TaskStatus): void => {
      entity.statusHistory = [{ status, at: entity.updatedAt ?? entity.createdAt, by: 'app', migrated: true }]
      changed = true
    }
    for (const task of this.tasks.values()) if (task.statusHistory === undefined) start(task, task.status)
    for (const run of this.runs.values()) if (run.statusHistory === undefined && run.status !== undefined) start(run, run.status)
    return changed
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
      // Подзадачи воркфлоу глобальной задачи по графу не ходят.
      if (task.runId !== undefined && this.runs.get(task.runId)?.workflowScope === 'run') continue
      const stage = firstGateStage(legacyDefaultWorkflow([]), task.roleId)
      if (!stage) continue
      task.stage = stage
      changed = true
    }
    return changed
  }

  /**
   * Задачи в воркфлоу от кода до `stageHistory` получают историю из лога событий `stage_changed` (он не
   * обрезается, поэтому восстановление полное, пока лог жив; `by` неизвестен). Событий нет — одна запись
   * `migrated: true` на текущий этап с `at = updatedAt`. Задачи без `stage` (ответ, гейт, ещё не вошедшие
   * в граф) поле не получают. Возвращает true, если что-то поменялось.
   */
  private migrateStageHistory(): boolean {
    let changed = false
    const byTask = new Map<string, OrcaEvent[]>()
    for (const e of this.events) {
      if (e.type !== 'stage_changed' || !e.taskId) continue
      const list = byTask.get(e.taskId)
      if (list) list.push(e)
      else byTask.set(e.taskId, [e])
    }
    for (const task of this.tasks.values()) {
      if (!task.stage || task.stageHistory !== undefined) continue
      const built: { stageHistory?: StageChange[] } = {}
      for (const e of byTask.get(task.id) ?? []) {
        const p = e.payload
        if (typeof p.to !== 'string') continue
        recordStage(built, {
          nodeId: p.to, at: e.createdAt, by: 'app',
          ...(typeof p.title === 'string' ? { title: p.title } : {}),
          ...(typeof p.outcome === 'string' ? { outcome: p.outcome as WfOutcome | 'restart' } : {}),
          ...(typeof p.from === 'string' ? { from: p.from } : {})
        })
      }
      // Лога нет или он не досказал текущий этап (позицию задаче вернула `migrateStages`, события не писались) — стартовая запись.
      if (built.stageHistory?.at(-1)?.nodeId !== task.stage.nodeId) {
        recordStage(built, { nodeId: task.stage.nodeId, at: task.updatedAt, by: 'app', migrated: true })
      }
      task.stageHistory = built.stageHistory
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
   * `Run.startedAt` у прогонов от кода до поля: прогон, у которого есть координатор, подзадачи, своё время
   * или карточка не в бэклоге, считается уже бывшим в работе (точный момент неизвестен — берём `updatedAt`).
   * Остальные (в бэклоге, без координатора и подзадач) остаются без поля — тип им ещё можно сменить.
   * «Входящие» не трогаем: их тип не меняется в любом случае. Возвращает true, если что-то поменялось.
   */
  private migrateRunStarted(): boolean {
    let changed = false
    for (const run of this.runs.values()) {
      if (run.startedAt !== undefined || run.inbox) continue
      const hasSubtasks = [...this.tasks.values()].some((t) => t.runId === run.id)
      const worked = run.coordinatorPtyId !== undefined || hasSubtasks || run.activeMs !== undefined ||
        run.activeSince !== undefined || run.closedAt !== undefined || this.globalKind(run) !== 'backlog'
      if (!worked) continue
      run.startedAt = run.updatedAt ?? run.createdAt
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
      // Первый вход в работу — отметка навсегда: после неё тип задачи не меняется (`canChangeRunType`).
      if (run.activeSince !== undefined && run.startedAt === undefined) run.startedAt = run.activeSince
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
        this.setRunStatus(run, this.columnId(run.closedAt !== undefined ? 'done' : 'in_progress'))
        run.updatedAt ??= run.createdAt
        changed = true
        continue
      }
      // Глобальная задача из колонки подзадач (ready/needs_input/review/custom) — в ближайшую колонку глобального канбана.
      const status = globalTaskStatus(run.status, this.columns())
      if (status !== undefined && status !== run.status) {
        this.setRunStatus(run, status)
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
      this.setRunStatus(inbox, this.columnId(allDone ? 'done' : 'in_progress'))
      changed = true
    }
    return changed
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private commit(): void {
    // Автозакрытие прогона — решение приложения, а не того, чья команда закрыла последнюю подзадачу.
    withStatusSource('app', () => {
      this.syncStageTasks()
      this.closeFinishedRuns()
    })
    this.syncRunActiveTime()
    this.persistence?.save(this.snapshot())
    this.listeners.forEach((fn) => fn())
  }

  snapshot(): StoreSnapshot {
    return {
      formatVersion: STORE_FORMAT_VERSION,
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
   * Все смены статуса идут здесь: пишем историю (`recordStatus`, источник — `withStatusSource` вызывающего кода),
   * следим за doneAt при входе/выходе из колонки done и за временем работы
   * (отрезок открыт, пока задача в kind=in_progress, — `trackActiveTime`).
   */
  private setStatus(task: Task, status: TaskStatus): void {
    task.status = status
    recordStatus(task, status, Date.now(), task.stage ? { stage: task.stage.nodeId } : {})
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

  /**
   * Все смены колонки глобальной задачи идут здесь — ради истории статусов (`recordStatus`). Время работы
   * прогона считается не тут, а одним проходом в commit (`syncRunActiveTime`): «Нужен ответ» зависит ещё и от запросов.
   */
  private setRunStatus(run: Run, status: TaskStatus): void {
    run.status = status
    recordStatus(run, status, Date.now())
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
    /**
     * Задача-проверка воркфлоу (создаёт исполнитель в main, не координатор): ветку рабочей задачи (`taskId`) или
     * ветку глобальной задачи целиком (`runId`, воркфлоу прогона) — ровно одно из двух.
     */
    gateFor?: { nodeId: string; taskId?: string; runId?: string }
    /**
     * Этап воркфлоу глобальной задачи, к которому относится задача, — только для приложения (задача-вопрос этапа
     * `ask`). Подзадачу этапа «Работа» store привязывает сам: без этого поля и без `gateFor`.
     */
    stageOf?: { nodeId: string; visit: number }
    /** Нет — normal; в воркфлоу глобальной задачи — роль этапа «Работа». */
    priority?: TaskPriority
  }): Task {
    if (input.priority !== undefined) assertPriority(input.priority)
    if (input.answerFor !== undefined && !ANSWER_AUDIENCES.includes(input.answerFor)) {
      throw new Error(`answerFor: ожидается ${ANSWER_AUDIENCES.join(' или ')}, получено ${String(input.answerFor)}`)
    }
    const now = Date.now()
    // Подзадача всегда внутри глобальной задачи: без runId — во «Входящие»; чужой/несуществующий — ошибка.
    const run = input.runId !== undefined ? this.mustRun(input.runId) : (this.inbox() ?? this.addRun({ objective: '', inbox: true }))
    const gate = input.gateFor
    if (gate) {
      if ((gate.taskId === undefined) === (gate.runId === undefined)) throw new Error('gateFor: укажи ровно одно — taskId (ветка задачи) или runId (ветка глобальной задачи)')
      if (gate.taskId !== undefined && !this.tasks.has(gate.taskId)) throw new Error(`проверяемой задачи ${gate.taskId} нет`)
      if (gate.runId !== undefined && (gate.runId !== run.id || run.workflowScope !== 'run')) {
        throw new Error(`проверка ветки глобальной задачи ${gate.runId}: задача должна быть в этой же глобальной задаче с воркфлоу прогона`)
      }
    }
    const { roleId, stageOf } = this.bindToStage(run, input)
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
      roleId: roleId ?? DEFAULT_ROLE_ID,
      agent: input.agent ?? DEFAULT_AGENT,
      runId: run.id,
      ...(input.answerFor ? { answerFor: input.answerFor } : {}),
      ...(gate ? { gateFor: { ...gate } } : {}),
      ...(stageOf ? { stageOf: { ...stageOf } } : {}),
      createdAt: now,
      updatedAt: now
    }
    recordStatus(task, task.status, now)
    this.tasks.set(task.id, task)
    // Новая работа в закрытой глобальной задаче (или после run_done, пока координатор решал): прогон снова открыт,
    // run_done придёт по её завершении.
    if (run.closedAt !== undefined || run.runDoneAt !== undefined) this.reopenRun(run)
    this.promoteReady()
    this.commit()
    return task
  }

  /**
   * Роль и этап новой подзадачи в воркфлоу глобальной задачи (`workflowScope: 'run'`). Пока граф не начат
   * (`Run.stage` нет), ограничений нет: человек может заготовить подзадачи, они к этапу не относятся. Когда граф идёт,
   * подзадачи создаются только на этапе «Работа», привязываются к текущему заходу (`Task.stageOf`), а роль зависит
   * от `roleIds` ноды:
   * - роли не заданы — подойдёт любая рабочая роль типа (не служебная и не роль `gate` графа), выбирает координатор;
   * - роли заданы — только из списка, иначе ошибка; одна роль в списке берётся по умолчанию, если роль не передана.
   * Проверки и вопросы этапов создаёт приложение (`gateFor` или явный `stageOf`) — их этот порядок не касается.
   * Прогон старого движка и «Входящие» — без изменений.
   */
  private bindToStage(
    run: Run,
    input: { roleId?: string; gateFor?: unknown; stageOf?: { nodeId: string; visit: number } }
  ): { roleId?: string; stageOf?: { nodeId: string; visit: number } } {
    const roleId = input.roleId
    if (run.workflowScope !== 'run') {
      if (input.stageOf) throw new Error('stageOf: у прогона старого формата воркфлоу идёт по подзадачам, этапов прогона нет')
      return { ...(roleId !== undefined ? { roleId } : {}) }
    }
    if (input.stageOf) {
      if (!run.workflow?.nodes.some((n) => n.id === input.stageOf!.nodeId)) throw new Error(`в воркфлоу глобальной задачи ${run.id} нет ноды «${input.stageOf.nodeId}»`)
      return { ...(roleId !== undefined ? { roleId } : {}), stageOf: input.stageOf }
    }
    if (input.gateFor || !run.stage) return { ...(roleId !== undefined ? { roleId } : {}) }
    const node = this.runWorkflow(run.id).nodes.find((n) => n.id === run.stage!.nodeId)
    const where = node ? `«${wfNodeTitle(node)}»` : `«${run.stage.nodeId}»`
    if (node?.type !== 'work') {
      throw new Error(`подзадачи создаются только на этапе «Работа»: глобальная задача ${run.id} сейчас на этапе ${where} — дождись stage_started`)
    }
    const stageOf = { nodeId: node.id, visit: run.stage.visits[node.id] ?? 1 }
    const allowed = wfWorkRoleIds(node)
    if (allowed.length > 0) {
      if (roleId !== undefined && !allowed.includes(roleId)) {
        throw new Error(`роль «${roleId}» не разрешена на этапе ${where}: его ведут агенты ролей ${allowed.map((r) => `«${r}»`).join(', ')}`)
      }
      return { roleId: roleId ?? (allowed.length === 1 ? allowed[0] : undefined), stageOf }
    }
    if (roleId !== undefined) {
      const wf = this.runWorkflow(run.id)
      const gateRoles = new Set(wf.nodes.flatMap((n) => (n.type === 'gate' ? [n.roleId] : [])))
      if (!isTaskRole(roleId) || gateRoles.has(roleId)) {
        throw new Error(`роль «${roleId}» не разрешена на этапе ${where}: подзадачи ведут рабочие роли типа, а не служебные и не роли проверки`)
      }
    }
    return { ...(roleId !== undefined ? { roleId } : {}), stageOf }
  }

  /**
   * Роль подзадачи, которую можно не передавать: одна роль ноды «Работа», на которой стоит глобальная задача
   * (`bindToStage` берёт её сам). Нет такой (этап не «Работа», ролей нет или несколько, прогон старого движка) —
   * undefined, роль тогда выбирает вызывающий. Нужна main: `orca-board task create` без `--role` требует роль.
   */
  stageDefaultRole(runId: string): string | undefined {
    const run = this.runs.get(runId)
    if (!run || run.workflowScope !== 'run' || !run.stage) return undefined
    const node = this.runWorkflow(run.id).nodes.find((n) => n.id === run.stage!.nodeId)
    if (node?.type !== 'work') return undefined
    const allowed = wfWorkRoleIds(node)
    return allowed.length === 1 ? allowed[0] : undefined
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
      this.setRunStatus(run, toId)
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

  /**
   * backlog → ready, если все зависимости закрыты (по kind колонок). Задаче-гейту task_ready не шлётся:
   * её воркера запускает исполнитель воркфлоу сразу после создания, координатору делать нечего.
   */
  private promoteReady(): void {
    // Задачу двигают закрытые зависимости, а не тот, чей вызов их закрыл.
    withStatusSource('app', () => this.promoteReadyTasks())
  }

  private promoteReadyTasks(): void {
    for (const task of this.tasks.values()) {
      if (!this.isKind(task, 'backlog')) continue
      const depsDone = task.deps.every((d) => {
        const dep = this.tasks.get(d)
        return dep !== undefined && this.isKind(dep, 'done')
      })
      if (depsDone) {
        this.setStatus(task, this.columnId('ready'))
        if (!task.gateFor) this.pushEvent('task_ready', { taskId: task.id })
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

  /**
   * `type` — тип глобальной задачи (`RunTypeInput`: id, снимок и граф, прогон хранит их копии — `Run.typeId`,
   * `Run.taskType`, `Run.workflow`) или, по-старому, только граф.
   */
  createRun(objective: string, coordinatorPtyId?: string, type?: Workflow | RunTypeInput): Run {
    const run = this.addRun({ objective, coordinatorPtyId, ...runTypeFields(type) })
    this.commit()
    return run
  }

  /**
   * Граф прогона: снимок, а у прогона без снимка (от кода до воркфлоу, «Входящие») — `fallback.workflow`
   * (граф типа), иначе дефолтный граф по ролям `fallback.roleIds`. Массив вместо объекта — старая форма
   * (только роли).
   */
  runWorkflow(runId: string | undefined, fallback: readonly string[] | RunWorkflowFallback = {}): Workflow {
    const run = runId !== undefined ? this.runs.get(runId) : undefined
    const fb = isRoleIdList(fallback) ? { roleIds: fallback } : fallback
    const roles = (fb.roleIds ?? []).map((id) => ({ id }))
    if (run?.workflowScope === 'run') {
      // Граф по подзадачам (версия 1) прогон глобальной задачи не поведёт: у прогона без своего графа — дефолтный.
      const own = run.workflow ?? fb.workflow
      return own && own.version >= WORKFLOW_VERSION ? own : defaultWorkflow(roles)
    }
    // Старый движок (прогон без `workflowScope`, «Входящие», прогон без id): граф версии 2 по подзадачам не ходит.
    // Граф типа из библиотеки уже мог мигрировать до v2 — для подзадач его переводят обратно (`toTaskScopeWorkflow`).
    const own = run?.workflow ?? fb.workflow
    return own ? toTaskScopeWorkflow(own) : legacyDefaultWorkflow(roles)
  }

  /**
   * Миграция на типы задач: прогоны без `typeId` (кроме «Входящих») получают тип и его снимок — тип, в который
   * main перенёс настройки проекта. `Run.workflow` не трогается: идущие задачи продолжают по своему графу.
   * Идемпотентна; возвращает число изменённых прогонов (0 — без записи на диск).
   */
  assignRunTypes(type: { typeId: string; snapshot: TaskTypeSnapshot }): number {
    let changed = 0
    for (const run of this.runs.values()) {
      if (run.inbox || run.typeId !== undefined) continue
      run.typeId = type.typeId
      run.taskType = JSON.parse(JSON.stringify(type.snapshot)) as TaskTypeSnapshot
      changed += 1
    }
    if (changed > 0) this.commit()
    return changed
  }

  /**
   * Переход задачи по воркфлоу прогона: `nextStage` по исходу `outcome` текущего этапа. Задача без `stage`
   * входит в граф из старта (только `next`). Меняет только `stage` — колонку, воркера, гейт и мерж по
   * `action` делает исполнитель в main. Событие `stage_changed`, если этап сменился, и `workflow_blocked`,
   * если дальше идти нельзя. `opts` — роли типа прогона (проверка роли гейта, дефолтный граф) и граф типа для
   * прогона без снимка (`runWorkflow`).
   */
  advanceStage(taskId: string, outcome: WfOutcome, opts: RunWorkflowFallback = {}): { task: Task; action: WfAction } {
    const task = this.mustTask(taskId)
    if (task.answerFor) throw new Error(`задача ${taskId} — задача-ответ, она идёт мимо воркфлоу`)
    if (task.gateFor) throw new Error(`задача ${taskId} — проверка ${task.gateFor.taskId !== undefined ? `задачи ${task.gateFor.taskId}` : `глобальной задачи ${task.gateFor.runId}`}, у неё нет своего этапа`)
    if (this.isRunScope(task)) throw new Error(`задача ${taskId} — подзадача воркфлоу глобальной задачи: по графу ходит сама глобальная задача (advanceRunStage)`)
    if (!task.stage && outcome !== 'next') {
      throw new Error(`задача ${taskId} ещё не в воркфлоу: войти в него можно только исходом next, получено ${outcome}`)
    }
    const wf = this.runWorkflow(task.runId, opts)
    const ctx = { roleId: task.roleId, ...(opts.roleIds ? { roleIds: opts.roleIds } : {}) }
    const step = task.stage ? nextStage(wf, task.stage, outcome, ctx) : startStage(wf, ctx)
    const from = task.stage?.nodeId
    const moved = step.stage.nodeId !== from && step.stage.nodeId !== ''
    if (moved) {
      task.stage = step.stage
      task.updatedAt = Date.now()
      const node = wf.nodes.find((n) => n.id === step.stage.nodeId)
      recordStage(task, {
        nodeId: step.stage.nodeId, at: task.updatedAt, outcome, ...(node ? { title: wfNodeTitle(node) } : {}),
        ...(from !== undefined ? { from } : {})
      })
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

  /**
   * Задача снова идёт в работу (`worker start`, перезапуск, «Уточнить» не в счёт — у задач-ответов этапа нет):
   * этап, который не «Работа» и не «Вопрос человеку» (задачу вернули вручную с ревью, переоткрыли из done),
   * сбрасывается на первый этап
   * от старта — иначе её `done` пришёл бы на этап проверки. Задача без этапа входит в граф. Заходы (`visits`)
   * копятся: лимит повторов считает и такие возвраты. Этапы «Работа» и «Вопрос человеку» не трогаются: агент
   * входит в `ask` при каждом запуске (`worker start`, автоперезапуск после ответа), и сброс вернул бы задачу
   * на первую «Работу». Задачи-ответы и гейты — мимо.
   * Возвращает действие нового этапа или undefined, если этап не менялся.
   */
  enterWork(taskId: string, opts: RunWorkflowFallback = {}): WfAction | undefined {
    const task = this.mustTask(taskId)
    if (task.answerFor || task.gateFor || this.isRunScope(task)) return undefined
    const wf = this.runWorkflow(task.runId, opts)
    const current = task.stage ? wf.nodes.find((n) => n.id === task.stage!.nodeId) : undefined
    if (current?.type === 'work' || current?.type === 'ask') return undefined
    if (!task.stage) return this.advanceStage(taskId, 'next', opts).action
    const ctx = { roleId: task.roleId, ...(opts.roleIds ? { roleIds: opts.roleIds } : {}) }
    const step = startStage(wf, ctx)
    if (step.action.type === 'blocked') {
      this.pushEvent('workflow_blocked', { taskId, runId: task.runId, nodeId: step.action.nodeId, reason: short(step.action.reason) })
      this.commit()
      return step.action
    }
    const visits = { ...task.stage.visits }
    for (const [id, n] of Object.entries(step.stage.visits)) visits[id] = (visits[id] ?? 0) + n
    const from = task.stage.nodeId
    task.stage = { nodeId: step.stage.nodeId, visits }
    task.updatedAt = Date.now()
    const node = wf.nodes.find((n) => n.id === step.stage.nodeId)
    recordStage(task, { nodeId: step.stage.nodeId, at: task.updatedAt, outcome: 'restart', from, ...(node ? { title: wfNodeTitle(node) } : {}) })
    this.pushEvent('stage_changed', {
      taskId, runId: task.runId, from, to: step.stage.nodeId, outcome: 'restart',
      ...(node ? { nodeType: node.type, title: wfNodeTitle(node) } : {})
    })
    this.commit()
    return step.action
  }

  /** Задача принадлежит глобальной задаче с воркфлоу прогона: её позиции на графе нет. */
  private isRunScope(task: Task): boolean {
    return task.runId !== undefined && this.runs.get(task.runId)?.workflowScope === 'run'
  }

  /**
   * Исполнитель не смог выполнить эффект этапа (воркер или проверка не запустились, мерж упал не конфликтом):
   * задача остаётся на этапе, координатору и человеку — `workflow_blocked` с причиной.
   */
  blockStage(taskId: string, reason: string): OrcaEvent {
    const task = this.mustTask(taskId)
    const event = this.pushEvent('workflow_blocked', {
      taskId, runId: task.runId, ...(task.stage ? { nodeId: task.stage.nodeId } : {}), reason: short(reason)
    })
    this.commit()
    return event
  }

  /**
   * Нода `human`: запрос approval к человеку («Принять» / «Вернуть»), задача — в «Нужен ответ».
   * Ждущий approval той же задачи не дублируется — возвращается он. `showcaseDispatchId` — чей показ в `body`.
   */
  requestApproval(taskId: string, fields: { nodeId: string; title: string; body?: string; showcaseDispatchId?: string }): HumanRequest {
    const task = this.mustTask(taskId)
    const existing = this.pendingRequest((r) => r.taskId === task.id && r.kind === 'approval')
    if (existing) return existing
    const request = this.createRequest(task, {
      kind: 'approval', title: fields.title, nodeId: fields.nodeId, ...(fields.body ? { body: fields.body } : {}),
      ...(fields.showcaseDispatchId ? { showcaseDispatchId: fields.showcaseDispatchId } : {})
    })
    this.commit()
    return request
  }

  // ---------- воркфлоу глобальной задачи ----------

  private mustRunScope(runId: string): Run {
    const run = this.mustRun(runId)
    if (run.workflowScope !== 'run') {
      throw new Error(`глобальная задача ${runId} идёт по воркфлоу подзадач (старый формат) — этапов прогона у неё нет`)
    }
    return run
  }

  /**
   * Колонка глобальной задачи на ноде: заданная нодой (`WfNode.column`, если это колонка глобального канбана),
   * иначе по умолчанию — `human` встаёт на «Проверку», `end` — в «Сделано», остальные ноды — «В работе».
   */
  private stageColumn(node: WfNode | undefined): string {
    if (node?.column !== undefined && globalStoredColumns(this.columns()).some((c) => c.id === node.column)) return node.column
    return this.columnId(node?.type === 'human' ? 'review' : node?.type === 'end' ? 'done' : 'in_progress')
  }

  /**
   * Позиция глобальной задачи на графе с деталями этапа — для координатора (`stage get`) и для цели перезапущенного
   * координатора: то же, что в `stage_started`, но тексты целиком. `tasks` — подзадачи текущего захода этапа.
   * Нет позиции (граф не начат, прогон старого формата) — undefined.
   */
  runStage(runId: string, fallback: RunWorkflowFallback = {}): RunStageInfo | undefined {
    const run = this.mustRun(runId)
    if (run.workflowScope !== 'run' || !run.stage) return undefined
    const node = this.runWorkflow(run.id, fallback).nodes.find((n) => n.id === run.stage!.nodeId)
    if (!node) return undefined
    const visit = run.stage.visits[node.id] ?? 1
    const stage = wfWorkStage({ version: WORKFLOW_VERSION, nodes: [node], edges: [] }, node.id)
    return {
      runId: run.id,
      nodeId: node.id,
      type: node.type,
      title: wfNodeTitle(node),
      visit,
      ...(stage?.roleId ? { roleId: stage.roleId } : {}),
      ...(stage?.roleIds ? { roleIds: stage.roleIds } : {}),
      ...(stage?.instructions ? { instructions: stage.instructions } : {}),
      ...(stage?.showcase ? { showcase: stage.showcase } : {}),
      ...run.stageInput,
      tasks: this.stageTasks(run).map((t) => t.id),
      ...(run.stageTasksDoneAt !== undefined ? { tasksDoneAt: run.stageTasksDoneAt } : {})
    }
  }

  /** Подзадачи текущего захода в текущий этап глобальной задачи (задачи прошлых заходов — не в счёт). */
  private stageTasks(run: Run): Task[] {
    const stage = run.stage
    if (!stage) return []
    const visit = stage.visits[stage.nodeId] ?? 1
    return [...this.tasks.values()].filter(
      (t) => t.runId === run.id && !t.gateFor && t.stageOf?.nodeId === stage.nodeId && t.stageOf.visit === visit
    )
  }

  /**
   * Этап «Работа» глобальной задачи закончен по подзадачам: есть хотя бы одна и все в kind=done. Как `closeFinishedRuns`
   * у старого движка: `stage_tasks_done` координатору — один раз (`Run.stageTasksDoneAt`), не закрывая этап: координатор
   * решает, нужно ли ещё что-то, и зовёт `stage finish`. Подзадача, ушедшая из done, или новая подзадача снимает
   * метку (непрочитанные `stage_tasks_done` гасятся). Вызывается из `commit`, поэтому ловит любую смену статуса.
   */
  private syncStageTasks(): void {
    for (const run of this.runs.values()) {
      if (run.workflowScope !== 'run' || !run.stage || run.closedAt !== undefined) continue
      const node = run.workflow?.nodes.find((n) => n.id === run.stage!.nodeId)
      if (node?.type !== 'work') continue
      const tasks = this.stageTasks(run)
      const done = tasks.length > 0 && tasks.every((t) => this.isKind(t, 'done'))
      if (done && run.stageTasksDoneAt === undefined) {
        run.stageTasksDoneAt = Date.now()
        run.updatedAt = run.stageTasksDoneAt
        this.pushEvent('stage_tasks_done', { runId: run.id, nodeId: node.id })
      } else if (!done && run.stageTasksDoneAt !== undefined) {
        this.dropStageEvents(run.id)
        run.stageTasksDoneAt = undefined
      }
    }
  }

  /** Непрочитанные `stage_tasks_done` прогона гасятся: этап ожил или ушёл дальше, координатору они больше не нужны. */
  private dropStageEvents(runId: string): void {
    for (const e of this.events) {
      if (e.type === 'stage_tasks_done' && e.payload.runId === runId && !e.consumedBy) e.consumedBy = 'stage'
    }
  }

  /**
   * Первый вход глобальной задачи в граф: из старта до первой ноды с действием (обычно — «Работа»). Граф прогона
   * фиксируется снимком (`Run.workflow`), если его не было. Граф уже начат — позицию не меняет и возвращает действие
   * текущей ноды: так исполнитель повторяет эффект после рестарта. `opts.commit` — коммит ветки прогона на входе
   * (`StageChange.commit`).
   */
  enterRunStage(runId: string, opts: RunStageOptions = {}): { run: Run; action: WfAction } {
    const run = this.mustRunScope(runId)
    const wf = this.runWorkflow(runId, opts)
    if (run.stage) return { run, action: runStageAction(wf, run.stage, this.stageCtx(opts)) }
    const action = this.moveRunStage(run, wf, undefined, 'next', opts)
    this.commit()
    return { run, action }
  }

  /**
   * Переход глобальной задачи по исходу текущей ноды (`nextRunStage`): меняет `Run.stage`, историю и колонку карточки,
   * шлёт `stage_changed` и событие по новой ноде — `stage_started` на «Работе», `run_done` при входе в `end`
   * (прогон закрыт, карточка — в «Сделано»), `workflow_blocked`, если дальше идти нельзя (позиция остаётся).
   * Сами эффекты — создать проверку или вопрос, запросить человека, слить ветку — делает main по возвращённому действию.
   * `opts.feedback` — замечания проверки или человека при `reject` (пишутся в `Run.returns` и в `stage_started`),
   * `decision` — решение человека, `answers` — ответы этапа «Вопрос человеку»: они уходят координатору на следующую «Работу».
   * Этап «Работа» закрывает не этот метод, а `finishStage`.
   */
  advanceRunStage(runId: string, outcome: WfOutcome, opts: RunStageOptions = {}): { run: Run; action: WfAction } {
    const run = this.mustRunScope(runId)
    if (!run.stage) throw new Error(`граф глобальной задачи ${runId} ещё не начат — сначала enterRunStage`)
    if (run.closedAt !== undefined && this.runWorkflow(runId, opts).nodes.find((n) => n.id === run.stage!.nodeId)?.type === 'end') {
      throw new Error(`граф глобальной задачи ${runId} уже дошёл до конца`)
    }
    const wf = this.runWorkflow(runId, opts)
    const action = this.moveRunStage(run, wf, run.stage, outcome, opts)
    this.commit()
    return { run, action }
  }

  /**
   * Координатор закончил набор агентов на этапе «Работа» (`stage finish`): граф идёт дальше исходом `next`. Закрыть можно,
   * только когда закрыты все подзадачи текущего захода (`stage_tasks_done`), и хотя бы одна есть. `summary` —
   * сводка для следующих нод (проверка, человек): пишется в историю этапа и в `Run.summary` («Что сделал»).
   * Ошибки — с подсказкой, что делать координатору.
   */
  finishStage(runId: string, opts: RunStageOptions & { summary?: string } = {}): { run: Run; action: WfAction } {
    const run = this.mustRunScope(runId)
    const wf = this.runWorkflow(runId, opts)
    const node = run.stage ? wf.nodes.find((n) => n.id === run.stage!.nodeId) : undefined
    if (!run.stage || node?.type !== 'work') {
      throw new Error(`stage finish: глобальная задача ${runId} сейчас не на этапе «Работа»${node ? ` (этап «${wfNodeTitle(node)}»)` : ''} — закрывать нечего, дождись stage_started`)
    }
    const tasks = this.stageTasks(run)
    if (tasks.length === 0) throw new Error(`stage finish: на этапе «${wfNodeTitle(node)}» нет подзадач — создай их (task create) и дождись stage_tasks_done`)
    const open = tasks.filter((t) => !this.isKind(t, 'done'))
    if (open.length > 0) {
      throw new Error(`stage finish: на этапе «${wfNodeTitle(node)}» не закрыты подзадачи (${open.map((t) => t.id).join(', ')}) — дождись stage_tasks_done`)
    }
    const text = opts.summary?.trim()
    if (text) {
      const entry = [...(run.stageHistory ?? [])].reverse().find((h) => h.nodeId === node.id)
      if (entry) entry.summary = text
      run.summary = { at: Date.now(), text }
    }
    const action = this.moveRunStage(run, wf, run.stage, 'next', opts)
    this.commit()
    return { run, action }
  }

  /**
   * Страховка на случай, когда координатор умер (вышел, упал, приложение перезапустили), не успев вызвать `stage finish`:
   * этапы «Работа» прогонов с закрытыми подзадачами (`stageTasksDoneAt`) закрываются без сводки — аналог `settleIdleRuns`
   * старого движка. Живость PTY знает только main, он и вызывает. `fallback` — запасной граф и роли прогона (как у
   * `runWorkflow`). Возвращает закрытые прогоны с действием нового этапа: эффекты — забота main.
   */
  settleIdleStages(
    isAlive: (ptyId: string) => boolean,
    fallback: (run: Run) => RunStageOptions = () => ({})
  ): Array<{ runId: string; action: WfAction }> {
    const settled: Array<{ runId: string; action: WfAction }> = []
    for (const run of [...this.runs.values()]) {
      if (run.workflowScope !== 'run' || run.stageTasksDoneAt === undefined || run.closedAt !== undefined) continue
      if (run.coordinatorPtyId && isAlive(run.coordinatorPtyId)) continue
      const opts = fallback(run)
      const action = this.moveRunStage(run, this.runWorkflow(run.id, opts), run.stage, 'next', opts)
      settled.push({ runId: run.id, action })
    }
    if (settled.length > 0) this.commit()
    return settled
  }

  /** Контекст `nextRunStage`: роли проекта сейчас — чтобы `blocked`, если роль этапа удалили. */
  private stageCtx(opts: RunStageOptions): { roleIds?: readonly string[] } {
    return opts.roleIds ? { roleIds: opts.roleIds } : {}
  }

  /**
   * Переход по графу без commit (общий для enter/advance/finish/settle): двигает `Run.stage`, пишет историю,
   * колонку и события. Возвращает действие ноды, куда пришли; `blocked` без движения — позиция не меняется.
   */
  private moveRunStage(run: Run, wf: Workflow, from: WfStage | undefined, outcome: WfOutcome, opts: RunStageOptions): WfAction {
    const ctx = this.stageCtx(opts)
    const step = from ? nextRunStage(wf, from, outcome, ctx) : startRunStage(wf, ctx)
    const now = Date.now()
    const nodeAt = (id: string): WfNode | undefined => wf.nodes.find((n) => n.id === id)
    const fromId = from?.nodeId
    const moved = step.stage !== from && step.stage.nodeId !== ''
    run.workflow ??= snapshotWorkflow(wf)
    if (moved) {
      const node = nodeAt(step.stage.nodeId)
      const input = {
        ...(opts.feedback?.trim() ? { feedback: opts.feedback.trim() } : {}),
        ...(opts.decision?.trim() ? { decision: opts.decision.trim() } : {}),
        ...(opts.answers?.trim() ? { answers: opts.answers.trim() } : {})
      }
      run.stage = step.stage
      run.stageInput = Object.keys(input).length > 0 ? input : undefined
      this.dropStageEvents(run.id)
      run.stageTasksDoneAt = undefined
      run.updatedAt = now
      recordStage(run, {
        nodeId: step.stage.nodeId, at: now, outcome, visit: step.stage.visits[step.stage.nodeId] ?? 1,
        ...(node ? { title: wfNodeTitle(node) } : {}),
        ...(fromId !== undefined ? { from: fromId } : {}),
        ...(opts.commit ? { commit: opts.commit } : {})
      })
      if (outcome === 'reject' && input.feedback) run.returns = [...(run.returns ?? []), { at: now, text: input.feedback }]
      this.pushEvent('stage_changed', {
        runId: run.id, ...(fromId !== undefined ? { from: fromId } : {}), to: step.stage.nodeId, outcome,
        ...(node ? { nodeType: node.type, title: wfNodeTitle(node) } : {})
      })
    }
    const action = step.action
    const node = nodeAt(action.nodeId)
    switch (action.type) {
      case 'blocked':
        this.pushEvent('workflow_blocked', { runId: run.id, nodeId: action.nodeId, reason: short(action.reason) })
        break
      case 'done':
        // Граф дошёл до конца: прогон закрыт, координатор выходит. Ждать человека больше нечего.
        this.cancelRequests((r) => r.runId === run.id)
        run.closedAt = now
        run.reopenedAt = undefined
        run.runDoneAt = undefined
        this.setRunStatus(run, this.stageColumn(node))
        run.updatedAt = now
        if (!run.inbox) this.pushEvent('run_done', { runId: run.id, objective: run.objective, nodeId: action.nodeId })
        break
      case 'start_stage': {
        this.placeRun(run, this.stageColumn(node))
        const info = this.runStage(run.id, opts)
        const p = {
          runId: run.id, nodeId: action.nodeId, title: info?.title ?? action.nodeId, roleIds: action.roleIds, visit: info?.visit ?? 1,
          ...(info?.instructions ? eventText('instructions', info.instructions) : {}),
          ...(info?.feedback ? eventText('feedback', info.feedback) : {}),
          ...(info?.decision ? eventText('decision', info.decision) : {}),
          ...(info?.answers ? eventText('answers', info.answers) : {})
        }
        this.pushEvent('stage_started', p)
        break
      }
      default:
        this.placeRun(run, this.stageColumn(node))
    }
    return action
  }

  /** Карточка глобальной задачи в колонку `status` (не трогая, если она там уже стоит). */
  private placeRun(run: Run, status: string): void {
    if (run.status === status) return
    this.setRunStatus(run, status)
    run.updatedAt = Date.now()
  }

  /**
   * Исполнитель не смог выполнить эффект этапа глобальной задачи (проверка или вопрос не создались, слияние в
   * защищённую ветку, git упал не конфликтом): позиция остаётся, координатору и человеку — `workflow_blocked` с
   * причиной и `runId` (без `taskId`).
   */
  blockRunStage(runId: string, reason: string): OrcaEvent {
    const run = this.mustRunScope(runId)
    const event = this.pushEvent('workflow_blocked', {
      runId, ...(run.stage ? { nodeId: run.stage.nodeId } : {}), reason: short(reason)
    })
    this.commit()
    return event
  }

  /**
   * Нода `human` воркфлоу глобальной задачи: approval уровня прогона («Принять» / «Вернуть») без задачи. Карточка встаёт
   * в «Нужен ответ», пока запрос ждёт (`waiting`). Ждущий approval прогона не дублируется — возвращается он.
   * Решение — `resolveRequest`; дальше граф двигает main (`advanceRunStage` с `feedback`/`decision` из решения).
   */
  requestRunApproval(runId: string, fields: { nodeId: string; title: string; body?: string; showcaseDispatchId?: string }): HumanRequest {
    const run = this.mustRunScope(runId)
    const existing = this.pendingRequest((r) => r.runId === run.id && r.taskId === undefined && r.kind === 'approval')
    if (existing) return existing
    const request = this.createRequest(run, {
      kind: 'approval', title: fields.title, nodeId: fields.nodeId, ...(fields.body ? { body: fields.body } : {}),
      ...(fields.showcaseDispatchId ? { showcaseDispatchId: fields.showcaseDispatchId } : {})
    })
    this.commit()
    return request
  }

  /** Новый прогон без commit. Статус по умолчанию — колонка kind=backlog. */
  private addRun(fields: Partial<Omit<Run, 'id' | 'createdAt'>> & { objective: string }, createdAt = Date.now()): Run {
    const run: Run = { status: this.columnId('backlog'), priority: DEFAULT_TASK_PRIORITY, ...fields, id: newId('run'), createdAt, updatedAt: createdAt }
    if (run.status !== undefined) recordStatus(run, run.status, createdAt)
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

  /** Карточка в закрытой колонке — «Проверка» (review) или «Сделано» (done): работа по ней не идёт. */
  private isClosedKind(run: Run): boolean {
    const kind = this.globalKind(run)
    return kind === 'done' || kind === 'review'
  }

  /**
   * Закрытый прогон (или прогон после run_done — `runDoneAt`) снова открыт: автозакрытие ждёт новой подзадачи
   * в done; карточка из done/review — в работу.
   * Непрочитанные run_done прошлого закрытия гасятся, чтобы новый координатор не получил их сразу.
   */
  private reopenRun(run: Run): void {
    for (const e of this.events) {
      if (e.type === 'run_done' && e.payload.runId === run.id && !e.consumedBy) e.consumedBy = 'reopen'
    }
    run.closedAt = undefined
    run.runDoneAt = undefined
    run.finishedAt = undefined
    run.reopenedAt = Date.now()
    if (run.status === undefined || this.isClosedKind(run)) this.setRunStatus(run, this.columnId('in_progress'))
    run.updatedAt = Date.now()
  }

  /**
   * Координатор запущен на прогоне (новом или повторно на существующей глобальной задаче):
   * закрытый прогон переоткрывается, карточка — в колонку kind=in_progress.
   */
  setRunPty(runId: string, ptyId: string, agent?: AgentKind, session?: CoordinatorLaunch): Run {
    const run = this.mustRun(runId)
    if (run.closedAt !== undefined || run.runDoneAt !== undefined) this.reopenRun(run)
    run.coordinatorPtyId = ptyId
    run.coordinatorAgent = agent
    // Каждый запуск — отдельная сессия: время и токены координатора складываются по всем его перезапускам.
    if (session) (run.coordinatorSessions ??= []).push({ ptyId, startedAt: Date.now(), ...definedFields(session) })
    this.setRunStatus(run, this.columnId('in_progress'))
    run.updatedAt = Date.now()
    this.commit()
    return run
  }

  /**
   * PTY координатора закрылся: конец его сессии для статистики. Прогон могли удалить, пока терминал жил, —
   * тогда нечего отмечать.
   */
  coordinatorExited(runId: string, ptyId: string): void {
    const session = this.runs.get(runId)?.coordinatorSessions?.find((s) => s.ptyId === ptyId && s.endedAt === undefined)
    if (!session) return
    session.endedAt = Date.now()
    this.commit()
  }

  /**
   * Ветка глобальной задачи (`Run.git`): заводит её, отмечает push и уборку worktree main (`src/main/run-branch.ts`).
   * `undefined` в патче снимает поле. У «Входящих» ветки нет: это не фича, а корзина разрозненных задач.
   */
  setRunGit(runId: string, patch: Partial<RunGit>): Run {
    const run = this.mustRun(runId)
    if (run.inbox) throw new Error('у «Входящих» нет своей ветки')
    const next: Partial<RunGit> = { ...run.git, ...patch }
    if (!next.branch || !next.base) throw new Error(`ветка глобальной задачи ${runId}: нужны branch и base`)
    for (const k of Object.keys(next) as Array<keyof RunGit>) if (next[k] === undefined) delete next[k]
    run.git = next as RunGit
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
   * priority — по умолчанию normal. `type` — тип задачи (как в `createRun`); `workflow` — старая форма, только граф.
   */
  createGlobalTask(input: {
    title?: string; description?: string; status?: string; priority?: TaskPriority; workflow?: Workflow; type?: RunTypeInput
  }): GlobalTask {
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
      ...runTypeFields(input.type ?? input.workflow)
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
   * Сменить тип глобальной задачи до начала работы (`runTypeLockReason`): `typeId`, снимок типа и снимок графа
   * пересобираются из `type` так же, как при создании (`runTypeFields`); граф старого типа не остаётся, даже если
   * у нового графа нет (прогон пойдёт по графу типа из библиотеки). Тип берёт main из библиотеки проекта.
   */
  changeGlobalTaskType(id: string, type: RunTypeInput): GlobalTask {
    const run = this.mustRun(id)
    const subtasks = [...this.tasks.values()].filter((t) => t.runId === id).length
    const statusKind = run.status === undefined ? undefined : this.columnKind(run.status)
    const reason = runTypeLockReason({ ...run, subtasks, statusKind })
    if (reason) throw new Error(`тип глобальной задачи «${globalTaskTitle(run)}» (${id}) нельзя сменить: ${reason}`)
    delete run.typeId
    delete run.taskType
    delete run.workflow
    delete run.workflowScope
    Object.assign(run, runTypeFields(type))
    run.updatedAt = Date.now()
    this.commit()
    return this.getGlobalTask(id)
  }

  /**
   * Ручное перемещение карточки по колонкам проекта. Статусы подзадач не меняются.
   * В колонку kind=done или review («Проверка») — человек объявил работу сделанной: открытый прогон (в том числе
   * после run_done, пока координатор решал — `runDoneAt`) закрывается с `run_done {manual: true}`, чтобы координатор (если ждёт) закончил, а приложение закрыло
   * его терминал. Уже закрытый прогон повторно не закрывается (review → done — это «Подтвердить», done → review —
   * просто перенос). Из done/review в backlog/in_progress — прогон снова открыт (reopenRun), координатор не
   * запускается. В done/review запросы прогона к человеку отменяются (cancelled): отвечать больше незачем.
   * «Входящие» на «Проверку» не ставятся (как и при автозакрытии, `reviewColumn`): у них нет координатора,
   * «Подтвердить» и «Вернуть в работу» им недоступны — карточка застряла бы в колонке без действий.
   */
  moveGlobalTask(id: string, status: string): GlobalTask {
    const run = this.mustRun(id)
    this.assertGlobalColumn(status)
    const kind = this.columnKind(status)
    if (kind === 'review' && run.inbox) throw new Error('«Входящие» не проверяются: у них нет координатора — перенеси в «Сделано»')
    if (kind === 'done' || kind === 'review') {
      this.cancelRequests((r) => r.runId === run.id)
      if (run.closedAt === undefined) this.closeDone(run, status, true)
    } else if (run.closedAt !== undefined) {
      this.reopenRun(run)
    }
    this.setRunStatus(run, status)
    run.updatedAt = Date.now()
    this.commit()
    return this.getGlobalTask(id)
  }

  /**
   * «Подтвердить» на проверке: человек принял результат — карточка из kind=review в done. Прогон уже закрыт
   * (`runs finish`, выход координатора после run_done или автозакрытие без координатора), поэтому `closedAt` не меняется и событий нет.
   * `decision` — поле «Решение / что делать дальше» у approval ноды `human`: уходит координатору в `stage_started` следующего
   * этапа; у прогона старого формата решать нечего, и оно игнорируется.
   */
  acceptGlobalTask(id: string, decision?: string): GlobalTask {
    const run = this.mustRun(id)
    // Воркфлоу прогона: «Проверка» — approval ноды `human`; дальше граф двигает main по решению.
    if (run.workflowScope === 'run') {
      const text = decision?.trim()
      return this.resolveRunApproval(run, { action: 'accept', ...(text ? { text } : {}) })
    }
    if (this.globalKind(run) !== 'review') throw new Error(`глобальная задача ${id} не на проверке — подтвердить можно только из колонки «Проверка»`)
    this.setRunStatus(run, this.columnId('done'))
    run.updatedAt = Date.now()
    this.commit()
    return this.getGlobalTask(id)
  }

  /**
   * «Вернуть в работу» с проверки: уточнение человека сохраняется в `Run.returns`, прогон переоткрывается
   * (reopenRun гасит старые run_done — новый координатор не получит их сразу), карточка — в in_progress.
   * Координатора запускает main (store не знает о PTY): уточнение он получит в цели повторного запуска
   * (`resumeCoordinatorObjective`), поэтому отдельного события нет. У «Входящих» координатора нет — ошибка.
   */
  returnGlobalTask(id: string, text: string): GlobalTask {
    const run = this.mustRun(id)
    const clarification = text.trim()
    if (!clarification) throw new Error('напиши, что доделать: уточнение получит координатор')
    if (run.workflowScope === 'run') return this.resolveRunApproval(run, { action: 'reject', text: clarification })
    if (run.inbox) throw new Error('«Входящие» нельзя вернуть в работу: у них нет координатора')
    if (this.globalKind(run) !== 'review') throw new Error(`глобальная задача ${id} не на проверке — вернуть в работу можно только из колонки «Проверка»`)
    const at = Date.now()
    run.returns = [...(run.returns ?? []), { at, text: clarification }]
    this.reopenRun(run)
    this.setRunStatus(run, this.columnId('in_progress'))
    this.commit()
    return this.getGlobalTask(id)
  }

  /** «Подтвердить» / «Вернуть в работу» на карточке прогона с воркфлоу: решение по ждущему approval ноды `human`. */
  private resolveRunApproval(run: Run, resolution: RequestResolution): GlobalTask {
    const request = this.pendingRequest((r) => r.runId === run.id && r.taskId === undefined && r.kind === 'approval')
    if (!request) {
      throw new Error(`у глобальной задачи ${run.id} нет запроса на проверку — подтвердить или вернуть можно, когда воркфлоу дошёл до ноды «Человек»`)
    }
    this.resolveRequest(request.id, resolution)
    return this.getGlobalTask(run.id)
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
    for (const r of [...this.requests.values()]) if (r.runId === id || (r.taskId !== undefined && ids.has(r.taskId))) this.requests.delete(r.id)
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
   * Глобальная задача встаёт только в backlog / in_progress / review («Проверка») / done. В needs_input карточка попадает
   * сама, пока подзадачи ждут человека (toGlobalTask), — руками туда нельзя.
   */
  private assertGlobalColumn(status: string): void {
    this.assertColumn(status)
    if (this.columnKind(status) === 'needs_input') {
      throw new Error(`колонка «${status}» заполняется сама: там глобальные задачи, где подзадачи ждут ответа человека`)
    }
    if (!globalStoredColumns(this.columns()).some((c) => c.id === status)) {
      throw new Error(`колонка «${status}» — только для подзадач; глобальная задача: бэклог, в работе, проверка или сделано`)
    }
  }

  /**
   * Закрыть прогон вручную. Карточку из kind=in_progress (туда её ставит сама система) — в done: это явное
   * закрытие, а не результат работы, проверять нечего; ручную расстановку по другим колонкам не трогает.
   * run_done не шлёт.
   * Идемпотентно: повторный вызов closedAt не меняет.
   */
  closeRun(id: string): Run {
    const run = this.mustRun(id)
    if (run.closedAt === undefined) {
      run.closedAt = Date.now()
      run.runDoneAt = undefined
      if (run.status !== undefined && this.globalKind(run) === 'in_progress') this.setRunStatus(run, this.columnId('done'))
      run.updatedAt = run.closedAt
      this.commit()
    }
    return run
  }

  /**
   * Координатор закончил работу по прогону (`runs finish`) — только здесь (или при его смерти, `settleIdleRuns`)
   * прогон с подзадачами в done закрывается и карточка уходит на «Проверку». Для закрытого прогона — просто сигнал.
   * После run_done (`runDoneAt`) событие уже отправлено — прогон закрывается без нового.
   * Незакрытый прогон без run_done, в котором все подзадачи уже в kind=done, закрывается с run_done
   * (его координатору ждать уже не нужно): это повторный запуск координатора без новой работы (или новую
   * подзадачу удалили) — автозакрытие ждёт новой подзадачи в done и само не сработает. У свежего прогона
   * нужна хотя бы одна подзадача.
   * Иначе ошибка: до run_done координатору ещё есть что делать. Повторный вызов обновляет время.
   * `summary` — итоговая сводка координатора (markdown): непустая заменяет прежнюю `Run.summary`,
   * пустая или её нет — прежняя остаётся. При ошибке сводка не сохраняется.
   * Воркфлоу прогона (`workflowScope: 'run'`): закрывает граф, а не координатор, поэтому до `run_done` команда — ошибка;
   * после — просто сигнал «закончил» (`finishedAt`), как у старого координатора, привыкшего к `runs finish` после run_done.
   */
  finishRun(id: string, summary?: string): Run {
    const run = this.mustRun(id)
    if (run.workflowScope === 'run' && run.closedAt === undefined) {
      throw new Error(`runs finish: у глобальной задачи ${id} воркфлоу ведёт граф — этап «Работа» закрывает stage finish, а run_done придёт, когда граф дойдёт до конца`)
    }
    if (run.closedAt === undefined) {
      const tasks = [...this.tasks.values()].filter((t) => t.runId === run.id)
      const idle =
        run.runDoneAt !== undefined || (tasks.every((t) => this.isKind(t, 'done')) && (tasks.length > 0 || run.reopenedAt !== undefined))
      if (!idle) throw new Error(`run not closed: ${id} — дождись run_done`)
      const done = this.closeDone(run, this.reviewColumn(run), false, run.runDoneAt === undefined)
      if (done) done.consumedBy = 'runs finish'
    }
    run.finishedAt = Date.now()
    const text = summary?.trim()
    if (text) run.summary = { at: run.finishedAt, text }
    this.commit()
    return run
  }

  /**
   * Все подзадачи прогона дошли до kind=done. Координатору (если он был запущен) — событие run_done, но прогон
   * не закрывается и карточка остаётся «В работе» (`runDoneAt`): координатор ещё решает, нужны ли новые задачи.
   * Закрывают его `runs finish` (finishRun) или смерть координатора (settleIdleRuns). Без координатора
   * (глобальная задача, заведённая человеком) — сразу на «Проверку» с run_done, «Входящие» — в «Сделано».
   * Подзадача ушла из done после run_done — прогон снова открыт (reopenRun), следующий run_done придёт по её завершении.
   * Вызывается из commit(), поэтому ловит любую смену статуса и удаление задач.
   * Закрытый прогон повторно не закрывается и run_done не шлёт.
   */
  private closeFinishedRuns(): void {
    for (const run of this.runs.values()) {
      // Воркфлоу прогона закрывает граф (нода `end`), а конец этапа «Работа» — `stage_tasks_done` (syncStageTasks).
      if (run.closedAt !== undefined || run.workflowScope === 'run') continue
      const tasks = [...this.tasks.values()].filter((t) => t.runId === run.id)
      const allDone = tasks.length > 0 && tasks.every((t) => this.isKind(t, 'done'))
      if (run.runDoneAt !== undefined) {
        if (!allDone) this.reopenRun(run)
        continue
      }
      if (!allDone) continue
      // Переоткрытый прогон: ждём, пока хоть одна подзадача дойдёт до done после переоткрытия (setStatus снимет метку).
      if (run.reopenedAt !== undefined) continue
      if (run.inbox || run.coordinatorPtyId === undefined) {
        this.closeDone(run, this.reviewColumn(run))
        continue
      }
      run.runDoneAt = Date.now()
      run.updatedAt = run.runDoneAt
      this.pushEvent('run_done', { runId: run.id, objective: run.objective })
    }
  }

  /**
   * Координатор прогона после run_done (`runDoneAt`) больше не жив — вышел сам, упал, его терминал закрыли или
   * приложение перезапустили — и `runs finish` уже не пришлёт: прогон закрывается, карточка — на «Проверку»,
   * нового run_done нет. Живость PTY знает только main, он и вызывает (при выходе PTY координатора и
   * периодически). Возвращает id закрытых прогонов.
   */
  settleIdleRuns(isAlive: (ptyId: string) => boolean): string[] {
    const settled: string[] = []
    for (const run of this.runs.values()) {
      if (run.closedAt !== undefined || run.runDoneAt === undefined) continue
      if (run.coordinatorPtyId && isAlive(run.coordinatorPtyId)) continue
      this.closeDone(run, this.reviewColumn(run), false, false)
      settled.push(run.id)
    }
    if (settled.length > 0) this.commit()
    return settled
  }

  /**
   * Куда встаёт закрытая по итогам работы глобальная задача: на «Проверку» (kind=review) — результат
   * принимает человек. «Входящие» — сразу в done: это не работа координатора, проверять нечего.
   */
  private reviewColumn(run: Run): string {
    return this.columnId(run.inbox ? 'done' : 'review')
  }

  /**
   * Закрыть прогон как завершённый: карточка в колонку `status` и событие run_done (его и возвращает).
   * `manual` — карточку перенёс человек (подзадачи могут быть не закрыты), в событии `manual: true`.
   * `notify: false` — run_done уже отправлен раньше (`runDoneAt`), повторно не шлётся.
   * «Входящим» run_done не шлётся: у них нет координатора, событие некому забрать.
   */
  private closeDone(run: Run, status: string, manual = false, notify = true): OrcaEvent | undefined {
    run.closedAt = Date.now()
    run.reopenedAt = undefined
    run.runDoneAt = undefined
    this.setRunStatus(run, status)
    run.updatedAt = run.closedAt
    if (run.inbox || !notify) return undefined
    return this.pushEvent('run_done', { runId: run.id, objective: run.objective, ...(manual ? { manual: true } : {}) })
  }

  // ---------- dispatches ----------

  getDispatch(id: string): Dispatch | undefined {
    return this.dispatches.get(id)
  }

  /**
   * `launch` — снимок роли, агента, модели и id сессии агента на момент запуска (статистика: разбивки и поиск
   * транскрипта, docs/architecture.md → «Статистика»); без него dispatch статистика считает по задаче.
   */
  startDispatch(taskId: string, ptyId: string, dispatchId = newId('disp'), launch: DispatchLaunch = {}): Dispatch {
    const task = this.mustTask(taskId)
    const dispatch: Dispatch = { id: dispatchId, taskId, ptyId, startedAt: Date.now(), ...definedFields(launch) }
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
   * Этап «Работа» или «Вопрос человеку», на котором стоит задача (`wfWorkStage` по графу прогона): для раздела
   * «Этап» в промпте воркера и проверки показа в `finishDispatch`. Задача вне воркфлоу или на другом этапе —
   * undefined.
   */
  taskWorkStage(taskId: string, fallback: RunWorkflowFallback = {}): WfWorkStage | undefined {
    const task = this.mustTask(taskId)
    const nodeId = task.stage?.nodeId ?? task.stageOf?.nodeId
    if (nodeId === undefined) return undefined
    return wfWorkStage(this.runWorkflow(task.runId, fallback), nodeId)
  }

  /**
   * Нода графа прогона, на которой стоит задача (любого типа). Для сокета: граф прогона и запасной граф типа
   * известны вызывающему (`worker.ask` решает по типу ноды, кому адресовать вопрос). Задача вне воркфлоу — undefined.
   */
  taskStageNode(taskId: string, fallback: RunWorkflowFallback = {}): WfNode | undefined {
    const task = this.mustTask(taskId)
    const nodeId = task.stage?.nodeId ?? task.stageOf?.nodeId
    if (nodeId === undefined) return undefined
    return this.runWorkflow(task.runId, fallback).nodes.find((n) => n.id === nodeId)
  }

  /**
   * Явное завершение воркером через `orca-board done`. У задачи-ответа ответ обязателен и уходит
   * в событие worker_done вместе с `answerFor` — координатор решает по нему, принимать ли ответ сам.
   * Ответ для человека (`answerFor: 'human'`) — запрос answer к человеку (needs_input), остальное — в review.
   * Показ (`opts.showcase`) сохраняется в `Dispatch.showcase`; на «Работе» с обязательным показом без него — ошибка.
   */
  finishDispatch(dispatchId: string, summary: string, files: string[] = [], answer?: string, opts: FinishDispatchOptions = {}): Dispatch {
    const dispatch = this.mustDispatch(dispatchId)
    const task = this.mustTask(dispatch.taskId)
    const text = answer?.trim() ? answer : undefined
    if (task.answerFor && !text) {
      throw new Error('задача-ответ: передай ответ — orca-board done --summary "..." --answer-file <файл.md>')
    }
    if (text && text.length > MAX_ANSWER_LENGTH) {
      throw new Error(`ответ длиннее ${MAX_ANSWER_LENGTH} символов — сократи его`)
    }
    const showcase: DispatchShowcase | undefined = normalizeShowcase(opts.showcase)
    const stage = this.taskWorkStage(task.id, opts.fallback)
    if (!showcase && stage?.showcase?.required) {
      throw new Error(
        `этап «${stage.title}» требует показ человеку: ${stage.showcase.what}\n` +
        'Сдай его вместе с done: описание — --show-file <файл.md>, файлы из ветки — --show <путь> (флаг на каждый файл).'
      )
    }
    dispatch.endedAt = Date.now()
    dispatch.outcome = 'done'
    dispatch.summary = summary
    dispatch.files = files
    if (text) dispatch.answer = text
    if (showcase) dispatch.showcase = showcase
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
      // Проверка воркфлоу: координатору по ней делать нечего, исход уже у рабочей задачи.
      ...(task.gateFor ? { gateFor: task.gateFor.taskId ?? task.gateFor.runId } : {}),
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
   * Id сессии агента, найденный статистикой после запуска (codex не даёт задать его заранее): следующий расчёт
   * читает транскрипт сразу, без поиска по cwd и времени. Уже заданный id не меняется.
   */
  setDispatchSessionId(dispatchId: string, sessionId: string): void {
    const d = this.dispatches.get(dispatchId)
    if (!d || d.sessionId) return
    d.sessionId = sessionId
    this.commit()
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
    return this.updateTask(taskId, { status: this.columnId('done'), worktree: undefined, branch: undefined, branchForeign: undefined })
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

  /**
   * Решение по approval без commit: запрос закрыт, при «Вернуть» замечания — в feedback для следующего запуска.
   * Колонку не трогает, кроме выхода из «Нужен ответ» (settleTask): дальше задачу ведёт исполнитель воркфлоу.
   * Текст решения («вариант 2») — в `decision` события, последним и обрезанным: координатор учтёт выбор человека,
   * полный текст — `resolution.text` запроса (`orca-board request get`).
   */
  private applyApproval(task: Task | undefined, request: HumanRequest, action: 'accept' | 'reject', text?: string): void {
    this.closeRequest(request, 'resolved', { action, ...(text ? { text } : {}) })
    if (task) {
      if (action === 'reject' && text) task.feedback = text
      this.settleTask(task)
      task.updatedAt = Date.now()
    }
    // У approval прогона задачи нет: событие адресовано по `runId`, а замечания несёт `resolution.text`.
    this.pushEvent('request_resolved', {
      ...(task ? { taskId: task.id } : { runId: request.runId }), action, requestId: request.id, kind: request.kind, ...(request.nodeId ? { nodeId: request.nodeId } : {}),
      ...(text ? eventDecision(text) : {})
    })
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
   * ждёт координатора, задача в работе; иначе сразу запрос к человеку (needs_input). `forHuman` — этап
   * «Вопрос человеку»: вопрос идёт человеку при любом координаторе, а нода этапа записывается в
   * `Question.nodeId` и `HumanRequest.nodeId`.
   */
  ask(
    input: { taskId: string; dispatchId?: string; question: string; options?: readonly (string | RequestOption)[]; context?: string },
    opts: { coordinatorAlive?: boolean; forceHuman?: boolean } = {}
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
      ...(opts.forceHuman && task.stage ? { nodeId: task.stage.nodeId } : {}),
      createdAt: Date.now()
    }
    this.questions.set(q.id, q)
    const forHuman = opts.forceHuman === true || opts.coordinatorAlive !== true
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
    // workerLive: false и задача в ready — координатору сделать `worker start` (ответ будет в промпте); на этапе
    // «Вопрос человеку» воркера перезапускает приложение (handleEvents в main/workflow.ts).
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
      kind: 'question', title: q.question, ...(body ? { body } : {}), options: q.options, questionId: q.id, dispatchId: q.dispatchId,
      ...(q.nodeId ? { nodeId: q.nodeId } : {})
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
   * - escalation + dismiss → задача из «Нужен ответ» в ready (воркер мёртв), `request_resolved`;
   * - approval + accept / reject (`text` — комментарий, при reject — замечания в feedback) → запрос решён,
   *   `request_resolved`; переход воркфлоу по этому исходу делает main (`src/main/workflow.ts`).
   * Решённый или отменённый запрос — ошибка «уже решено».
   */
  resolveRequest(id: string, resolution: RequestResolution): HumanRequest {
    const request = this.requests.get(id)
    if (!request) throw new Error(`request not found: ${id}`)
    if (request.status !== 'pending') throw new Error(`уже решено: запрос ${id} ${request.status === 'cancelled' ? 'отменён' : 'решён'}`)
    if (!REQUEST_ACTIONS[request.kind].includes(resolution.action)) {
      throw new Error(`запрос ${request.kind}: действие ${resolution.action} недопустимо — ${REQUEST_ACTIONS[request.kind].join(', ')}`)
    }
    // У approval уровня прогона задачи нет: его решают по `runId`, остальным видам запросов задача обязательна.
    const task = request.taskId !== undefined ? this.mustTask(request.taskId) : undefined
    const text = resolution.text?.trim() || undefined
    if (!task && request.kind !== 'approval') throw new Error(`запрос ${id} (${request.kind}) без задачи — решить можно только approval прогона`)
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
        if (request.kind === 'approval') {
          this.applyApproval(task, request, 'accept', text)
          break
        }
        this.applyAccept(task!, request, text)
        task!.worktree = undefined
        task!.branch = undefined
        task!.branchForeign = undefined
        this.setStatus(task!, this.columnId('done'))
        this.promoteReady()
        break
      case 'clarify':
        this.applyClarify(task!, request, text ?? '')
        break
      case 'reject':
        this.applyApproval(task, request, 'reject', text)
        break
      case 'restart':
      case 'dismiss':
        this.closeRequest(request, 'resolved', { action: resolution.action, ...(text ? { text } : {}) })
        if (resolution.action === 'restart' && !this.isKind(task!, 'done')) this.setStatus(task!, this.columnId('ready'))
        else this.settleTask(task!)
        this.pushEvent('request_resolved', {
          taskId: task!.id, action: resolution.action, requestId: request.id, kind: request.kind, dispatchId: request.dispatchId
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
    subject: Task | Run,
    fields: Pick<HumanRequest, 'kind' | 'title'> & Partial<Pick<HumanRequest, 'body' | 'options' | 'questionId' | 'dispatchId' | 'nodeId' | 'showcaseDispatchId'>>,
    emit = true
  ): HumanRequest {
    // Запрос уровня прогона (approval ноды `human`) — без задачи: карточка «Нужен ответ» вычисляется по pending-запросам прогона.
    const task = 'objective' in subject ? undefined : subject
    const request: HumanRequest = {
      id: newId('req'),
      runId: task ? task.runId ?? '' : (subject as Run).id,
      ...(task ? { taskId: task.id } : {}),
      ...(fields.dispatchId !== undefined ? { dispatchId: fields.dispatchId } : {}),
      kind: fields.kind,
      status: 'pending',
      title: fields.title,
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      options: fields.options ?? [],
      ...(fields.questionId !== undefined ? { questionId: fields.questionId } : {}),
      ...(fields.nodeId !== undefined ? { nodeId: fields.nodeId } : {}),
      ...(fields.showcaseDispatchId !== undefined ? { showcaseDispatchId: fields.showcaseDispatchId } : {}),
      createdAt: Date.now()
    }
    this.requests.set(request.id, request)
    if (task && !this.isKind(task, 'done') && !this.isKind(task, 'needs_input')) this.setStatus(task, this.columnId('needs_input'))
    if (emit) this.requestCreated(request)
    return request
  }

  /** Событие request_created: короткое, полный текст — в запросе по requestId. */
  private requestCreated(r: HumanRequest): void {
    this.pushEvent('request_created', {
      ...(r.taskId !== undefined ? { taskId: r.taskId } : {}), requestId: r.id, kind: r.kind, title: short(r.title), runId: r.runId,
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
