import { createServer, type Socket, type Server } from 'node:net'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  EVENT_TYPES, type TaskStore, type EventType, type AgentInfo, type Role, type BoardColumn, type OrcaEvent, type AnswerAudience,
  type RequestResolution, type Question
} from '@orca-board/core'
import { ptyTail, isAlive } from './pty'
import { assertAgentUsable, pickRole } from './agents'
import { askOptions, resolutionFromParams } from './request-params'

/**
 * Unix-сокет для CLI `orca-board`. Протокол: одна строка JSON-запроса,
 * одна строка JSON-ответа. `check --wait` и `ask` держат соединение до события.
 * `check --follow` — стрим: по строке `{id, ok, result: {event}}` на событие, пока клиент не закроет сокет.
 */
export interface ProjectDeps {
  store: TaskStore
  startWorker(taskId: string): { ptyId: string; dispatchId: string; worktree: string; branch: string }
  review(taskId: string): unknown
  accept(taskId: string, decision?: string): void
  /** Решение запроса к человеку (review.ts resolveHumanRequest): accept с git-частью, clarify/restart со стартом воркера. */
  resolveRequest(id: string, resolution: RequestResolution): unknown
  /** Без runId — новый прогон (глобальная задача); с runId — повторный запуск на существующей. */
  startCoordinator(objective: string, runId?: string): string
  /** Удалить глобальную задачу: живой координатор — ошибка, терминалы подзадач закрываются. */
  deleteGlobalTask(runId: string, cascade: boolean): { deleted: string; tasks: string[] }
  /** Агенты реестра с признаками «установлен»/«включён» для этого проекта. */
  agents(): AgentInfo[]
  /** Роли проекта. */
  roles(): Role[]
  /** Колонки доски в порядке показа. */
  columns(): BoardColumn[]
}

export interface SocketDeps {
  /** Проект из запроса (ORCA_PROJECT у агента) или активный. */
  resolve(projectId?: string): ProjectDeps
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

/** Координатор прогона задачи жив (PTY в реестре) и не закончил работу — вопрос адресуется ему. */
export function coordinatorAlive(store: TaskStore, taskId: string): boolean {
  const runId = store.getTask(taskId)?.runId
  const run = runId ? store.getRun(runId) : undefined
  return Boolean(run?.coordinatorPtyId && !run.finishedAt && !run.closedAt && isAlive(run.coordinatorPtyId))
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

/** Роль задачи существует в проекте и её агент можно запускать. */
function assertRoleUsable(roles: Role[], agents: AgentInfo[], roleId: string): void {
  const role = roles.find((r) => r.id === roleId)
  if (!role) throw new Error(`роль ${roleId} не найдена в проекте`)
  assertAgentUsable(agents, role.agent)
}

/** Подзадача: общая часть task.create и global.add-task. Без runId store кладёт её во «Входящие». */
function createTask(r: Request, deps: ProjectDeps, store: TaskStore, runId: string | undefined): unknown {
  const title = str(r.params.title)
  if (!title) throw new Error('--title обязателен')
  if (r.params.agent !== undefined) throw new Error('--agent больше не поддерживается, укажи --role (orca-board roles list)')
  const role = pickRole(deps.roles(), deps.agents(), str(r.params.role))
  // --answer-for human|coordinator — задача-ответ; значение проверяет store.
  const answerFor = r.params['answer-for'] ?? r.params.answerFor
  if (answerFor === true) throw new Error('--answer-for требует значения: human или coordinator')
  return store.createTask({
    title,
    spec: str(r.params.spec),
    deps: list(r.params.dep ?? r.params.deps),
    roleId: role.id,
    agent: role.agent,
    runId,
    ...(answerFor !== undefined ? { answerFor: answerFor as AnswerAudience } : {})
  })
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
  'global.list': (_r, _d, store) => store.listGlobalTasks(),
  'global.get': (r, _d, store) => store.getGlobalTask(globalId(r)),
  'global.create': (r, _d, store) =>
    store.createGlobalTask({ title: str(r.params.title), description: str(r.params.description), status: str(r.params.status) }),
  'global.update': (r, _d, store) =>
    store.updateGlobalTask(globalId(r), { title: str(r.params.title), description: str(r.params.description) }),
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
    if (title === undefined && spec === undefined) throw new Error('укажи --title и/или --spec')
    // Задачу в работе store отвергает.
    return store.editTask(id, { title, spec })
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
    if (task) assertRoleUsable(deps.roles(), deps.agents(), task.roleId)
    return deps.startWorker(id)
  },
  'coordinator.start': (r, deps) => {
    // --global — повторный запуск на существующей глобальной задаче (цель — её описание).
    const run = str(r.params.global)
    if (run) return { ptyId: deps.startCoordinator('', run) }
    const objective = str(r.params.objective)
    if (!objective) throw new Error('--objective обязателен')
    return { ptyId: deps.startCoordinator(objective) }
  },
  'worker.read': (r, _d, store) => {
    const id = str(r.params.dispatch)
    if (!id) throw new Error('--dispatch обязателен')
    const d = store.getDispatch(id)
    if (!d) throw new Error(`dispatch not found: ${id}`)
    return { ...d, alive: isAlive(d.ptyId), tail: ptyTail(d.ptyId, num(r.params.limit, 80)) }
  },
  'worker.done': (r, _d, store) => {
    const id = str(r.params.dispatch) ?? r.dispatchId
    if (!id) throw new Error('нет dispatch: укажи --dispatch или запусти из воркера (ORCA_DISPATCH_ID)')
    // CLI читает --answer-file сам и присылает текст в answer.
    return store.finishDispatch(id, str(r.params.summary) ?? '', list(r.params.files), str(r.params.answer))
  },
  'worker.ask': async (r, _d, store, stream) => {
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
    const q = store.ask(
      { taskId, dispatchId, question, options: askOptions(r.params), context: str(r.params.context) },
      { coordinatorAlive: coordinatorAlive(store, taskId) }
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
  'review.reject': (r, _d, store) => {
    const id = str(r.params.task)
    const feedback = str(r.params.feedback)
    if (!id || !feedback) throw new Error('--task и --feedback обязательны')
    return store.rejectReview(id, feedback)
  },
  'events.list': (_r, _d, store) => store.listEvents(),
  'agents.list': (_r, deps) => deps.agents(),
  // Роли с признаком, включён ли их агент в проекте: координатору видно, какие роли можно назначать.
  'roles.list': (_r, deps) => {
    const enabled = new Set(deps.agents().filter((a) => a.enabled).map((a) => a.id))
    return deps.roles().map((role) => ({ ...role, agentEnabled: enabled.has(role.agent) }))
  },
  'columns.list': (_r, deps) => deps.columns(),
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
  'runs.finish': (r, _d, store) => {
    const id = str(r.params.run)
    if (!id) throw new Error('--run обязателен')
    return store.finishRun(id)
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
      if (!handler) throw new Error(`неизвестная команда: ${req.method}`)
      const deps = socketDeps.resolve(req.projectId || undefined)
      const result = await handler({ ...req, params: req.params ?? {} }, deps, deps.store, stream)
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
