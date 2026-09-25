// Запуск: pnpm --filter @orca-board/desktop test. Правила агентов доски: хранение в projects.json
// (ProjectManager, миграция старого конфига) и методы сокета поверх него: `rules.*`, а также типы задач —
// `types.list`, `roles.list`, `global.create --type`, `workflow.show --type` (роли и правила — типа прогона).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_ROLES, GENERAL_TASK_TYPE_ID, type GlobalTask, type Role, type Task, type WfStageInfo } from '@orca-board/core'
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
  result: { rules?: string; role?: string; title?: string; typeId?: string; typeTitle?: string }
}

/** Ответ `types list`: то, что проверяют тесты. */
interface TypeRow {
  id: string
  title: string
  default?: boolean
  roles: Array<{ id: string; agent: string; agentEnabled: boolean }>
  stages: Array<{ id: string; type: string }>
}

/** Результат другого вида, чем у rules.*. */
function result<T>(r: Reply): T {
  assert.equal(r.ok, true, r.error)
  return r.result as unknown as T
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
    projects.saveTaskTypeRules(`type_${PID}`, undefined, text)
    assert.equal(new ProjectManager(tmp).agentRules(PID), text)
    projects.saveTaskTypeRules(`type_${PID}`, undefined, ' \n\t ')
    const saved = JSON.parse(readFileSync(path.join(tmp, 'projects.json'), 'utf8')) as {
      projects: Array<Record<string, unknown>>; taskTypes: Array<{ id: string; settings: Record<string, unknown> }>
    }
    assert.equal('agentRules' in saved.projects[0], false)
    assert.equal('agentRules' in saved.taskTypes.find((t) => t.id === `type_${PID}`)!.settings, false)
  })

  it('не строка — ошибка', () => {
    writeOldConfig()
    projects = new ProjectManager(tmp)
    assert.throws(() => projects.saveTaskTypeRules(`type_${PID}`, undefined, 1 as unknown as string), /правила агентов должны быть строкой/)
  })

  it('тип проекта по умолчанию: его правила действуют в проекте, пустые — удаляют поле', () => {
    writeOldConfig()
    projects = new ProjectManager(tmp)
    projects.saveTaskTypeRules(GENERAL_TASK_TYPE_ID, undefined, 'общие')
    projects.setProjectTaskTypes(PID, { defaultTypeId: GENERAL_TASK_TYPE_ID })
    assert.equal(projects.agentRules(PID), 'общие')
    projects.saveTaskTypeRules(GENERAL_TASK_TYPE_ID, undefined, '')
    assert.equal('agentRules' in projects.taskType(GENERAL_TASK_TYPE_ID)!.settings, false)
    assert.equal(projects.agentRules(PID), '')
  })
})

