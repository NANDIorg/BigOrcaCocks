// Запуск: pnpm --filter @orca-board/desktop test. Настройки приложения и проекта через сокет
// (docs/assistant-chat.md → «2. Контракт CLI/сокета для настроек»): `settings.*`, `types.*`, `roles.*`,
// `types.perm.*`, `node-templates.*`, `projects.set-active/remove`, `project.*`. Настоящий ProjectManager
// и настоящий сокет, как в src/main/index.ts (`resolve`/`settings`/`setSettings`); PTY и git не участвуют.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_COLUMNS, type AgentInfo, type BoardColumn, type Role, type TaskType, type WfNodeTemplate } from '@orca-board/core'
import { ProjectManager } from './projects'
import { PROJECTS_FILE_VERSION } from './task-types-migration'
import { readRule, writeRule } from './rules'
import { startSocketServer, type ProjectDeps } from './socket'
import { spawnPty, killPty } from './pty'

const PID = 'p1'
const AGENT_IDS = ['claude', 'codex'] as const

let tmp: string
let repoRoot: string
let sockPath: string
let server: Server | undefined
let projects: ProjectManager

interface Reply<T = unknown> {
  ok: boolean
  error?: string
  result: T
}

function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<Reply<T>> {
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
      resolve(JSON.parse(buf.slice(0, nl)) as Reply<T>)
    })
    sock.on('error', reject)
  })
}

/** Ответ ok — результат; ошибка падает с текстом ошибки в сообщении ассерта. */
async function ok<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
  const r = await call<T>(method, params)
  assert.equal(r.ok, true, r.error)
  return r.result
}

async function currentTypes(): Promise<TaskType[]> {
  return ok<TaskType[]>('types.list')
}

