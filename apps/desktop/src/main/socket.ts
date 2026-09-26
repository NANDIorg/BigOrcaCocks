import { createServer, type Socket, type Server } from 'node:net'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  EVENT_TYPES, TASK_PRIORITIES, describeWorkflow, resolveTaskType, wfNodeTitle, wfWorkRoleIds, withStatusSource, type TaskStore, type Workflow, type EventType, type AgentInfo, type Role, type BoardColumn, type OrcaEvent, type AnswerAudience,
  type TaskPriority,
  type RequestResolution, type Run, type WfAction, type RunWorkflowFallback, type Question, type GlobalTask, type ResolvedRunType, type RunTypeInput, type TaskType
} from '@orca-board/core'
import { ptyTail, isAlive } from './pty'
import { assertAgentUsable, missingRoleMessage, pickRole, type RoleSource } from './agents'
import { askOptions, resolutionFromParams } from './request-params'
import { runnableWorkflow } from './projects'

/**
 * Unix-сокет для CLI `orca-board`. Протокол: одна строка JSON-запроса,
 * одна строка JSON-ответа. `check --wait` и `ask` держат соединение до события.
 * `check --follow` — стрим: по строке `{id, ok, result: {event}}` на событие, пока клиент не закроет сокет.
 */
export interface ProjectDeps {
  store: TaskStore
  startWorker(taskId: string): { ptyId: string; dispatchId: string; worktree: string; branch: string }
  /**
   * Остановить воркеров задачи: dispatch'и закрываются как unknown без эскалации, PTY убиваются;
   * задача из in_progress — в ready. Возвращает id закрытых dispatch'ей.
   */
  stopWorker(taskId: string): { stopped: string[] }
  review(taskId: string): unknown
  /** `review accept`: на этапе проверки — исход accept по воркфлоу, иначе прежняя приёмка (src/main/workflow.ts). */
  accept(taskId: string, decision?: string): void
  /** `review reject`: на этапе проверки — исход reject по воркфлоу, иначе ready с замечаниями. */
  reject(taskId: string, feedback: string): unknown
  /**
   * `stage finish`: закрыть этап «Работа» прогона и выполнить эффекты следующей ноды (`finishRunStage` в workflow-run.ts).
   * Только через него: store делает лишь переход, а проверку, запрос человеку, мерж и конец создаёт движок прогона.
   */
  finishStage(runId: string, summary?: string): { run: Run; action: WfAction }
  /** Решение запроса к человеку (review.ts resolveHumanRequest): accept с git-частью, clarify/restart со стартом воркера. */
  resolveRequest(id: string, resolution: RequestResolution): unknown
  /**
   * Без runId — новый прогон (глобальная задача) типа `typeId` (нет — типа проекта по умолчанию; недоступный
   * проекту — ошибка); с runId — повторный запуск на существующей.
   */
  startCoordinator(objective: string, runId?: string, typeId?: string): string
  /** Удалить глобальную задачу: живой координатор — ошибка, терминалы подзадач закрываются. */
  deleteGlobalTask(runId: string, cascade: boolean): { deleted: string; tasks: string[] }
  /** Агенты реестра с признаками «установлен»/«включён» для этого проекта. */
  agents(): AgentInfo[]
  /** Тип прогона целиком (`resolveRunType`): роли, правила, разрешения, граф и откуда он взят. */
  resolveRun(runId?: string): ResolvedRunType
  /** Типы задач, доступные проекту, и тип проекта по умолчанию — для `types list`. */
  taskTypes(): { taskTypes: TaskType[]; defaultTypeId: string }
  /** Тип нового прогона для store (`createGlobalTask`): без `typeId` — тип по умолчанию, недоступный — ошибка. */
  runType(typeId?: string): RunTypeInput
  /** `rules set` по типу: правила агентов (`roleId` нет) или системный промпт роли. */
  saveTaskTypeRules(typeId: string, roleId: string | undefined, text: string): TaskType
  /** Колонки доски в порядке показа. */
  columns(): BoardColumn[]
  /** Граф типа `typeId` (нет — типа проекта по умолчанию); `custom: false` — дефолтный по ролям типа. */
  workflow(typeId?: string): { typeId: string; title: string; workflow: Workflow; custom: boolean }
}

/** Проект в ответе `projects list`: то, что нужно ассистенту, чтобы выбрать `--project`. */
export interface ProjectSummary {
  id: string
  name: string
  root: string
  /** Активный проект приложения — его берут команды без --project и ORCA_PROJECT. */
  active: boolean
  /** Задач в колонке kind in_progress. */
  inProgress: number
  /** Тип задач проекта по умолчанию: глобальные задачи без `--type`, «Входящие». */
  defaultTypeId: string
  defaultTypeTitle: string
}