describe('сокет: правила, роли и типы задач', () => {
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
        finishStage: () => { throw new Error('не нужен') },
        resolveRequest: () => ({}),
        startCoordinator: () => '',
        deleteGlobalTask: () => ({ deleted: '', tasks: [] }),
        agents: () => [{ id: 'claude', title: 'Claude Code', installed: true, enabled: true, models: [], defaults: {} }],
        resolveRun: (runId) => projects.resolveRun(PID, runId),
        taskTypes: () => ({ taskTypes: projects.projectTaskTypes(PID), defaultTypeId: projects.projectDefaultTypeId(PID) }),
        runType: (typeId) => projects.runType(PID, typeId),
        saveTaskTypeRules: (typeId, roleId, text) => projects.saveTaskTypeRules(typeId, roleId, text),
        columns: () => projects.columns(PID),
        workflow: (typeId) => projects.taskTypeWorkflow(typeId ?? projects.projectDefaultTypeId(PID))
      }),
      projects: () => []
    })
    await new Promise((r) => server!.once('listening', r))
  })

  // Старый проект мигрировал в тип «repo» (type_p1) — он тип проекта по умолчанию.
  const OWN = { typeId: `type_${PID}`, typeTitle: 'repo' }

  it('общие правила без --type и прогона — типа проекта по умолчанию: get пусто → set → get; пустой текст очищает', async () => {
    assert.deepEqual((await call('rules.get', {})).result, { ...OWN, rules: '' })
    assert.deepEqual((await call('rules.set', { text: 'Не писать в ORION' })).result, { ...OWN, rules: 'Не писать в ORION' })
    assert.deepEqual((await call('rules.get', {})).result, { ...OWN, rules: 'Не писать в ORION' })
    assert.equal(projects.agentRules(PID), 'Не писать в ORION')
    assert.deepEqual((await call('rules.set', { text: '' })).result, { ...OWN, rules: '' })
    assert.equal(projects.agentRules(PID), '')
  })

  it('правила роли — её systemPrompt; остальные роли и поля не меняются', async () => {
    assert.deepEqual((await call('rules.get', { role: 'developer' })).result, { ...OWN, role: 'developer', title: 'Программист', rules: 'старые правила роли' })
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
    assert.match((await call('rules.get', { role: 'nope' })).error ?? '', /роли «nope» нет в типе задачи «/)
    assert.match((await call('rules.set', { role: 'nope', text: 'x' })).error ?? '', /роли «nope» нет в типе задачи «/)
    assert.match((await call('rules.get', { role: true })).error ?? '', /--role требует id роли/)
    assert.match((await call('rules.get', { type: true })).error ?? '', /--type требует id типа/)
    assert.match((await call('rules.set', { type: 'type_nope', text: 'x' })).error ?? '', /тип задачи «type_nope» недоступен в проекте.*types list/)
    assert.match((await call('rules.get', { run: 'run_nope' })).error ?? '', /run not found/)
  })

  it('rules set --type general: встроенный тип правится на месте, тип проекта не тронут', async () => {
    const set = await call('rules.set', { type: 'general', text: 'Общие правила' })
    assert.deepEqual(set.result, { typeId: 'general', typeTitle: 'Программирование', rules: 'Общие правила' })
    assert.equal(projects.taskType('general')!.settings.agentRules, 'Общие правила')
    const role = await call('rules.set', { type: 'general', role: 'qa', text: 'Гонять e2e' })
    assert.equal(role.result.rules, 'Гонять e2e')
    assert.equal(projects.taskType('general')!.settings.roles!.find((r) => r.id === 'qa')!.systemPrompt, 'Гонять e2e')
    assert.deepEqual((await call('rules.get', { type: 'general' })).result, { typeId: 'general', typeTitle: 'Программирование', rules: 'Общие правила' })
    assert.equal(projects.agentRules(PID), '', 'правила типа проекта «repo» не тронуты')
  })

  it('types list: доступные проекту типы, тип по умолчанию, роли с agentEnabled и этапы графа', async () => {
    const rows = result<TypeRow[]>(await call('types.list', {}))
    const own = rows.find((t) => t.id === `type_${PID}`)!
    assert.equal(own.title, 'repo')
    assert.equal(own.default, true)
    const docs = rows.find((t) => t.id === 'docs')!
    assert.equal('builtin' in docs, false, 'особого признака у заготовок нет')
    assert.equal(docs.default, undefined)
    assert.deepEqual(docs.roles.map((r) => r.id), ['coordinator', 'assistant', 'writer', 'reviewer'])
    assert.ok(docs.roles.every((r) => r.agentEnabled))
    assert.equal(docs.stages[0].type, 'start')
    assert.ok(docs.stages.some((s) => s.type === 'work'))
    // Проекту оставили два типа — список сужается, docs недоступен для global create.
    projects.setProjectTaskTypes(PID, { typeIds: [`type_${PID}`, 'general'], defaultTypeId: 'general' })
    const narrowed = result<TypeRow[]>(await call('types.list', {}))
    assert.deepEqual(narrowed.map((t) => [t.id, t.default ?? false]), [['general', true], [`type_${PID}`, false]])
    assert.match((await call('global.create', { title: 'Док', type: 'docs' })).error ?? '', /недоступен в проекте «repo».*types list/)
  })

  it('global create --type docs: тип в карточке, roles list / rules / task create — по ролям типа прогона', async () => {
    const g = result<GlobalTask>(await call('global.create', { title: 'README', type: 'docs' }))
    assert.equal(result<GlobalTask>(await call('global.get', { global: g.id })).typeId, 'docs')
    assert.equal(result<GlobalTask>(await call('global.get', { global: g.id })).typeTitle, 'Документация')
    const roles = result<Array<Role & { agentEnabled: boolean }>>(await call('roles.list', { run: g.id }))
    assert.deepEqual(roles.map((r) => r.id), ['coordinator', 'assistant', 'writer', 'reviewer'])
    assert.ok(roles.every((r) => r.agentEnabled))
    // Без прогона — роли типа проекта по умолчанию, --type — роли выбранного типа.
    assert.ok(result<Role[]>(await call('roles.list', {})).some((r) => r.id === 'developer'))
    assert.ok(result<Role[]>(await call('roles.list', { type: 'autotests' })).some((r) => r.id === 'autotester'))

    const wrong = await call('task.create', { title: 'Код', role: 'developer', run: g.id })
    assert.match(wrong.error ?? '', /роли «developer» нет в типе задачи «Документация»\. Роли типа: coordinator, assistant, writer, reviewer \(orca-board roles list\)\./)
    const ok = result<Task>(await call('task.create', { title: 'Текст', role: 'writer', run: g.id }))
    assert.equal(ok.roleId, 'writer')
    // «Входящие» (без прогона) — по типу проекта по умолчанию: writer там нет.
    assert.match((await call('task.create', { title: 'Во входящие', role: 'writer' })).error ?? '', /роли «writer» нет/)

    assert.deepEqual((await call('rules.get', { run: g.id, role: 'writer' })).result.typeId, 'docs')
    assert.match((await call('rules.set', { run: g.id, role: 'developer', text: 'x' })).error ?? '', /роли «developer» нет/)
    const set = await call('rules.set', { run: g.id, text: 'Писать по-русски' })
    assert.deepEqual(set.result, { typeId: 'docs', typeTitle: 'Документация', rules: 'Писать по-русски' })
    assert.equal(projects.taskType('docs')!.settings.agentRules, 'Писать по-русски')
  })

  it('global create без --type — тип проекта по умолчанию; неизвестный тип — ошибка с подсказкой', async () => {
    const g = result<GlobalTask>(await call('global.create', { title: 'X' }))
    assert.equal(g.typeId, `type_${PID}`)
    assert.match((await call('global.create', { title: 'Y', type: 'type_nope' })).error ?? '', /тип задачи не найден: type_nope.*types list/)
    assert.match((await call('global.create', { title: 'Y', type: true })).error ?? '', /--type требует id типа/)
  })

  it('workflow show: --type — граф типа, без прогона — тип по умолчанию, --run — снимок прогона', async () => {
    type Shown = { source: string; typeId: string; typeTitle: string; stages: WfStageInfo[] }
    const byType = result<Shown>(await call('workflow.show', { type: 'docs' }))
    assert.equal(byType.source, 'type')
    assert.equal(byType.typeId, 'docs')
    assert.equal(result<Shown>(await call('workflow.show', {})).typeId, `type_${PID}`)
    const g = result<GlobalTask>(await call('global.create', { title: 'README', type: 'docs' }))
    const byRun = result<Shown>(await call('workflow.show', { run: g.id }))
    assert.equal(byRun.source, 'run')
    assert.equal(byRun.typeTitle, 'Документация')
    assert.match((await call('workflow.show', { type: 'type_nope' })).error ?? '', /тип задачи не найден/)
  })

  it('coordinator start: --type только у новой глобальной задачи', async () => {
    assert.match((await call('coordinator.start', { global: 'run_1', type: 'docs' })).error ?? '', /--type задаётся только новой глобальной задаче/)
  })
})
