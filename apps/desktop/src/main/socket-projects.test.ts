// Запуск: pnpm --filter @orca-board/desktop test. `projects list` — команда уровня приложения:
// выполняется до SocketDeps.resolve, поэтому работает без проектов и с projectId чужого проекта.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startSocketServer, type ProjectSummary } from './socket'

let tmp: string
let sockPath: string
let server: Server
let projects: ProjectSummary[]
let resolveCalls: number

interface Reply {
  ok: boolean
  error?: string
  result: unknown
}

function call(method: string, projectId?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ id: '1', method, params: {}, projectId }) + '\n'))
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      sock.destroy()
      resolve(JSON.parse(buf.slice(0, nl)))
    })
    sock.on('error', reject)
  })
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-sock-'))
  sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\orca-sock-projects-${process.pid}-${Date.now()}` : path.join(tmp, 'orca.sock')
  projects = []
  resolveCalls = 0
  server = startSocketServer(sockPath, {
    // Как resolveProject в main/index.ts: без проектов или с неизвестным id — ошибка.
    resolve: (projectId) => {
      resolveCalls++
      throw new Error(projectId ? `project not found: ${projectId}` : 'нет проектов: добавьте репозиторий')
    },
    projects: () => projects
  })
  await new Promise((r) => server.once('listening', r))
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

describe('projects list', () => {
  it('без проектов — пустой массив, resolve не вызывается', async () => {
    const res = await call('projects.list')
    assert.equal(res.ok, true, res.error)
    assert.deepEqual(res.result, [])
    assert.equal(resolveCalls, 0)
  })

  it('отдаёт проекты с признаком active и работает с projectId чужого проекта', async () => {
    projects = [
      { id: 'p_a', name: 'a', root: '/a', active: false, inProgress: 0 },
      { id: 'p_b', name: 'b', root: '/b', active: true, inProgress: 2 }
    ]
    const res = await call('projects.list', 'p_gone')
    assert.equal(res.ok, true, res.error)
    assert.deepEqual(res.result, projects)
    assert.equal(resolveCalls, 0)
  })

  it('проектные команды по-прежнему идут через resolve', async () => {
    const res = await call('task.list')
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /нет проектов/)
    assert.equal(resolveCalls, 1)
  })
})
