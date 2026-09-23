// Запуск: pnpm --filter @orca-board/desktop test. Правила агентов доски: хранение в projects.json
// (ProjectManager, миграция старого конфига) и методы сокета `rules.get` / `rules.set` поверх него.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ROLES } from '@orca-board/core'
import { ProjectManager } from './projects'
import { startSocketServer } from './socket'

const PID = 'p1'
let tmp: string
let sockPath: string
let server: Server | undefined
let projects: ProjectManager

/** projects.json старого формата: проект без agentRules, у роли developer — свой systemPrompt. */
function writeOldConfig(extra: Record<string, unknown> = {}): void {
  const roles = DEFAULT_ROLES.map((r) => (r.id === 'developer' ? { ...r, systemPrompt: 'старые правила роли' } : r))
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
    projects: [{ id: PID, root: path.join(tmp, 'repo'), name: 'repo', roles, ...extra }],
    activeId: PID
  }))
}

interface Reply {
  ok: boolean
  error?: string
  result: { rules?: string; role?: string; title?: string }
}

function call(method: string, params: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ id: '1', method, params }) + '\n'))
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

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-agent-rules-'))
  sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\orca-agent-rules-${process.pid}-${Date.now()}` : path.join(tmp, 'orca.sock')
})

afterEach(async () => {
  const s = server
  server = undefined
  if (s) await new Promise((r) => s.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

describe('правила агентов в типе проекта по умолчанию (projects.json)', () => {
  it('старый конфиг без поля грузится: правил нет, роли и их systemPrompt на месте', () => {
    writeOldConfig()
    projects = new ProjectManager(tmp)
    assert.equal(projects.agentRules(PID), '')
    assert.equal(projects.roles(PID).find((r) => r.id === 'developer')?.systemPrompt, 'старые правила роли')
  })

  it('мусор вместо строки при загрузке отбрасывается', () => {
    writeOldConfig({ agentRules: 42 })
    projects = new ProjectManager(tmp)
    assert.equal(projects.agentRules(PID), '')
    assert.equal('agentRules' in projects.get(PID)!, false)
  })

  it('сохраняются в тип «repo» как введены и переживают перезагрузку; пробелы — поле удаляется', () => {
    writeOldConfig()
    projects = new ProjectManager(tmp)
    const text = 'Не создавать задачи в ORION.\n\n- «кавычки», `код`\n'
    projects.setAgentRules(PID, text)
    assert.equal(new ProjectManager(tmp).agentRules(PID), text)
    projects.setAgentRules(PID, ' \n\t ')
    const saved = JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8')) as {
      projects: Array<Record<string, unknown>>; taskTypes: Array<{ id: string; settings: Record<string, unknown> }>
    }
    assert.equal('agentRules' in saved.projects[0], false)
    assert.equal('agentRules' in saved.taskTypes.find((t) => t.id === `type_${PID}`)!.settings, false)
  })

  it('не строка — ошибка', () => {
    writeOldConfig()
    projects = new ProjectManager(tmp)
    assert.throws(() => projects.setAgentRules(PID, 1 as unknown as string), /правила агентов должны быть строкой/)
  })

  it('тип библиотеки по умолчанию: его правила действуют в проекте после applyDefaults, пустые — удаляют поле', () => {
    writeOldConfig()
    projects = new ProjectManager(tmp)
    projects.setDefaults({ agentRules: 'общие' })
    assert.equal(projects.defaults().agentRules, 'общие')
    projects.applyDefaults(PID)
    assert.equal(projects.agentRules(PID), 'общие')
    projects.setDefaults({ agentRules: '' })
    assert.equal('agentRules' in projects.defaults(), false)
    projects.applyDefaults(PID)
    assert.equal(projects.agentRules(PID), '')
  })
})

describe('сокет rules.get / rules.set', () => {
  beforeEach(async () => {
    writeOldConfig()
    projects = new ProjectManager(tmp)
    server = startSocketServer(sockPath, {
      // Как в main/index.ts: те же методы ProjectManager.
      resolve: () => ({
        store: projects.store(PID),
        startWorker: () => { throw new Error('не нужен') },
        stopWorker: () => ({ stopped: [] }),
        review: () => ({}),
        accept: () => undefined,
        reject: () => undefined,
        resolveRequest: () => ({}),
        startCoordinator: () => '',
        deleteGlobalTask: () => ({ deleted: '', tasks: [] }),
        agents: () => [],
        roles: (runId) => projects.roles(PID, runId),
        resolveRun: (runId) => projects.resolveRun(PID, runId),
        taskTypes: () => ({ taskTypes: projects.projectTaskTypes(PID), defaultTypeId: projects.projectDefaultTypeId(PID) }),
        runType: (typeId) => projects.runType(PID, typeId),
        saveTaskTypeRules: (typeId, roleId, text) => projects.saveTaskTypeRules(typeId, roleId, text),
        setRoles: (roles) => projects.setRoles(PID, roles).roles ?? roles,
        agentRules: () => projects.agentRules(PID),
        setAgentRules: (text) => projects.setAgentRules(PID, text).agentRules ?? '',
        columns: () => projects.columns(PID),
        workflow: (typeId) => projects.taskTypeWorkflow(typeId ?? projects.projectDefaultTypeId(PID))
      }),
      projects: () => []
    })
    await new Promise((r) => server!.once('listening', r))
  })

  it('общие правила: get пусто → set → get; пустой текст очищает', async () => {
    assert.deepEqual((await call('rules.get', {})).result, { rules: '' })
    assert.deepEqual((await call('rules.set', { text: 'Не писать в ORION' })).result, { rules: 'Не писать в ORION' })
    assert.deepEqual((await call('rules.get', {})).result, { rules: 'Не писать в ORION' })
    assert.equal(projects.agentRules(PID), 'Не писать в ORION')
    assert.deepEqual((await call('rules.set', { text: '' })).result, { rules: '' })
    assert.equal(projects.agentRules(PID), '')
  })

  it('правила роли — её systemPrompt; остальные роли и поля не меняются', async () => {
    assert.deepEqual((await call('rules.get', { role: 'developer' })).result, { role: 'developer', title: 'Программист', rules: 'старые правила роли' })
    const before = projects.roles(PID).find((r) => r.id === 'qa')
    const set = await call('rules.set', { role: 'developer', text: 'новые' })
    assert.equal(set.result.rules, 'новые')
    const dev = projects.roles(PID).find((r) => r.id === 'developer')!
    assert.equal(dev.systemPrompt, 'новые')
    assert.equal(dev.agent, 'claude')
    assert.deepEqual(projects.roles(PID).find((r) => r.id === 'qa'), before)
    assert.equal(projects.agentRules(PID), '', 'общие правила не тронуты')
    await call('rules.set', { role: 'developer', text: '  ' })
    assert.equal('systemPrompt' in projects.roles(PID).find((r) => r.id === 'developer')!, false)
  })

  it('ошибки: нет текста, неизвестная роль, --role без значения', async () => {
    assert.match((await call('rules.set', {})).error ?? '', /нужен текст правил/)
    assert.match((await call('rules.get', { role: 'nope' })).error ?? '', /роли «nope» нет в проекте/)
    assert.match((await call('rules.set', { role: 'nope', text: 'x' })).error ?? '', /роли «nope» нет в проекте/)
    assert.match((await call('rules.get', { role: true })).error ?? '', /--role требует id роли/)
  })
})
