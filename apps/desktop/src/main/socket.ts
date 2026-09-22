import { createServer, type Socket, type Server } from 'node:net'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { EVENT_TYPES, type TaskStore, type EventType, type AgentInfo, type Role, type BoardColumn } from '@orca-board/core'
import { ptyTail, isAlive } from './pty'
import { assertAgentUsable, pickRole } from './agents'

/**
 * Unix-сокет для CLI `orca-board`. Протокол: одна строка JSON-запроса,
 * одна строка JSON-ответа. `check --wait` и `ask` держат соединение до события.
 */
export interface ProjectDeps {
  store: TaskStore
  startWorker(taskId: string): { ptyId: string; dispatchId: string; worktree: string; branch: string }
  review(taskId: string): unknown
  accept(taskId: string): void
  startCoordinator(objective: string): string
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

type Handler = (req: Request, deps: ProjectDeps, store: TaskStore) => Promise<unknown> | unknown

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

/** Роль задачи существует в проекте и её агент можно запускать. */
function assertRoleUsable(roles: Role[], agents: AgentInfo[], roleId: string): void {
  const role = roles.find((r) => r.id === roleId)
  if (!role) throw new Error(`роль ${roleId} не найдена в проекте`)
  assertAgentUsable(agents, role.agent)
}

const handlers: Record<string, Handler> = {
  'task.list': (_r, _d, store) => store.listTasks(),
  'task.get': (r, _d, store) => store.getTask(str(r.params.task) ?? '') ?? null,
  'task.create': (r, deps, store) => {
    const title = str(r.params.title)
    if (!title) throw new Error('--title обязателен')
    if (r.params.agent !== undefined) throw new Error('--agent больше не поддерживается, укажи --role (orca-board roles list)')
    const role = pickRole(deps.roles(), deps.agents(), str(r.params.role))
    return store.createTask({
      title,
      spec: str(r.params.spec),
      deps: list(r.params.dep ?? r.params.deps),
      roleId: role.id,
      agent: role.agent
    })
  },
  'task.move': (r, _d, store) => {
    const id = str(r.params.task)
    const status = str(r.params.status)
    if (!id || !status) throw new Error('--task и --status обязательны')
    // Неизвестную колонку отвергает store.moveTask.
    return store.moveTask(id, status)
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
    return store.finishDispatch(id, str(r.params.summary) ?? '', list(r.params.files))
  },
  'worker.ask': async (r, _d, store) => {
    const dispatchId = str(r.params.dispatch) ?? r.dispatchId
    const taskId = str(r.params.task) ?? r.taskId ?? (dispatchId ? store.getDispatch(dispatchId)?.taskId : undefined)
    if (!taskId) throw new Error('нет задачи: укажи --task или запусти из воркера')
    const question = str(r.params.question)
    if (!question) throw new Error('--question обязателен')
    const q = store.ask({ taskId, dispatchId, question, options: list(r.params.options) })
    if (r.params.wait === false) return q
    return new Promise((resolve) => {
      const off = store.subscribe(() => {
        const cur = store.getQuestion(q.id)
        if (cur?.answeredAt) {
          off()
          resolve(cur)
        }
      })
    })
  },
  'question.answer': (r, _d, store) => {
    const id = str(r.params.question)
    const answer = str(r.params.answer)
    if (!id || answer === undefined) throw new Error('--question и --answer обязательны')
    return store.answer(id, answer)
  },
  'question.list': (_r, _d, store) => store.openQuestions(),
  'review.info': (r, deps) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    return deps.review(id)
  },
  'review.accept': (r, deps, store) => {
    const id = str(r.params.task)
    if (!id) throw new Error('--task обязателен')
    deps.accept(id)
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
  check: async (r, _d, store) => {
    const types = (list(r.params.types).length ? list(r.params.types) : EVENT_TYPES) as EventType[]
    const consumer = str(r.params.consumer) ?? 'coordinator'
    const wait = Boolean(r.params.wait)
    const timeoutMs = num(r.params['timeout-ms'] ?? r.params.timeoutMs, 900_000)

    const now = store.consumeEvents(types, consumer)
    if (now.length || !wait) return { events: now, timedOut: false }

    return new Promise((resolve) => {
      let done = false
      const finish = (events: unknown[], timedOut: boolean): void => {
        if (done) return
        done = true
        off()
        clearTimeout(timer)
        resolve({ events, timedOut })
      }
      const off = store.subscribe(() => {
        const hit = store.consumeEvents(types, consumer)
        if (hit.length) finish(hit, false)
      })
      const timer = setTimeout(() => finish([], true), timeoutMs)
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
    try {
      if (!handler) throw new Error(`неизвестная команда: ${req.method}`)
      const deps = socketDeps.resolve(req.projectId || undefined)
      const result = await handler({ ...req, params: req.params ?? {} }, deps, deps.store)
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

  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) unlinkSync(path)
  server.listen(path)
  return server
}