/** Реестр агентов проекта: `enabled` — по `Project.enabledAgents` (нет ключа — все установленные), как `agentInfos` в main. */
function agentInfos(): AgentInfo[] {
  const enabled = projects.get(PID)?.enabledAgents
  return AGENT_IDS.map((id) => ({ id, title: id, installed: true, enabled: enabled ? enabled.includes(id) : true, models: [], defaults: {} }))
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-sock-settings-'))
  repoRoot = path.join(tmp, 'repo')
  mkdirSync(repoRoot, { recursive: true })
  sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\orca-sock-settings-${process.pid}-${Date.now()}` : path.join(tmp, 'orca.sock')
  writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({
    version: PROJECTS_FILE_VERSION,
    projects: [{ id: PID, root: repoRoot, name: 'repo', columns: DEFAULT_COLUMNS, enabledAgents: ['claude'] }],
    activeId: PID
  }))
  projects = new ProjectManager(tmp)

  const deps = (): ProjectDeps => {
    const store = projects.store(PID)
    return {
      store,
      startWorker: () => { throw new Error('не нужен') },
      stopWorker: () => ({ stopped: [] }),
      review: () => ({}),
      accept: () => undefined,
      reject: () => undefined,
      finishStage: () => { throw new Error('не нужен') },
      resolveRequest: () => ({}),
      startCoordinator: () => '',
      deleteGlobalTask: () => ({ deleted: '', tasks: [] }),
      agents: agentInfos,
      resolveRun: (runId) => projects.resolveRun(PID, runId),
      taskTypes: () => ({ taskTypes: projects.projectTaskTypes(PID), defaultTypeId: projects.projectDefaultTypeId(PID) }),
      runType: (typeId) => projects.runType(PID, typeId),
      saveTaskTypeRules: (typeId, roleId, text) => projects.saveTaskTypeRules(typeId, roleId, text),
      columns: () => projects.columns(PID),
      workflow: (typeId) => projects.taskTypeWorkflow(typeId ?? projects.projectDefaultTypeId(PID)),
      typesCreate: (input) => projects.saveTaskType({ ...input, settings: {} }),
      typesRename: (id, patch) => projects.renameTaskType(id, patch),
      typesSetDefault: (id) => projects.setDefaultTaskType(id),
      typesDuplicate: (id) => projects.duplicateTaskType(id),
      typesUsage: (id) => projects.taskTypeUsage(id),
      typesDelete: (id) => projects.deleteTaskType(id),
      rolesAdd: (typeId, input) => projects.addRole(typeId, input),
      rolesUpdate: (typeId, roleId, patch) => projects.updateRole(typeId, roleId, patch),
      rolesRemove: (typeId, roleId) => projects.removeRole(typeId, roleId),
      permissionMode: (typeId) => projects.permissionMode(typeId),
      setPermissionMode: (typeId, mode) => {
        projects.patchTaskType(typeId, { permissionMode: mode })
        return projects.permissionMode(typeId)
      },
      nodeTemplates: () => projects.nodeTemplates(),
      deleteNodeTemplate: (id) => projects.deleteNodeTemplate(id),
      setActive: () => projects.setActive(PID),
      removeProject: () => {
        projects.remove(PID)
        return { removed: PID }
      },
      setEnabledAgents: (ids) => projects.setEnabledAgents(PID, ids as never[]),
      setColumns: (columns) => projects.setColumns(PID, columns),
      setProjectTaskTypes: (input) => projects.setProjectTaskTypes(PID, input),
      projectRulesGet: (file) => readRule(repoRoot, file),
      projectRulesSet: (file, text) => writeRule(repoRoot, file, text)
    }
  }
  server = startSocketServer(sockPath, {
    resolve: () => deps(),
    projects: () => [],
    settings: () => projects.settings(),
    setSettings: (patch) => projects.setSettings(patch)
  })
  await new Promise((r) => server!.once('listening', r))
})

afterEach(async () => {
  const s = server
  server = undefined
  if (s) await new Promise((r) => s.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

describe('settings get/set', () => {
  it('get отдаёт AppSettings, set мержит поднабор флагов', async () => {
    assert.deepEqual(await ok('settings.get'), projects.settings())
    const after = await ok<{ language?: string; keepInBackground: boolean }>('settings.set', { language: 'en', 'keep-in-background': false })
    assert.equal(after.language, 'en')
    assert.equal(after.keepInBackground, false)
  })

  it('уведомления: enabled, notify-role/notify-event пары, quiet-hours, sound, show-preview', async () => {
    const r = await ok<{
      notifications: {
        enabled: boolean; roles: Record<string, boolean>; events: Record<string, boolean>
        quietHours: { enabled: boolean; from: string; to: string }; sound: boolean; showPreview: boolean
      }
    }>('settings.set', {
      'notifications-enabled': false,
      'notify-role': ['developer=off', 'qa=on'],
      'notify-event': ['question=off'],
      'quiet-hours': '22:00-08:00',
      sound: false,
      'show-preview': false
    })
    assert.equal(r.notifications.enabled, false)
    assert.deepEqual(r.notifications.roles, { developer: false, qa: true })
    assert.equal(r.notifications.events.question, false)
    assert.deepEqual(r.notifications.quietHours, { enabled: true, from: '22:00', to: '08:00' })
    assert.equal(r.notifications.sound, false)
    assert.equal(r.notifications.showPreview, false)
    const off = await ok<{ notifications: { quietHours: { enabled: boolean } } }>('settings.set', { 'quiet-hours': false })
    assert.equal(off.notifications.quietHours.enabled, false)
  })

  it('автообновление: auto-check/auto-download/install-when-idle', async () => {
    const r = await ok<{ updates: { autoCheck: boolean; autoDownload: boolean; installWhenIdle: boolean } }>('settings.set', {
      'auto-check': false, 'auto-download': false, 'install-when-idle': true
    })
    assert.deepEqual(r.updates, { autoCheck: false, autoDownload: false, installWhenIdle: true })
  })

  it('ошибки: плохой язык, плохой формат тихих часов, неизвестный вид уведомления, флаг без значения', async () => {
    assert.match((await call('settings.set', { language: 'fr' })).error ?? '', /--language: ru или en/)
    assert.match((await call('settings.set', { 'quiet-hours': '22-08' })).error ?? '', /--quiet-hours: формат/)
    assert.match((await call('settings.set', { 'notify-event': ['nope=on'] })).error ?? '', /--notify-event: неизвестный вид/)
    assert.match((await call('settings.set', { sound: 'да' })).error ?? '', /--sound — флаг без значения/)
  })
})

describe('settings: ассистент', () => {
  interface Assistant { agent: string; model?: string; effort?: string; systemPrompt?: string }

  it('get отдаёт assistant; set --assistant-model/-effort/-prompt мержит по полям, "" очищает', async () => {
    const got = await ok<{ assistant: Assistant }>('settings.get')
    assert.deepEqual(got.assistant, { agent: 'claude' })
    const set = await ok<{ assistant: Assistant; keepInBackground: boolean }>('settings.set', {
      'assistant-model': 'opus', 'assistant-effort': 'high', 'assistant-prompt': 'Отвечай коротко.'
    })
    assert.deepEqual(set.assistant, { agent: 'claude', model: 'opus', effort: 'high', systemPrompt: 'Отвечай коротко.' })
    const cleared = await ok<{ assistant: Assistant }>('settings.set', { 'assistant-prompt': '', 'assistant-effort': '' })
    assert.deepEqual(cleared.assistant, { agent: 'claude', model: 'opus' })
    assert.deepEqual(projects.settings().assistant, cleared.assistant, 'сохранено в ProjectManager')
  })

  it('смена --assistant-agent требует --yes; с --yes модель и effort сбрасываются, если не заданы тем же вызовом', async () => {
    await ok('settings.set', { 'assistant-model': 'opus', 'assistant-effort': 'high' })
    const refused = await call('settings.set', { 'assistant-agent': 'codex' })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /нужно подтверждение.*агента ассистента с «claude» на «codex».*--yes/)
    assert.equal(projects.settings().assistant.agent, 'claude', 'без --yes ничего не записано')
    const changed = await ok<{ assistant: Assistant }>('settings.set', { 'assistant-agent': 'codex', yes: true })
    assert.deepEqual(changed.assistant, { agent: 'codex' })
    const withModel = await ok<{ assistant: Assistant }>('settings.set', { 'assistant-agent': 'claude', 'assistant-model': 'sonnet', yes: true })
    assert.deepEqual(withModel.assistant, { agent: 'claude', model: 'sonnet' })
    // Тот же агент — не смена, подтверждение не нужно.
    assert.equal((await ok<{ assistant: Assistant }>('settings.set', { 'assistant-agent': 'claude' })).assistant.model, 'sonnet')
  })

  it('ошибки: неизвестный агент, флаг без значения', async () => {
    assert.match((await call('settings.set', { 'assistant-agent': 'nope', yes: true })).error ?? '', /--assistant-agent: неизвестный агент «nope»/)
    assert.match((await call('settings.set', { 'assistant-model': true })).error ?? '', /--assistant-model требует значения/)
  })

  it('ассистент — не роль типа: нет в roles list, roles update/rules set --role assistant — ошибка «нет роли»', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    const roles = await ok<Role[]>('roles.list', { type: typeId })
    assert.ok(roles.length > 0)
    assert.ok(!roles.some((r) => r.id === 'assistant'), roles.map((r) => r.id).join(','))
    const upd = await call('roles.update', { type: typeId, role: 'assistant', model: 'opus' })
    assert.equal(upd.ok, false)
    assert.equal((await call('rules.set', { type: typeId, role: 'assistant', text: 'x' })).ok, false)
  })
})

describe('types.*', () => {
  it('create/rename/set-default/duplicate', async () => {
    const created = await ok<TaskType>('types.create', { title: 'Дизайн', description: 'UI/UX' })
    assert.equal(created.title, 'Дизайн')
    assert.equal(created.description, 'UI/UX')
    const renamed = await ok<TaskType>('types.rename', { type: created.id, title: 'Дизайн UI' })
    assert.equal(renamed.title, 'Дизайн UI')
    assert.equal(renamed.description, 'UI/UX', 'description не тронут — не передавался')
    const state = await ok<{ defaultTaskTypeId: string }>('types.set-default', { type: created.id })
    assert.equal(state.defaultTaskTypeId, created.id)
    const dup = await ok<TaskType>('types.duplicate', { type: created.id })
    assert.notEqual(dup.id, created.id)
    assert.match(dup.title, /Дизайн UI/)
  })

  it('rename без полей — ошибка; неизвестный тип — ошибка', async () => {
    assert.match((await call('types.rename', { type: 'general' })).error ?? '', /--title и\/или --description/)
    assert.match((await call('types.rename', { type: 'nope', title: 'x' })).error ?? '', /тип задачи не найден: nope/)
  })

  it('create: без --title — ошибка', async () => {
    assert.match((await call('types.create', {})).error ?? '', /--title обязателен/)
  })

  it('delete: без --yes — подтверждение с числом проектов и признаком умолчания, с --yes — удаляет', async () => {
    const created = await ok<TaskType>('types.create', { title: 'Одноразовый' })
    await ok('project.types.set', { types: `${created.id},general`, default: created.id })
    const refused = await call('types.delete', { type: created.id })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /нужно подтверждение.*используется в 1 проект.*--yes/)
    const done = await ok<{ taskTypes: TaskType[] }>('types.delete', { type: created.id, yes: true })
    assert.ok(!done.taskTypes.some((t) => t.id === created.id))
  })

  it('последний тип библиотеки не удаляется даже с --yes', async () => {
    const types = await currentTypes()
    for (const t of types.slice(1)) await ok('types.delete', { type: t.id, yes: true })
    const remaining = await currentTypes()
    assert.equal(remaining.length, 1)
    assert.match((await call('types.delete', { type: remaining[0].id, yes: true })).error ?? '', /последний в библиотеке/)
  })
})

describe('roles.*', () => {
  it('add/update/remove на типе проекта по умолчанию', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    const role = await ok<Role>('roles.add', { type: typeId, title: 'Дизайнер', agent: 'claude', model: 'opus' })
    assert.equal(role.title, 'Дизайнер')
    assert.equal(role.model, 'opus')
    const updated = await ok<Role>('roles.update', { type: typeId, role: role.id, title: 'UI-дизайнер', effort: 'high' })
    assert.equal(updated.title, 'UI-дизайнер')
    assert.equal(updated.effort, 'high')
    const after = await ok<TaskType>('roles.remove', { type: typeId, role: role.id, yes: true })
    assert.ok(!(after.settings.roles ?? []).some((r) => r.id === role.id))
  })

  it('update: смена --agent требует подтверждение с текущим и новым агентом, остальные поля — нет', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    const role = await ok<Role>('roles.add', { type: typeId, title: 'Дизайнер', agent: 'claude' })
    const refused = await call('roles.update', { type: typeId, role: role.id, agent: 'codex' })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /нужно подтверждение.*агента роли.*«claude».*«codex».*--yes/)
    const updated = await ok<Role>('roles.update', { type: typeId, role: role.id, agent: 'codex', yes: true })
    assert.equal(updated.agent, 'codex')
  })

  it('update: без единого флага — ошибка', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    const role = await ok<Role>('roles.add', { type: typeId, title: 'Дизайнер', agent: 'claude' })
    assert.match((await call('roles.update', { type: typeId, role: role.id })).error ?? '', /хотя бы один флаг/)
  })

  it('add: обязательны --title и --agent; неизвестный агент — ошибка', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    assert.match((await call('roles.add', { type: typeId, agent: 'claude' })).error ?? '', /--title обязателен/)
    assert.match((await call('roles.add', { type: typeId, title: 'X' })).error ?? '', /--agent обязателен/)
    assert.match((await call('roles.add', { type: typeId, title: 'X', agent: 'nope' })).error ?? '', /неизвестный агент/)
  })

  it('remove: без --yes — подтверждение с числом задач и этапами воркфлоу, где занята роль', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    const store = projects.store(PID)
    store.createTask({ title: 'T', roleId: 'developer', agent: 'claude' })
    const refused = await call('roles.remove', { type: typeId, role: 'developer' })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /нужно подтверждение.*роли «developer».*на ней 1 задач.*--yes/)
  })

  it('remove: без --yes отказ называет и этапы воркфлоу, где занята роль (не только задачи)', async () => {
    // Тип проекта по умолчанию: дефолтный граф (defaultWorkflow) ставит гейт «Ревью» на роль reviewer,
    // раз она есть в DEFAULT_ROLES — nodesUsingRole должен её найти без единой созданной задачи.
    const typeId = projects.projectDefaultTypeId(PID)
    const refused = await call('roles.remove', { type: typeId, role: 'reviewer' })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /нужно подтверждение.*роли «reviewer».*этапы воркфлоу: Ревью.*--yes/)
  })

  it('remove: последнюю роль типа не убрать', async () => {
    const created = await ok<TaskType>('types.create', { title: 'Один' })
    const custom = await ok<Role>('roles.add', { type: created.id, title: 'Кастом', agent: 'claude' })
    const defaults = (projects.taskType(created.id)!.settings.roles ?? []).filter((r) => r.id !== custom.id)
    for (const r of defaults) await ok('roles.remove', { type: created.id, role: r.id, yes: true })
    assert.deepEqual(projects.taskType(created.id)!.settings.roles?.map((r) => r.id), [custom.id])
    assert.match((await call('roles.remove', { type: created.id, role: custom.id, yes: true })).error ?? '', /нужна хотя бы одна роль/)
  })
})

describe('types.perm.*', () => {
  it('get/set; bypassPermissions требует --yes', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    assert.deepEqual(await ok('types.perm.get', { type: typeId }), { typeId, permissionMode: 'auto' })
    assert.deepEqual(await ok('types.perm.set', { type: typeId, mode: 'acceptEdits' }), { typeId, permissionMode: 'acceptEdits' })
    const refused = await call('types.perm.set', { type: typeId, mode: 'bypassPermissions' })
    assert.match(refused.error ?? '', /нужно подтверждение: bypassPermissions.*--yes/)
    assert.deepEqual(await ok('types.perm.set', { type: typeId, mode: 'bypassPermissions', yes: true }), { typeId, permissionMode: 'bypassPermissions' })
  })

  it('неизвестный режим — ошибка', async () => {
    const typeId = projects.projectDefaultTypeId(PID)
    assert.match((await call('types.perm.set', { type: typeId, mode: 'god' })).error ?? '', /--mode обязателен/)
  })
})

describe('node-templates.*', () => {
  it('list пуст изначально; delete без --yes отказывает, с --yes удаляет', async () => {
    assert.deepEqual(await ok('node-templates.list'), [])
    projects.saveNodeTemplate({ title: 'Мерж', node: { type: 'merge' } as never })
    const [tpl] = await ok<WfNodeTemplate[]>('node-templates.list')
    assert.match((await call('node-templates.delete', { template: tpl.id })).error ?? '', /нужно подтверждение.*--yes/)
    assert.deepEqual(await ok('node-templates.delete', { template: tpl.id, yes: true }), [])
  })

  it('без --template — ошибка', async () => {
    assert.match((await call('node-templates.delete', {})).error ?? '', /--template обязателен/)
  })
})

describe('projects.set-active / remove', () => {
  it('set-active активирует проект', async () => {
    const active = await ok<{ id: string }>('projects.set-active')
    assert.equal(active.id, PID)
  })

  it('remove без --yes отказывает с числом живых воркеров, с --yes удаляет', async () => {
    const store = projects.store(PID)
    const task = store.createTask({ title: 'T', roleId: 'developer', agent: 'claude' })
    // Живой воркер: настоящий PTY (реестр main), который isAlive видит — node вместо sleep, его нет на Windows.
    const pty = spawnPty({ meta: { role: 'worker', label: 'w', taskId: task.id }, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], cols: 80, rows: 24 })
    store.startDispatch(task.id, pty)
    try {
      const refused = await call('projects.remove', {})
      assert.match(refused.error ?? '', /нужно подтверждение.*живых воркер.*--yes/)
    } finally {
      killPty(pty)
    }
    store.closeDispatches(task.id)
    const removed = await ok<{ removed: string }>('projects.remove', { yes: true })
    assert.equal(removed.removed, PID)
    assert.equal(projects.get(PID), undefined)
  })

  it('remove без --yes отказывает и из-за живого координатора (не только воркеров)', async () => {
    const store = projects.store(PID)
    const run = store.createRun('Цель')
    const pty = spawnPty({ meta: { role: 'coordinator', label: 'c', runId: run.id }, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], cols: 80, rows: 24 })
    store.setRunPty(run.id, pty)
    try {
      const refused = await call('projects.remove', {})
      assert.match(refused.error ?? '', /нужно подтверждение.*живых координатор.*--yes/)
    } finally {
      killPty(pty)
    }
  })
})

describe('project.agents.set', () => {
  it('enable/disable мержат список включённых агентов проекта (изначально только claude)', async () => {
    assert.deepEqual(projects.get(PID)!.enabledAgents, ['claude'])
    const p1 = await ok<{ enabledAgents?: string[] }>('project.agents.set', { enable: ['codex'] })
    assert.deepEqual([...p1.enabledAgents!].sort(), ['claude', 'codex'])
    const p2 = await ok<{ enabledAgents?: string[] }>('project.agents.set', { disable: ['claude'] })
    assert.deepEqual(p2.enabledAgents, ['codex'])
  })

  it('без --enable/--disable и с неизвестным агентом — ошибка', async () => {
    assert.match((await call('project.agents.set', {})).error ?? '', /укажи хотя бы один --enable\/--disable/)
    assert.match((await call('project.agents.set', { enable: ['nope'] })).error ?? '', /неизвестный агент «nope»/)
  })
})

describe('project.columns.set', () => {
  it('замена колонок без занятых удаляемых — без подтверждения', async () => {
    const columns: BoardColumn[] = [...DEFAULT_COLUMNS, { id: 'extra', title: 'Доп', color: '#000', kind: 'custom' }]
    const r = await ok<{ project: { columns: BoardColumn[] }; movedToBacklog: string[] }>('project.columns.set', { columns })
    assert.equal(r.movedToBacklog.length, 0)
    assert.ok(r.project.columns.some((c) => c.id === 'extra'))
  })

  it('удаление занятой колонки без --yes отказывает, называет число задач; с --yes переносит их в backlog', async () => {
    const store = projects.store(PID)
    const withExtra: BoardColumn[] = [...DEFAULT_COLUMNS, { id: 'extra', title: 'Доп', color: '#000', kind: 'custom' }]
    await ok('project.columns.set', { columns: withExtra })
    const task = store.createTask({ title: 'T', roleId: 'developer', agent: 'claude' })
    store.moveTask(task.id, 'extra')
    const refused = await call('project.columns.set', { columns: DEFAULT_COLUMNS })
    assert.match(refused.error ?? '', /нужно подтверждение.*перенесёт 1 задач.*--yes/)
    const done = await ok<{ movedToBacklog: string[] }>('project.columns.set', { columns: DEFAULT_COLUMNS, yes: true })
    assert.deepEqual(done.movedToBacklog, [task.id])
    // reassignColumn зовёт promoteReady: задача без зависимостей из backlog сразу уходит в ready — это её нормальный путь.
    assert.equal(store.getTask(task.id)!.status, 'ready')
  })

  it('не массив — ошибка', async () => {
    assert.match((await call('project.columns.set', { columns: 'nope' })).error ?? '', /--file обязателен/)
  })
})

describe('project.types.set', () => {
  it('сужает библиотеку до списка и задаёт тип по умолчанию; без --types — вся библиотека', async () => {
    const r = await ok<{ taskTypeIds?: string[]; defaultTaskTypeId?: string }>('project.types.set', { types: 'general,docs', default: 'general' })
    assert.deepEqual([...r.taskTypeIds!].sort(), ['docs', 'general'])
    assert.equal(r.defaultTaskTypeId, 'general')
    const widened = await ok<{ taskTypeIds?: string[] }>('project.types.set', { default: 'general' })
    assert.equal(widened.taskTypeIds, undefined)
  })

  it('без --default — ошибка', async () => {
    assert.match((await call('project.types.set', {})).error ?? '', /--default обязателен/)
  })
})

describe('project.rules.get / set', () => {
  it('нет файла — exists: false; set пишет файл в корне репозитория, не коммитит', async () => {
    assert.deepEqual(await ok('project.rules.get', { file: 'CLAUDE.md' }), { name: 'CLAUDE.md', exists: false, text: '', eol: 'lf' })
    const saved = await ok<{ exists: boolean; text: string }>('project.rules.set', { file: 'CLAUDE.md', text: '# Правила\n' })
    assert.equal(saved.exists, true)
    assert.equal(saved.text, '# Правила\n')
    assert.equal(readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8'), '# Правила\n')
  })

  it('неизвестное имя файла и отсутствие текста — ошибка', async () => {
    assert.match((await call('project.rules.get', { file: 'other.md' })).error ?? '', /можно править только/)
    assert.match((await call('project.rules.set', { file: 'CLAUDE.md' })).error ?? '', /нужен текст правил/)
    assert.match((await call('project.rules.set', { file: 'other.md', text: 'x' })).error ?? '', /можно править только/)
  })

  it('без --file — ошибка у get и у set', async () => {
    assert.match((await call('project.rules.get', {})).error ?? '', /--file обязателен/)
    assert.match((await call('project.rules.set', { text: 'x' })).error ?? '', /--file обязателен/)
  })
})