export interface SocketDeps {
  /** Проект из запроса (ORCA_PROJECT у агента) или активный. */
  resolve(projectId?: string): ProjectDeps
  /** Все проекты пользователя; пустой массив, если проектов нет. */
  projects(): ProjectSummary[]
}

interface Request {
  id?: string
  method: string
  params: Record<string, unknown>
  dispatchId?: string
  taskId?: string
  projectId?: string
}

/** Канал ответа для стриминговых команд: пишет строки `{id, ok: true, result}` в сокет и сообщает о его закрытии. */
interface Stream {
  /** Вызвать fn, когда клиент закроет соединение (сразу — если уже закрыто). */
  onClose(fn: () => void): void
  /** Соединение ещё открыто — в него можно писать. */
  open(): boolean
  /**
   * Отправить строку и узнать, ушла ли она: `false` — сокет закрыт или запись упала.
   * Для событий координатору: недоставленное возвращается в непрочитанные.
   */
  send(result: unknown): Promise<boolean>
}

/**
 * Вопросы, чей `orca-board ask` ещё держит соединение: ответ дойдёт воркеру через сокет.
 * Соединение оборвалось (таймаут инструмента агента) или `--no-wait` — ответ надо вписать в терминал.
 */
const askWaiters = new Map<string, number>()

/** Ответ на вопрос дойдёт до воркера через его `ask` (соединение ещё открыто). */
export function askWaiting(questionId: string): boolean {
  return (askWaiters.get(questionId) ?? 0) > 0
}

/** Хендлер вернул STREAM — финального ответа не будет, он сам пишет через stream.send. */
const STREAM = Symbol('stream')

