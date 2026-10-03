import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TaskStore, DEFAULT_COLUMNS, WORKFLOW_VERSION_TASK_SCOPE, type Workflow, type Role, type AgentInfo } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { workflowMessages, workflowResources } from './workflow-test-host.ts'

let dir: string
let repo: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-worker-preparation-')))
  repo = join(dir, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const roles: Role[] = [{ id: 'developer', title: 'Dev', agent: 'claude' }, { id: 'reviewer', title: 'Review', agent: 'codex' }]
const agents: AgentInfo[] = [
  { id: 'claude', title: 'Claude', installed: true, enabled: true, models: [], defaults: {} },
  { id: 'codex', title: 'Codex', installed: true, enabled: false, models: [], defaults: {} }
]
function graph(first: 'work' | 'ask' = 'work', roleId = 'reviewer'): Workflow {
  return {
    version: WORKFLOW_VERSION_TASK_SCOPE,
    nodes: [ { id: 's', type: 'start', x: 0, y: 0 }, { id: 'w', type: first, roleId, instructions: 'Ask', x: 0, y: 0 }, { id: 'h', type: 'human', x: 0, y: 0 } ],
    edges: [ { id: 'a', from: 's', outcome: 'next', to: 'w' }, { id: 'b', from: 'w', outcome: 'next', to: 'h' } ]
  }
}
function fixture(wf = graph()) {
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const run = store.createRun('Goal', undefined, wf)
  const task = store.createTask({ title: 'Work', roleId: 'developer', runId: run.id })
  const messages = workflowMessages()
  const service = runtime.createTaskWorkflowServices({ resources: workflowResources, review: runtime.createReviewServices({ resources: workflowResources, messages }), messages })
  const deps: runtime.WorkflowDeps = { store, repoRoot: repo, run: () => ({ roles, workflow: wf }), startWorker: id => {
    const d = store.startDispatch(id, 'pty_new'); return { ptyId: d.ptyId, dispatchId: d.id }
  } }
  return { store, task, deps, service }
}
function preflight(prefix = '') {
  assert.equal(typeof runtime.createWorkerPreflight, 'function')
  const messages = { error: (key: string, params?: runtime.ExecutionMessageParams) => Object.assign(new Error(prefix + key), { key, params }) }
  return runtime.createWorkerPreflight({ messages, selection: runtime.createAgentSelection(messages), launchPolicy: runtime.createLaunchPolicy(messages) })
}
function prepare(f: ReturnType<typeof fixture>, options: { roleId?: string } = {}, infos = agents, typeRoles = roles) {
  const guard = preflight()
  return f.service.enterWork(f.deps, f.task.id, { ...options, validateRole: id => guard.validate({ title: 'Type', roles: typeRoles }, infos, id) })
}

it('отказ выбранной work-role сохраняет этап/approval/block до restart', () => {
  const f = fixture()
  f.store.enterWork(f.task.id); f.store.advanceStage(f.task.id, 'next')
  const request = f.store.requestApproval(f.task.id, { nodeId: 'h', title: 'Review' }); f.store.blockStage(f.task.id, 'wait')
  const before = structuredClone(f.store.snapshot())
  assert.throws(() => f.service.enterWork(f.deps, f.task.id, { validateRole: id => { assert.equal(id, 'reviewer'); throw new Error('unusable') } }), /unusable/)
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(f.store.getRequest(request.id)!.status, 'pending')
})

it('fresh entry проверяет stage-role, а не прежнюю роль задачи', () => {
  const f = fixture(); const before = structuredClone(f.store.snapshot())
  assert.throws(() => f.service.enterWork(f.deps, f.task.id, { validateRole: id => { assert.equal(id, 'reviewer'); throw new Error('disabled') } }), /disabled/)
  assert.deepEqual(f.store.snapshot(), before)
})

for (const failure of ['missing', 'disabled', 'notInstalled', 'unknown', 'extraArgs'] as const) {
  it(`${failure}: общий preflight отвергает выбранную роль без прямых effects`, () => {
    const f = fixture(); const before = structuredClone(f.store.snapshot())
    const typeRoles = failure === 'missing' ? [roles[0]] : [roles[0], {
      ...roles[1], ...(failure === 'unknown' ? { agent: 'unknown' as Role['agent'] } : {}), ...(failure === 'extraArgs' ? { extraArgs: 'positional' } : {})
    }]
    const infos = agents.map(a => a.id === 'codex' ? { ...a, enabled: failure !== 'disabled', installed: failure !== 'notInstalled' } : a)
    const want = failure === 'missing' || failure === 'extraArgs' ? 'worker.cannotStart' : `agent.${failure}`
    assert.throws(() => prepare(f, {}, infos, typeRoles), { message: want })
    assert.deepEqual(f.store.snapshot(), before)
    assert.equal(git(repo, 'branch', '--list', `orca/${f.task.id}`), '')
  })
}

it('успешная проверка предшествует сохранению work-role и её агента', () => {
  const f = fixture(); let selected: string | undefined
  f.service.enterWork(f.deps, f.task.id, { validateRole: id => {
    selected = id
    assert.equal(id, 'reviewer'); assert.equal(f.store.getTask(f.task.id)!.roleId, 'developer')
    assert.equal(f.store.getTask(f.task.id)!.stage, undefined)
  } })
  assert.equal(f.store.getTask(f.task.id)!.roleId, 'reviewer')
  assert.equal(f.store.getTask(f.task.id)!.agent, 'codex')
  assert.equal(selected, 'reviewer')
})

it('ask-role и override проверяются без переноса временной роли на задачу', () => {
  const f = fixture(graph('ask'))
  const before = structuredClone(f.store.snapshot())
  assert.throws(() => prepare(f), { message: 'agent.disabled' })
  assert.deepEqual(f.store.snapshot(), before)
  assert.deepEqual(prepare(f, { roleId: 'developer' }), { roleId: 'reviewer' })
  assert.equal(f.store.getTask(f.task.id)!.roleId, 'developer')
  const again = structuredClone(f.store.snapshot())
  assert.throws(() => prepare(f), { message: 'agent.disabled' })
  assert.deepEqual(f.store.snapshot(), again)
})

it('ответы и гейты проверяют собственную роль без входа в граф', () => {
  const f = fixture()
  for (const fields of [{ answerFor: 'human' as const }, { gateFor: { taskId: f.task.id, nodeId: 'h' } }]) {
    const task = f.store.createTask({ title: 'Special', roleId: 'developer', ...fields })
    const before = structuredClone(f.store.snapshot())
    const result = f.service.enterWork(f.deps, task.id, { validateRole: id => { assert.equal(id, 'developer') } })
    assert.deepEqual(result, {}); assert.deepEqual(f.store.snapshot(), before)
  }
})

function gitGraph(fail = false): Workflow {
  const wf = graph('work', 'developer')
  wf.nodes.push({ id: 'g', type: 'git', operation: 'create_branch', branch: 'prepared', ...(fail ? { base: 'missing-base' } : {}), x: 0, y: 0 })
  wf.nodes.push({ id: 'repair', type: 'work', roleId: 'reviewer', x: 0, y: 0 })
  wf.edges = [{ id: 'a', from: 's', outcome: 'next', to: 'g' }, { id: 'ok', from: 'g', outcome: 'ok', to: 'w' }, { id: 'error', from: 'g', outcome: 'error', to: 'repair' }]
  return wf
}

it('Git ok не проверяет недоступного агента error-ветки', () => {
  const f = fixture(gitGraph())
  assert.deepEqual(prepare(f), {})
  assert.equal(f.store.getTask(f.task.id)!.stage!.nodeId, 'w')
  assert.equal(f.store.getTask(f.task.id)!.roleId, 'developer')
  assert.notEqual(git(repo, 'branch', '--list', 'prepared'), '')
  assert.equal(f.store.snapshot().dispatches.length, 0)
})

it('Git error проверяет фактическую роль до перехода и сохраняет позицию Git', () => {
  const f = fixture(gitGraph(true))
  assert.throws(() => prepare(f), { message: 'agent.disabled' })
  assert.equal(f.store.getTask(f.task.id)!.stage!.nodeId, 'g')
  assert.match(f.store.getTask(f.task.id)!.feedback!, /missing-base/)
  assert.equal(f.store.getTask(f.task.id)!.roleId, 'developer')
  assert.equal(f.store.snapshot().dispatches.length, 0)
  assert.equal(git(repo, 'branch', '--list', 'prepared'), '')
})

it('Git error может запустить доступную repair-role при недоступном success агенте', () => {
  const f = fixture(gitGraph(true))
  const infos = agents.map(a => ({ ...a, enabled: a.id === 'codex' }))
  prepare(f, {}, infos)
  assert.equal(f.store.getTask(f.task.id)!.stage!.nodeId, 'repair')
  assert.equal(f.store.getTask(f.task.id)!.roleId, 'reviewer')
  assert.match(f.store.getTask(f.task.id)!.feedback!, /missing-base/)
})

it('явный override проверяется до входа в Git и создания ветки', () => {
  const f = fixture(gitGraph()); const before = structuredClone(f.store.snapshot())
  assert.throws(() => prepare(f, { roleId: 'reviewer' }), { message: 'agent.disabled' })
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(git(repo, 'branch', '--list', 'prepared'), '')
})

it('Git подготовка сохраняется при отказе выбранного success агента, следующий work не записывается', () => {
  const f = fixture(gitGraph()); const infos = agents.map(a => ({ ...a, enabled: false }))
  assert.throws(() => prepare(f, {}, infos), { message: 'agent.disabled' })
  const task = f.store.getTask(f.task.id)!
  assert.equal(task.stage!.nodeId, 'g'); assert.equal(task.roleId, 'developer')
  assert.equal(task.branch, 'prepared'); assert.equal(existsSync(task.worktree!), true)
  assert.equal(f.store.snapshot().dispatches.length, 0)
})

it('public entrypoint проверяет запуск под обычным Node без Electron/DISPLAY', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createWorkerPreflight, createAgentSelection, createLaunchPolicy } from '@orca-board/runtime'
    const messages = { error: (key) => new Error(key) }
    const service = createWorkerPreflight({ messages, selection: createAgentSelection(messages), launchPolicy: createLaunchPolicy(messages) })
    const role = { id: 'dev', title: 'Dev', agent: 'claude', extraArgs: '--verbose' }
    const agents = [{ id: 'claude', title: 'Claude', installed: true, enabled: true, models: [], defaults: {} }]
    assert.equal(service.validate({ title: 'Owner', roles: [role] }, agents, 'dev'), role)
    assert.throws(() => service.validate({ title: 'Owner', roles: [] }, agents, 'missing'), /worker.cannotStart/)
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', DISPLAY: '' } })
  assert.equal(child.status, 0, child.stderr)
})


