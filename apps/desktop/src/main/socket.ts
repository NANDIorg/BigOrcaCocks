import { createServer, type Socket, type Server } from 'node:net'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { EVENT_TYPES, type TaskStore, type EventType, type AgentKind } from '@orca-board/core'
import { ptyTail, isAlive } from './pty'

/**
 * Unix-сокет для CLI `orca-board`. Протокол: одна строка JSON-запроса,
 * одна строка JSON-ответа. `check --wait` и `ask` держат соединение до события.
 */
export interface SocketDeps {
  store: TaskStore
  startWorker(taskId: string): { ptyId: string; dispatchId: string; worktree: string; branch: string }
}

interface Request {
  id?: string
  method: string
  params: Record<string, unknown>
  dispatchId?: string
  taskId?: string
}

type Handler = (req: Request) => Promise<unknown> | unknown

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

export function startSocketServer(path: string, deps: SocketDeps): Server {
  const { store } = deps

  const handlers: Record<string, Handler> = {
    'task.list': () => store.listTasks(),
    'task.get': (r) => store.getTask(str(r.params.task) ?? '') ?? null,
    'task.create': (r) => {
      const title = str(r.params.title)
      if (!title) throw new Error('--title обязателен')
      return store.createTask({
        title,
        spec: str(r.params.spec),
        deps: list(r.params.dep ?? r.params.deps),
        agent: str(r.params.agent) as AgentKind | undefined
      })
    },
    'task.move': (r) => {
      const id = str(r.params.task)
      const status = str(r.params.status)
      if (!id || !status) throw new Error('--task и --status обязательны')
      return store.moveTask(id, status as never)
    },
    'worker.start': (r) => {
      const id = str(r.params.task)
      if (!id) throw new Error('--task обязателен')
      return deps.startWorker(id)
    },
    'worker.read': (r) => {
      const id = str(r.params.dispatch)
      if (!id) throw new Error('--dispatch обязателен')
      const d = store.getDispatch(id)
      if (!d) throw new Error(`dispatch not found: ${id}`)
      return { ...d, alive: isAlive(d.ptyId), tail: ptyTail(d.ptyId, num(r.params.limit, 80)) }
    },
    'worker.done': (r) => {
      const id = str(r.params.dispatch) ?? r.dispatchId
      if (!id) throw new Error('нет dispatch: укажи --dispatch или запусти из воркера (ORCA_DISPATCH_ID)')
      return store.finishDispatch(id, str(r.params.summary) ?? '', list(r.params.files))
    },
    'worker.ask': async (r) => {
      const dispatchId = str(r.params.dispatch) ?? r.dispatchId
      const taskId = str(r.params.task) ?? r.taskId ?? (dispatchId ? store.getDispatch(dispatchId)?.taskId : undefined)
      if (!taskId) throw new Error('нет задачи: укажи --task или запусти из воркера')
      const question = str(r.params.question)
      if (!question) throw new Error('--question обязателен')
      const q = store.ask({ taskId, dispatchId, question, options: list(r.params.options) })
      if (r.params.wait === false || r.params['no-wait']) return q
      // блокируемся до ответа
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
    'question.answer': (r) => {
      const id = str(r.params.question)
      const answer = str(r.params.answer)
      if (!id || answer === undefined) throw new Error('--question и --answer обязательны')
      return store.answer(id, answer)
    },
    'question.list': () => store.openQuestions(),
    'events.list': () => store.listEvents(),
    check: async (r) => {
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
      const result = await handler({ ...req, params: req.params ?? {} })
      sock.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n')
    } catch (e) {
      sock.write(JSON.stringify({ id: req.id, ok: false, error: (e as Error).message }) + '\n')
    }
  }

  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) unlinkSync(path)
  server.listen(path)
  return server
}