type Handler = (
  req: Request,
  deps: ProjectDeps,
  store: TaskStore,
  stream: Stream
) => Promise<unknown> | unknown

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}
function num(v: unknown, def: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

/** Показ из `done` (CLI шлёт `{text?, files}`): чужая форма — ошибка, а не молча пропавший показ. */
function showcaseParam(v: unknown): { showcase?: { text?: string; files: string[] } } {
  if (v === undefined) return {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('showcase: нужен объект {text?, files}')
  const o = v as Record<string, unknown>
  if (o.text !== undefined && typeof o.text !== 'string') throw new Error('showcase.text должен быть строкой')
  return { showcase: { ...(typeof o.text === 'string' ? { text: o.text } : {}), files: list(o.files) } }
}

/** Запасной граф store (`RunWorkflowFallback`) по типу прогона: граф будущей версии не исполняется. */
function runFallback(t: ResolvedRunType): RunWorkflowFallback {
  const workflow = runnableWorkflow(t.workflow)
  return { roleIds: t.roles.map((r) => r.id), ...(workflow ? { workflow } : {}) }
}

/** Координатор прогона задачи жив (PTY в реестре) и не закончил работу — вопрос адресуется ему. */
export function coordinatorAlive(store: TaskStore, taskId: string): boolean {
  const runId = store.getTask(taskId)?.runId
  const run = runId ? store.getRun(runId) : undefined
  return Boolean(run?.coordinatorPtyId && !run.finishedAt && !run.closedAt && isAlive(run.coordinatorPtyId))
}

/**
 * Карточка глобальной задачи + живость её координатора. coordinatorPtyId в store остаётся и после выхода
 * PTY, а живость знает только реестр PTY — поэтому поле вычисляется при ответе и в store не хранится.
 */
export function withCoordinatorAlive(g: GlobalTask): GlobalTask & { coordinatorAlive: boolean } {
  return { ...g, coordinatorAlive: Boolean(g.coordinatorPtyId && isAlive(g.coordinatorPtyId)) }
}

/**
 * Живость воркера — из реестра PTY: dispatch без endedAt, чей PTY уже мёртв (выход не дошёл до store),
 * закрывается до ответа, иначе store сочтёт воркера живым и не вернёт задачу в ready.
 */
export function syncWorkerLiveness(store: TaskStore, taskId: string): void {
  const active = store.activeDispatches().filter((d) => d.taskId === taskId)
  if (active.length > 0 && active.every((d) => !isAlive(d.ptyId))) store.closeDispatches(taskId)
}

/** Ответ на вопрос с учётом живости воркера. */
export function answerQuestion(store: TaskStore, questionId: string, answer: string): Question {
  const q = store.getQuestion(questionId)
  if (q) syncWorkerLiveness(store, q.taskId)
  return store.answer(questionId, answer)
}

/** Роль задачи есть в типе её прогона и её агент можно запускать. */
function assertRoleUsable(type: RoleSource, agents: AgentInfo[], roleId: string): void {
  const role = type.roles.find((r) => r.id === roleId)
  if (!role) throw new Error(`воркер не запустится: ${missingRoleMessage(roleId, type)}`)
  assertAgentUsable(agents, role.agent)
}

/** Подзадача: общая часть task.create и global.add-task. Без runId store кладёт её во «Входящие». */
function createTask(r: Request, deps: ProjectDeps, store: TaskStore, runId: string | undefined): unknown {
  const title = str(r.params.title)
  if (!title) throw new Error('--title обязателен')
  if (r.params.agent !== undefined) throw new Error('--agent больше не поддерживается, укажи --role (orca-board roles list)')
  // Воркфлоу прогона: подзадачи — только на этапе «Работа». Проверка идёт раньше выбора роли, иначе вне этапа
  // координатор увидел бы «--role обязателен», а не «дождись stage_started».
  const stage = runId !== undefined ? store.assertStageAcceptsTasks(runId) : undefined
  const stageRoles = stage ? wfWorkRoleIds(stage) : []
  if (stage && stageRoles.length > 1 && str(r.params.role) === undefined) {
    throw new Error(`--role обязателен: этап «${wfNodeTitle(stage)}» ведут роли ${stageRoles.join(', ')}`)
  }
  // Роли — типа глобальной задачи; у «Входящих» (runId нет) — типа проекта по умолчанию.
  // Без --role на этапе «Работа» с единственной ролью берётся она (`stageDefaultRole`).
  const role = pickRole(deps.resolveRun(runId), deps.agents(), str(r.params.role) ?? (runId !== undefined ? store.stageDefaultRole(runId) : undefined))
  // --answer-for human|coordinator — задача-ответ; значение проверяет store.
  const answerFor = r.params['answer-for'] ?? r.params.answerFor
  if (answerFor === true) throw new Error('--answer-for требует значения: human или coordinator')
  const priority = priorityParam(r)
  return store.createTask({
    title,
    spec: str(r.params.spec),
    deps: list(r.params.dep ?? r.params.deps),
    roleId: role.id,
    agent: role.agent,
    runId,
    ...(answerFor !== undefined ? { answerFor: answerFor as AnswerAudience } : {}),
    ...(priority !== undefined ? { priority: priority as TaskPriority } : {})
  })
}

/** --type: id типа задачи; флаг без значения — ошибка, нет флага — undefined. */
function typeParam(r: Request): string | undefined {
  if (r.params.type === true || r.params.type === '') throw new Error('--type требует id типа задачи (orca-board types list)')
  return str(r.params.type)
}

/**
 * Тип для `rules.*` и `roles.list`: `--type` (из доступных проекту), иначе тип прогона `--run` (координатору CLI
 * подставляет ORCA_RUN_ID), иначе тип проекта по умолчанию.
 */
function typeOf(r: Request, deps: ProjectDeps, store: TaskStore): ResolvedRunType {
  const typeId = typeParam(r)
  if (typeId === undefined) {
    const runId = str(r.params.run)
    if (runId !== undefined && !store.getRun(runId)) throw new Error(`run not found: ${runId}`)
    return deps.resolveRun(runId)
  }
  const type = deps.taskTypes().taskTypes.find((t) => t.id === typeId)
  if (!type) throw new Error(`тип задачи «${typeId}» недоступен в проекте (доступные: orca-board types list)`)
  return { ...resolveTaskType(type), source: 'type' }
}

/** Роль типа по --role для `rules.*`; нет такой — ошибка со списком ролей типа. */
function ruleRole(r: Request, type: ResolvedRunType): Role | undefined {
  const roleId = str(r.params.role)
  if (r.params.role === true || roleId === '') throw new Error('--role требует id роли')
  if (roleId === undefined) return undefined
  const role = type.roles.find((x) => x.id === roleId)
  if (!role) throw new Error(missingRoleMessage(roleId, type))
  return role
}

/** Тип в ответе `types list`: роли с признаком «агент включён» и этапы графа кратко. */
function typeSummary(t: TaskType, defaultTypeId: string, enabled: Set<string>): unknown {
  const resolved = resolveTaskType(t)
  return {
    id: t.id,
    title: t.title,
    ...(t.description ? { description: t.description } : {}),
    ...(t.id === defaultTypeId ? { default: true } : {}),
    permissionMode: resolved.permissionMode,
    roles: resolved.roles.map((role) => ({
      id: role.id,
      title: role.title,
      agent: role.agent,
      ...(role.model ? { model: role.model } : {}),
      agentEnabled: enabled.has(role.agent)
    })),
    stages: describeWorkflow(resolved.workflow).map((s) => ({ id: s.id, type: s.type, title: s.title, ...(s.roleId ? { roleId: s.roleId } : {}), ...(s.roleIds ? { roleIds: s.roleIds } : {}) }))
  }
}

/** --priority: значение проверяет store; флаг без значения (true) — отдельная понятная ошибка. */
function priorityParam(r: Request): string | undefined {
  if (r.params.priority === true) throw new Error(`--priority требует значения: ${TASK_PRIORITIES.join(', ')}`)
  return str(r.params.priority)
}

/** Id глобальной задачи (= id прогона) из --global; CLI подставляет $ORCA_RUN_ID для global get/tasks/add-task. */
function globalId(r: Request): string {
  const id = str(r.params.global)
  if (!id) throw new Error('--global обязателен (id глобальной задачи из global list)')
  return id
}

const handlers: Record<string, Handler> = {
  'task.list': (r, _d, store) => {
    // --run — только подзадачи этой глобальной задачи; без него — все задачи проекта, как раньше.
    const run = str(r.params.run)
    return run ? store.listSubtasks(run) : store.listTasks()
  },
  'task.get': (r, _d, store) => store.getTask(str(r.params.task) ?? '') ?? null,
  // Полный ответ задачи-ответа и decision: в событиях answer обрезан (answerTruncated).
  'task.answer': (r, _d, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    return store.taskAnswer(id)
  },
  // CLI подставляет ORCA_RUN_ID в params.run; сервер env не читает.
  'task.create': (r, deps, store) => createTask(r, deps, store, str(r.params.run)),
  'global.list': (_r, _d, store) => store.listGlobalTasks().map(withCoordinatorAlive),
  'global.get': (r, _d, store) => withCoordinatorAlive(store.getGlobalTask(globalId(r))),
  'global.create': (r, deps, store) =>
    store.createGlobalTask({
      title: str(r.params.title),
      description: str(r.params.description),
      status: str(r.params.status),
      priority: priorityParam(r) as TaskPriority | undefined,
      // Тип (--type, иначе тип проекта по умолчанию): id, снимок ролей и графа. Недоступный проекту — ошибка.
      type: deps.runType(typeParam(r))
    }),
  'global.update': (r, _d, store) =>
    store.updateGlobalTask(globalId(r), {
      title: str(r.params.title),
      description: str(r.params.description),
      priority: priorityParam(r) as TaskPriority | undefined
    }),
  'global.move': (r, _d, store) => {
    const status = str(r.params.status)
    if (!status) throw new Error('--status обязателен (id колонки из columns list)')
    return store.moveGlobalTask(globalId(r), status)
  },
  'global.delete': (r, deps) => deps.deleteGlobalTask(globalId(r), r.params.cascade === true),
  'global.tasks': (r, _d, store) => store.listSubtasks(globalId(r)),
  'global.add-task': (r, deps, store) => createTask(r, deps, store, globalId(r)),
  'global.start': (r, deps) => ({ ptyId: deps.startCoordinator('', globalId(r)) }),
  'task.move': (r, _d, store) => {
    const id = str(r.params.task)
    const status = str(r.params.status)
    if (!id || !status) throw new Error('--task и --status обязательны')
    // Неизвестную колонку отвергает store.moveTask.
    return store.moveTask(id, status)
  },
  'task.update': (r, _d, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    const title = str(r.params.title)
    const spec = str(r.params.spec)
    const priority = priorityParam(r)
    if (title === undefined && spec === undefined && priority === undefined) throw new Error('укажи --title, --spec и/или --priority')
    // Название/описание задачи в работе store отвергает, приоритет меняется в любой колонке.
    return store.editTask(id, { title, spec, priority: priority as TaskPriority | undefined })
  },
  'task.delete': (r, _d, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    store.deleteTask(id)
    return { deleted: id }
  },
  'worker.start': (r, deps, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    // Роль могли удалить, а её агента — выключить в проекте после создания задачи.
    const task = store.getTask(id)
    if (task) assertRoleUsable(deps.resolveRun(task.runId), deps.agents(), task.roleId)
    return deps.startWorker(id)
  },
  'worker.stop': (r, deps, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    if (!store.getTask(id)) throw new Error(`task not found: ${id}`)
    return { ...deps.stopWorker(id), task: store.getTask(id) }
  },
  // stop + (feedback) + start: работает и на задаче в работе, где worker start падает.
  'worker.restart': (r, deps, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    if (r.params.feedback === true) throw new Error('--feedback требует текста')
    const task = store.getTask(id)
    if (!task) throw new Error(`task not found: ${id}`)
    // Готовую задачу restart не переоткрывает: воркер стартовал бы на ней в обход reopen (feedback, колонка).
    const kind = store.columnKind(task.status)
    if (kind === 'done' || kind === 'review') {
      throw new Error(`задача ${id} уже ${kind === 'done' ? 'сделана' : 'на ревью'}: используй task reopen --task ${id} [--feedback "..."] --start`)
    }
    // Проверяем роль до остановки: иначе остановили бы воркера и не смогли поднять новый.
    assertRoleUsable(deps.resolveRun(task.runId), deps.agents(), task.roleId)
    const { stopped } = deps.stopWorker(id)
    const feedback = str(r.params.feedback)?.trim()
    if (feedback) store.updateTask(id, { feedback })
    return { stopped, ...deps.startWorker(id) }
  },
  // Переоткрыть задачу в ready (feedback — по желанию); --start — сразу запустить воркера.
  'task.reopen': (r, deps, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    if (r.params.feedback === true) throw new Error('--feedback требует текста')
    const existing = store.getTask(id)
    if (r.params.start === true && existing) assertRoleUsable(deps.resolveRun(existing.runId), deps.agents(), existing.roleId)
    const task = store.reopenTask(id, str(r.params.feedback))
    if (r.params.start !== true) return task
    return { task, worker: deps.startWorker(id) }
  },
  'coordinator.start': (r, deps) => {
    // --global — повторный запуск на существующей глобальной задаче (цель — её описание).
    const run = str(r.params.global)
    const typeId = typeParam(r)
    if (run) {
      if (typeId !== undefined) throw new Error('--type задаётся только новой глобальной задаче: у существующей тип уже выбран')
      return { ptyId: deps.startCoordinator('', run) }
    }
    const objective = str(r.params.objective)
    if (!objective) throw new Error('--objective обязателен')
    return { ptyId: deps.startCoordinator(objective, undefined, typeId) }
  },
  'worker.read': (r, _d, store) => {
    const id = str(r.params.dispatch)
    if (!id) throw new Error('--dispatch обязателен')
    const d = store.getDispatch(id)
    if (!d) throw new Error(`dispatch not found: ${id}`)
    return { ...d, alive: isAlive(d.ptyId), tail: ptyTail(d.ptyId, num(r.params.limit, 80)) }
  },
  'worker.done': (r, deps, store) => {
    const id = str(r.params.dispatch) ?? r.dispatchId
    if (!id) throw new Error('нет dispatch: укажи --dispatch или запусти из воркера (ORCA_DISPATCH_ID)')
    // CLI читает --answer-file и --show-file сам и присылает текст в answer и showcase.text.
    const dispatch = store.getDispatch(id)
    const task = dispatch ? store.getTask(dispatch.taskId) : undefined
    return store.finishDispatch(id, str(r.params.summary) ?? '', list(r.params.files), str(r.params.answer), {
      ...showcaseParam(r.params.showcase),
      // Граф прогона без снимка — по типу прогона, как у исполнителя воркфлоу (workflowDeps в index.ts).
      ...(task ? { fallback: runFallback(deps.resolveRun(task.runId)) } : {})
    })
  },
  'worker.ask': async (r, deps, store, stream) => {
    const dispatchId = str(r.params.dispatch) ?? r.dispatchId
    const taskId = str(r.params.task) ?? r.taskId ?? (dispatchId ? store.getDispatch(dispatchId)?.taskId : undefined)
    if (!taskId) throw new Error('нет задачи: укажи --task или запусти из воркера')
    const question = str(r.params.question)
    if (!question) throw new Error('--question обязателен')
    // Переподключение: инструмент оборвал ask по таймауту, воркер спросил то же самое, а ответ уже есть —
    // отдаём его сразу, а не заводим новый вопрос. Открытый вопрос того же запуска store.ask вернёт сам.
    const answered = store
      .snapshot()
      .questions.filter((q) => q.taskId === taskId && q.dispatchId === dispatchId && q.answeredAt && q.question === question.trim())
      .at(-1)
    if (answered && dispatchId !== undefined) return answered
    // Этап «Вопрос человеку»: отвечает человек, а не координатор — вопрос идёт человеку при любом координаторе.
    // Граф прогона без снимка — по типу прогона, как в `worker.done`.
    const task = store.getTask(taskId)
    const onAskStage = task ? store.taskStageNode(taskId, runFallback(deps.resolveRun(task.runId)))?.type === 'ask' : false
    const q = store.ask(
      { taskId, dispatchId, question, options: askOptions(r.params), context: str(r.params.context) },
      { coordinatorAlive: coordinatorAlive(store, taskId), ...(onAskStage ? { forceHuman: true } : {}) }
    )
    if (r.params.wait === false || q.answeredAt) return q
    askWaiters.set(q.id, (askWaiters.get(q.id) ?? 0) + 1)
    return new Promise((resolve) => {
      const off = store.subscribe(() => {
        const cur = store.getQuestion(q.id)
        if (cur?.answeredAt) {
          off()
          resolve(cur)
        }
      })
      // Снимаем отметку только при закрытии соединения: слушатель событий в main проверяет её
      // синхронно в том же commit, что и ответ, — сокет к этому моменту ещё открыт.
      stream.onClose(() => {
        off()
        const n = (askWaiters.get(q.id) ?? 1) - 1
        if (n > 0) askWaiters.set(q.id, n)
        else askWaiters.delete(q.id)
      })
    })
  },
  'question.answer': (r, _d, store) => {
    const id = str(r.params.question)
    const answer = str(r.params.answer)
    if (!id || answer === undefined) throw new Error('--question и --answer обязательны')
    return answerQuestion(store, id, answer)
  },
  'question.list': (_r, _d, store) => store.openQuestions(),
  // Вопрос целиком (и ответ): так воркер забирает ответ по пинку в терминал.
  'question.get': (r, _d, store) => {
    const id = str(r.params.question)
    if (!id) throw new Error('--question обязателен')
    const q = store.getQuestion(id)
    if (!q) throw new Error(`question not found: ${id}`)
    return q
  },
  'question.forward': (r, _d, store) => {
    const id = str(r.params.question)
    if (!id) throw new Error('--question обязателен')
    if (r.params.note === true) throw new Error('--note требует текста')
    return store.forwardQuestion(id, str(r.params.note))
  },
  // Запросы к человеку: по умолчанию ждущие (pending); --all — все; --run — одного прогона.
  'request.list': (r, _d, store) => {
    const run = str(r.params.run)
    return r.params.all === true
      ? store.listRequests().filter((q) => run === undefined || q.runId === run)
      : store.pendingRequests(run)
  },
  // Полный текст запроса; у вопроса — ещё и ответ на него (воркер забирает ответ этой командой).
  'request.get': (r, _d, store) => {
    const id = str(r.params.request)
    if (!id) throw new Error('--request обязателен')
    const req = store.getRequest(id)
    if (!req) throw new Error(`request not found: ${id}`)
    const q = req.questionId ? store.getQuestion(req.questionId) : undefined
    return { ...req, ...(q?.answer !== undefined ? { answer: q.answer } : {}) }
  },
  'request.resolve': (r, deps, store) => {
    const id = str(r.params.request)
    if (!id) throw new Error('--request обязателен')
    const req = store.getRequest(id)
    if (!req) throw new Error(`request not found: ${id}`)
    return deps.resolveRequest(id, resolutionFromParams(req, r.params))
  },
  'review.info': (r, deps) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    return deps.review(id)
  },
  'review.accept': (r, deps, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    deps.accept(id, str(r.params.decision))
    return store.getTask(id)
  },
  'review.reject': (r, deps) => {
    const id = str(r.params.task)
    const feedback = str(r.params.feedback)
    if (!id || !feedback) throw new Error('--task и --feedback обязательны')
    return deps.reject(id, feedback)
  },
  // Граф этапов задачи: с --run (координатору CLI подставляет ORCA_RUN_ID) — снимок прогона, по нему идут его
  // задачи (прогон без снимка — граф его типа, `source: type`); без --run — граф типа --type или типа проекта
  // по умолчанию, с которым начнутся новые глобальные задачи.
  'workflow.show': (r, deps, store) => {
    const runId = str(r.params.run)
    const typeId = typeParam(r)
    if (runId !== undefined && typeId === undefined) {
      const run = store.getRun(runId)
      if (!run) throw new Error(`run not found: ${runId}`)
      const type = deps.resolveRun(runId)
      const fallback = { roleIds: type.roles.map((x) => x.id), workflow: type.workflow }
      const wf = store.runWorkflow(runId, fallback)
      // Воркфлоу глобальной задачи (`scope: 'run'`): граф ведёт её саму, `stage` — где она сейчас (нода, заход, роли,
      // инструкции, подзадачи захода). Старый формат (`scope: 'task'`) идёт по подзадачам, позиции у прогона нет.
      const stage = store.runStage(runId, fallback)
      return {
        source: run.workflow ? 'run' : 'type',
        scope: run.workflowScope === 'run' ? 'run' : 'task',
        run: runId,
        typeId: type.typeId,
        typeTitle: type.title,
        ...(stage ? { stage } : {}),
        stages: describeWorkflow(wf)
      }
    }
    const { typeId: id, title, workflow, custom } = deps.workflow(typeId)
    return { source: 'type', typeId: id, typeTitle: title, custom, stages: describeWorkflow(workflow) }
  },
  'events.list': (_r, _d, store) => store.listEvents(),
  'agents.list': (_r, deps) => deps.agents(),
  // Роли типа глобальной задачи (--run, координатору — его прогон) с признаком, включён ли их агент в проекте:
  // координатору видно, какие роли можно назначать. Без прогона — типа --type или типа проекта по умолчанию.
  'roles.list': (r, deps, store) => {
    const enabled = new Set(deps.agents().filter((a) => a.enabled).map((a) => a.id))
    return typeOf(r, deps, store).roles.map((role) => ({ ...role, agentEnabled: enabled.has(role.agent) }))
  },
  // Типы задач, доступные проекту: глобальная задача получает тип при создании (global create --type).
  'types.list': (_r, deps) => {
    const enabled = new Set(deps.agents().filter((a) => a.enabled).map((a) => a.id))
    const { taskTypes, defaultTypeId } = deps.taskTypes()
    return taskTypes.map((t) => typeSummary(t, defaultTypeId, enabled))
  },
  'columns.list': (_r, deps) => deps.columns(),
  // Правила агентов доски — типа задачи (typeOf): общие — agentRules типа, роли — её systemPrompt (оба уходят в
  // системный промпт, withAgentRules).
  'rules.get': (r, deps, store) => {
    const type = typeOf(r, deps, store)
    const role = ruleRole(r, type)
    const of = { typeId: type.typeId, typeTitle: type.title }
    if (!role) return { ...of, rules: type.agentRules }
    return { ...of, role: role.id, title: role.title, rules: role.systemPrompt ?? '' }
  },
  'rules.set': (r, deps, store) => {
    const text = r.params.text
    if (typeof text !== 'string') throw new Error('нужен текст правил: --text "..." или --file <путь> (пустая строка — очистить)')
    const type = typeOf(r, deps, store)
    const role = ruleRole(r, type)
    // Тип прогона удалили из библиотеки — прогон идёт по снимку, править нечего.
    if (type.source === 'snapshot') throw new Error(`тип «${type.title}» удалён из библиотеки: прогон идёт по его снимку, правила не изменить`)
    const saved = resolveTaskType(deps.saveTaskTypeRules(type.typeId, role?.id, text))
    const of = { typeId: saved.typeId, typeTitle: saved.title }
    if (!role) return { ...of, rules: saved.agentRules }
    const next = saved.roles.find((x) => x.id === role.id)
    return { ...of, role: role.id, title: next?.title ?? role.title, rules: next?.systemPrompt ?? '' }
  },
  // Прогоны с числом задач и числом задач в kind=done.
  'runs.list': (_r, _d, store) => {
    const tasks = store.listTasks()
    return store.listRuns().map((run) => {
      const own = tasks.filter((t) => t.runId === run.id)
      return { ...run, tasks: own.length, done: own.filter((t) => store.columnKind(t.status) === 'done').length }
    })
  },
  'runs.close': (r, _d, store) => {
    const id = str(r.params.run)
    if (!id) throw new Error('--run обязателен')
    return store.closeRun(id)
  },
  // Координатор набрал агентов на этапе «Работа» и закрывает его: граф идёт дальше исходом next. Переход делает
  // store (`finishStage`), эффекты новой ноды — проверка, запрос человеку, мерж — движок прогона: сокет зовёт его
  // `finishStage` из deps, а не store напрямую (`stage_changed` эффектов не запускает).
  'stage.finish': (r, deps, store) => {
    const id = str(r.params.run)
    if (!id) throw new Error('--run обязателен')
    if (r.params.summary === true) throw new Error('--summary требует текста сводки')
    const from = store.getRun(id)?.stage?.nodeId
    const { run, action } = deps.finishStage(id, str(r.params.summary))
    return {
      run: id,
      finished: from,
      stage: run.stage ? { nodeId: run.stage.nodeId, visits: run.stage.visits[run.stage.nodeId] ?? 1 } : undefined,
      // Что приложение делает дальше: координатору важно лишь, ждать ли ему следующий stage_started или run_done.
      next: { type: action.type, nodeId: action.nodeId, ...(action.type === 'blocked' ? { reason: action.reason } : {}) }
    }
  },
  'runs.finish': (r, _d, store) => {
    const id = str(r.params.run)
    if (!id) throw new Error('--run обязателен')
    return store.finishRun(id, str(r.params.summary))
  },
  check: async (r, _d, store, stream) => {
    const types = (list(r.params.types).length ? list(r.params.types) : EVENT_TYPES) as EventType[]
    // Прогон координатора: его события и отдельный consumer, чтобы прогоны не забирали чужое.
    const run = str(r.params.run)
    const consumer = str(r.params.consumer) ?? run ?? 'coordinator'
    // Забираем события, только пока соединение открыто: иначе они помечены прочитанными, но не доставлены.
    const consume = (): OrcaEvent[] => (stream.open() ? store.consumeEvents(types, consumer, run) : [])

    if (r.params.follow === true) {
      const deliver = (): void => {
        for (const event of consume()) {
          void stream.send({ event }).then((ok) => {
            if (!ok) store.releaseEvents([event.id])
          })
        }
      }
      deliver()
      const off = store.subscribe(deliver)
      stream.onClose(off)
      return STREAM
    }

    const wait = Boolean(r.params.wait)
    const timeoutMs = num(r.params['timeout-ms'] ?? r.params.timeoutMs, 900_000)

    const reply = async (events: OrcaEvent[], timedOut: boolean): Promise<typeof STREAM> => {
      const ok = await stream.send({ events, timedOut })
      if (!ok && events.length) store.releaseEvents(events.map((e) => e.id))
      return STREAM
    }

    const now = consume()
    if (now.length || !wait) return reply(now, false)

    return new Promise((resolve) => {
      let done = false
      const finish = (events: OrcaEvent[] | null, timedOut: boolean): void => {
        if (done) return
        done = true
        off()
        clearTimeout(timer)
        // Клиент ушёл, пока ждали: ничего не забирали — отвечать некому.
        if (events === null) resolve(STREAM)
        else resolve(reply(events, timedOut))
      }
      const off = store.subscribe(() => {
        const hit = consume()
        if (hit.length) finish(hit, false)
      })
      const timer = setTimeout(() => finish([], true), timeoutMs)
      stream.onClose(() => finish(null, false))
    })
  }
}

/**
 * Команды уровня приложения: выполняются до resolve(projectId), поэтому работают без проектов
 * и не падают на ORCA_PROJECT удалённого или чужого проекта.
 */
const appHandlers: Record<string, (req: Request, deps: SocketDeps) => unknown> = {
  'projects.list': (_r, deps) => deps.projects()
}

export function startSocketServer(path: string, socketDeps: SocketDeps): Server {
  async function handle(line: string, sock: Socket): Promise<void> {
    let req: Request
    try {
      req = JSON.parse(line) as Request
    } catch {
      sock.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n')
      return
    }
    const handler = handlers[req.method]
    const appHandler = appHandlers[req.method]
    const open = (): boolean => !sock.destroyed && sock.writable
    const stream: Stream = {
      onClose: (fn) => {
        if (sock.destroyed) fn()
        else sock.once('close', fn)
      },
      open,
      send: (result) =>
        new Promise((resolve) => {
          if (!open()) return resolve(false)
          try {
            sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n', (err) => resolve(!err))
          } catch {
            resolve(false)
          }
        })
    }
    try {
      if (appHandler) {
        const result = await appHandler({ ...req, params: req.params ?? {} }, socketDeps)
        sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n')
        return
      }
      if (!handler) throw new Error(`неизвестная команда: ${req.method}`)
      const deps = socketDeps.resolve(req.projectId || undefined)
      // Источник для истории статусов: команда воркера (есть ORCA_DISPATCH_ID) или прочий CLI — координатор, человек.
      const source = req.dispatchId ? 'worker' : 'cli'
      const result = await withStatusSource(source, () => handler({ ...req, params: req.params ?? {} }, deps, deps.store, stream))
      if (result === STREAM) return
      sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n')
    } catch (e) {
      sock.write(JSON.stringify({ id: req.id, ok: false, error: (e as Error).message }) + '\n')
    }
  }

  const server = createServer((sock: Socket) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) void handle(line, sock)
      }
    })
    sock.on('error', () => undefined)
  })

  // Именованный канал Windows не лежит в ФС: каталог и удаление старого файла не нужны.
  if (process.platform !== 'win32') {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) unlinkSync(path)
  }
  server.listen(path)
  return server
}