it('после ask без override следующая work без своей роли сохраняет developer', () => {
  const wf = graph('ask'); wf.nodes[2] = { id: 'h', type: 'work', x: 0, y: 0 }
  const f = fixture(wf); const infos = agents.map(a => ({ ...a, enabled: true }))
  assert.deepEqual(prepare(f, {}, infos), { roleId: 'reviewer' })
  f.store.advanceStage(f.task.id, 'next')
  assert.deepEqual(prepare(f), {})
  assert.equal(f.store.getTask(f.task.id)!.roleId, 'developer')
})

it('Git error к человеку сохраняет запрос и причину, воркер не запускается', () => {
  const wf = gitGraph(true)
  wf.nodes = wf.nodes.map(n => n.id === 'repair' ? { id: n.id, type: 'human', x: 0, y: 0 } : n)
  const f = fixture(wf)
  assert.throws(() => prepare(f), /воркер не запущен/)
  assert.equal(f.store.getTask(f.task.id)!.stage!.nodeId, 'repair')
  assert.equal(f.store.pendingRequests().length, 1)
  assert.match(f.store.pendingRequests()[0].body!, /missing-base/)
  assert.equal(f.store.snapshot().dispatches.length, 0)
})

it('два host preflight сохраняют собственные ошибки и не смешивают роли', () => {
  const one = preflight('one:'); const two = preflight('two:')
  assert.throws(() => one.validate({ title: 'One', roles: [] }, agents, 'developer'), { message: 'one:worker.cannotStart' })
  assert.throws(() => two.validate({ title: 'Two', roles }, agents, 'reviewer'), { message: 'two:agent.disabled' })
  assert.equal(one.validate({ title: 'One', roles: [roles[0]] }, agents, 'developer').agent, 'claude')
})

it('Git → merge → work проверяет роль после фактического мержа до входа в work', () => {
  const wf = gitGraph()
  wf.nodes.push({ id: 'm', type: 'merge', x: 0, y: 0 })
  wf.edges = wf.edges.map(e => e.id === 'ok' ? { ...e, to: 'm' } : e)
  wf.edges.push({ id: 'merged', from: 'm', outcome: 'ok', to: 'w' })
  const f = fixture(wf); const infos = agents.map(a => ({ ...a, enabled: false }))
  assert.throws(() => prepare(f, {}, infos), { message: 'agent.disabled' })
  assert.equal(f.store.getTask(f.task.id)!.stage!.nodeId, 'm')
  assert.equal(f.store.snapshot().dispatches.length, 0)
})

for (const first of ['human', 'end', 'blocked', 'merge'] as const) {
  it(`guarded first ${first} не пропускает обычного воркера мимо графа`, () => {
    const wf = graph('work', 'reviewer')
    wf.edges[0] = { ...wf.edges[0], to: 'first' }
    if (first !== 'blocked') wf.nodes.push({ id: 'first', type: first, x: 0, y: 0 })
    if (first === 'merge') wf.edges.push({ id: 'm', from: 'first', outcome: 'ok', to: 'w' })
    const f = fixture(wf)
    assert.throws(() => prepare(f), first === 'merge' ? { message: 'agent.disabled' } : /воркер не запущен/)
    assert.equal(f.store.snapshot().dispatches.length, 0)
    if (first === 'human') { assert.equal(f.store.pendingRequests().length, 1); assert.equal(f.store.getTask(f.task.id)!.stage!.nodeId, 'first') }
    if (first === 'end') assert.equal(f.store.getTask(f.task.id)!.status, 'done')
    if (first === 'blocked') assert.ok(f.store.getTask(f.task.id)!.stageBlock)
    if (first === 'merge') assert.equal(f.store.getTask(f.task.id)!.stage!.nodeId, 'first')
  })
}
