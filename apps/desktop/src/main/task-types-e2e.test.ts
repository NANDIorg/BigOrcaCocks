// Запуск: pnpm --filter @orca-board/desktop test. Сквозные сценарии типов задач на настоящем git-репозитории,
// настоящем ProjectManager (projects.json, доски в boards/) и исполнителе воркфлоу. PTY не участвуют: запуск
// воркера и координатора — фейки, повторяющие контракт main (index.ts: `runWorker` → `ctx(p.id, task.runId)` →
// `startWorker` из worker.ts, `runCoordinator` → `runType` / `resolveRun`, `workflowDeps`). Фейк записывает, с
// какой ролью, агентом и моделью стартовал бы агент, — это и проверяется.
// Тесты с `todo` — найденные дефекты: падают по фактическому поведению, но не валят прогон.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, builtinTaskType, defaultWorkflow,
  type Role, type Task, type Workflow
} from '@orca-board/core'
import { enterWork, handleWorkflowEvents, reviewAccept, reviewReject, approvalResolved, type WorkflowDeps } from './workflow'
import { resolveHumanRequest } from './review'
import { ProjectManager, PROJECTS_BACKUP_NAME, runnableWorkflow } from './projects'
import { PROJECTS_FILE_VERSION, legacyTaskTypeId } from './task-types-migration'
import { jsonPersistence } from './persistence'
import { missingRoleMessage } from './agents'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

const PID = 'p1'
const LEGACY_TID = legacyTaskTypeId(PID)

let tmp: string
let repo: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-types-e2e-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** С какой ролью, агентом и моделью стартовал агент (то, что worker.ts передаёт в `spec.invoke`). */
interface Launch {
  kind: 'worker' | 'coordinator'
  taskId?: string
  runId?: string
  roleId: string
  agent: string
  model?: string
}

/** Тип прогона глазами исполнителя: роли и граф (для прогона без снимка графа). */
type TypeOf = (runId: string | undefined) => { roles: Role[]; workflow?: Workflow }

interface Harness {
  store: TaskStore
  deps: WorkflowDeps
  launches: Launch[]
  task(id: string): Task
  /** Рабочая задача, запущенная приложением (`worker start`). */
  work(title: string, roleId: string, runId?: string): Task
  /** Коммит в ветке задачи. */
  commit(taskId: string, file: string): void
  /** `orca-board done` текущего запуска и доставка событий исполнителю (подписка в index.ts). */
  done(taskId: string): void
  gates(taskId: string): Task[]
  lastLaunch(taskId: string): Launch
}

/**
 * Исполнитель над store и репозиторием. `typeOf` — откуда роли и граф: у нового кода — `projects.resolveRun`
 * (как `workflowDeps` в index.ts), у «старого кода» в сценарии миграции — роли проекта.
 */
function harness(store: TaskStore, typeOf: TypeOf): Harness {
  const launches: Launch[] = []
  const task = (id: string): Task => store.getTask(id)!
  const deps: WorkflowDeps = {
    store,
    repoRoot: repo,
    run: typeOf,
    // Как runWorker + startWorker: роль задачи — из типа её прогона, иначе ошибка; enterWork; worktree; dispatch.
    startWorker(taskId) {
      const t0 = task(taskId)
      if (store.columnKind(t0.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
      const roles0 = typeOf(t0.runId).roles
      if (!roles0.some((r) => r.id === t0.roleId)) throw new Error(`воркер не запустится: ${missingRoleMessage(t0.roleId, roles0)}`)
      enterWork(deps, taskId)
      const t = task(taskId)
      const role = typeOf(t.runId).roles.find((r) => r.id === t.roleId)
      if (!role) throw new Error(`воркер не запустится: ${missingRoleMessage(t.roleId, typeOf(t.runId).roles)}`)
      const branch = `orca/${t.id}`
      const worktree = path.join(tmp, 'wt', t.id)
      if (!existsSync(worktree)) {
        const exists = git(repo, 'branch', '--list', branch) !== ''
        git(repo, 'worktree', 'add', '-q', ...(exists ? [worktree, branch] : ['-b', branch, worktree]))
      }
      store.updateTask(t.id, { agent: role.agent, worktree, branch })
      launches.push({ kind: 'worker', taskId: t.id, runId: t.runId, roleId: role.id, agent: role.agent, ...(role.model ? { model: role.model } : {}) })
      const d = store.startDispatch(t.id, `pty_${t.id}_${launches.length}`)
      return { ptyId: d.ptyId, dispatchId: d.id }
    }
  }
  return {
    store,
    deps,
    launches,
    task,
    work(title, roleId, runId) {
      const t = store.createTask({ title, roleId, ...(runId ? { runId } : {}) })
      deps.startWorker(t.id)
      return task(t.id)
    },
    commit(taskId, file) {
      const wt = task(taskId).worktree!
      writeFileSync(path.join(wt, file), `${file}\n`)
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', file)
    },
    done(taskId) {
      const before = store.listEvents().length
      store.finishDispatch(task(taskId).dispatchId!, 'сделал', [])
      handleWorkflowEvents(deps, store.listEvents().slice(before))
    },
    gates: (taskId) => store.listTasks().filter((t) => t.gateFor?.taskId === taskId),
    lastLaunch(taskId) {
      const l = launches.filter((x) => x.taskId === taskId).at(-1)
      assert.ok(l, `агент задачи ${taskId} не запускался`)
      return l
    }
  }
}

/** Исполнитель нового кода: роли и граф — тип прогона из ProjectManager (`workflowDeps` в index.ts). */
function appHarness(pm: ProjectManager, projectId: string): Harness {
  return harness(pm.store(projectId), (runId) => {
    const t = pm.resolveRun(projectId, runId)
    const workflow = runnableWorkflow(t.workflow)
    return { roles: t.roles, ...(workflow ? { workflow } : {}) }
  })
}

/** Роль координатора нового прогона (`runCoordinator` без runId → `startCoordinator`): тип и прогон в store. */
function startCoordinator(pm: ProjectManager, h: Harness, projectId: string, objective: string, typeId?: string): string {
  const type = pm.runType(projectId, typeId)
  const role = pm.resolveType(projectId, type.typeId).roles.find((r) => r.id === 'coordinator')
  if (!role) throw new Error(`координатор не запустится: ${missingRoleMessage('coordinator', pm.resolveType(projectId, type.typeId).roles)}`)
  const run = h.store.createRun(objective, undefined, type)
  h.store.setRunPty(run.id, `pty_coord_${run.id}`, role.agent)
  h.launches.push({ kind: 'coordinator', runId: run.id, roleId: role.id, agent: role.agent, ...(role.model ? { model: role.model } : {}) })
  return run.id
}

/** Роль координатора при повторном запуске (`runCoordinator` с runId → `ctx(p.id, runId)`). */
function coordinatorOf(pm: ProjectManager, projectId: string, runId: string): Role | undefined {
  return pm.resolveRun(projectId, runId).roles.find((r) => r.id === 'coordinator')
}

const merged = (file: string): boolean => existsSync(path.join(repo, file))
const brief = (l: Launch): Pick<Launch, 'roleId' | 'agent' | 'model'> => ({ roleId: l.roleId, agent: l.agent, ...(l.model ? { model: l.model } : {}) })

/** Роли проекта старого формата: ревьюер на codex, QA на sonnet. */
const LEGACY_ROLES: Role[] = DEFAULT_ROLES.map((r) =>
  r.id === 'reviewer' ? { ...r, agent: 'codex', model: 'gpt-5-codex' } : r.id === 'qa' ? { ...r, model: 'sonnet' } : { ...r }
)

/** Дефолтный граф, но проверка — гейт QA вместо ревьюера. */
function qaWorkflow(roles: readonly Role[] = DEFAULT_ROLES): Workflow {
  const wf = defaultWorkflow([...roles])
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === 'review' ? { id: 'review', type: 'gate', roleId: 'qa', x: n.x, y: n.y } : n)) }
}

/** projects.json старого формата: настройки в проекте, шаблоны, `defaults`, без `version`. */
function legacyProjectsJson(): string {
  return JSON.stringify({
    projects: [{
      id: PID, root: repo, name: 'repo',
      roles: LEGACY_ROLES, workflow: qaWorkflow(LEGACY_ROLES), agentRules: 'правила проекта', permissionMode: 'acceptEdits',
      templateId: 'backend'
    }],
    activeId: PID,
    templates: [{ id: 'tpl_mine', title: 'Мой шаблон', settings: { columns: DEFAULT_COLUMNS, enabledAgents: ['claude'], agentRules: 'шаблон' } }],
    defaultTemplateId: 'tpl_mine',
    defaults: { permissionMode: 'bypassPermissions' }
  }, null, 2)
}

/** Доска «старым кодом»: store без типов, роли — проекта (`projects.roles`), граф прогона — снимок графа проекта. */
function legacyBoard(): Harness {
  const store = new TaskStore(jsonPersistence(path.join(tmp, 'user', 'boards', `${PID}.json`)), () => DEFAULT_COLUMNS)
  return harness(store, () => ({ roles: LEGACY_ROLES }))
}

function newProjectManager(): ProjectManager {
  return new ProjectManager(path.join(tmp, 'user'))
}

function writeLegacyProjects(): string {
  const text = legacyProjectsJson()
  mkdirSync(path.join(tmp, 'user'), { recursive: true })
  writeFileSync(path.join(tmp, 'user', 'projects.json'), text)
  return text
}

describe('сценарий 1: старый projects.json и доска со старыми прогонами после обновления', () => {
  it('миграция без потерь: открытый dispatch, задача на гейте, прогон без графа и «Входящие» доходят до мержа по ролям типа «repo»', () => {
    // --- Старая версия приложения: доска проекта. ---
    const old = legacyBoard()
    // Прогон A снят, когда граф проекта был дефолтным (гейт reviewer); потом человек поменял граф проекта на гейт QA.
    const runA = old.store.createRun('Прогон A', undefined, defaultWorkflow(LEGACY_ROLES)).id
    const runB = old.store.createRun('Прогон B (до воркфлоу)').id
    assert.equal(old.store.getRun(runB)?.workflow, undefined)
    const a1 = old.work('A1: в работе', 'developer', runA)
    old.commit(a1.id, 'a1.txt')
    const a2 = old.work('A2: на гейте', 'developer', runA)
    old.commit(a2.id, 'a2.txt')
    old.done(a2.id)
    assert.equal(old.task(a2.id).status, 'review')
    const [oldGate] = old.gates(a2.id)
    assert.equal(oldGate.agent, 'codex', 'старый гейт — ревьюер проекта')
    // Вопрос воркера ждёт живого координатора — после рестарта координаторов нет.
    const a3 = old.work('A3: с вопросом', 'developer', runA)
    const q = old.store.ask({ taskId: a3.id, dispatchId: old.task(a3.id).dispatchId, question: 'Какой вариант?' }, { coordinatorAlive: true })
    const b1 = old.store.createTask({ title: 'B1: готова', roleId: 'developer', runId: runB })
    const i1 = old.store.createTask({ title: 'Входящая', roleId: 'developer' })
    const inboxId = old.task(i1.id).runId!
    const legacyText = writeLegacyProjects()

    // --- Новая версия: миграция projects.json при старте. ---
    const pm = newProjectManager()
    const saved = JSON.parse(readFileSync(path.join(tmp, 'user', 'projects.json'), 'utf8')) as Record<string, unknown>
    assert.equal(saved.version, PROJECTS_FILE_VERSION)
    assert.equal(readFileSync(path.join(tmp, 'user', PROJECTS_BACKUP_NAME), 'utf8'), legacyText, 'бэкап — исходный файл')
    const project = pm.get(PID)!
    assert.equal(project.defaultTaskTypeId, LEGACY_TID)
    assert.equal(project.legacyTypeId, LEGACY_TID)
    assert.equal(project.taskTypeIds, undefined, 'доступны все типы библиотеки')
    for (const k of ['roles', 'workflow', 'agentRules', 'permissionMode', 'templateId']) assert.equal(k in project, false, k)
    const legacyType = pm.taskType(LEGACY_TID)!
    assert.equal(legacyType.title, 'repo')
    assert.deepEqual(legacyType.settings.roles?.map((r) => [r.id, r.agent, r.model]), LEGACY_ROLES.map((r) => [r.id, r.agent, r.model]))
    assert.deepEqual(legacyType.settings.workflow, qaWorkflow(LEGACY_ROLES))
    assert.equal(legacyType.settings.agentRules, 'правила проекта')
    assert.equal(legacyType.settings.permissionMode, 'acceptEdits')
    assert.equal(pm.taskType('tpl_mine')?.settings.agentRules, 'шаблон', 'шаблон стал типом')
    assert.equal('columns' in (pm.taskType('tpl_mine')?.settings ?? {}), false)
    assert.equal(pm.defaultTaskTypeId(), 'tpl_mine')

    // --- Первая загрузка доски: старые прогоны получают тип «repo», «Входящие» — нет. ---
    const h = appHarness(pm, PID)
    for (const runId of [runA, runB]) {
      assert.equal(h.store.getRun(runId)?.typeId, LEGACY_TID, runId)
      assert.equal(h.store.getRun(runId)?.taskType?.title, 'repo')
      assert.equal(h.store.getGlobalTask(runId).typeTitle, 'repo')
    }
    assert.equal(h.store.getRun(inboxId)?.typeId, undefined)
    assert.deepEqual(h.store.getRun(runA)?.workflow, defaultWorkflow(LEGACY_ROLES), 'снимок графа прогона не тронут')
    assert.equal(h.store.getRun(runB)?.workflow, undefined)
    // Окружение агентов прогона (ctx) — бывшие настройки проекта.
    const ctxA = pm.resolveRun(PID, runA)
    assert.equal(ctxA.source, 'type')
    assert.equal(ctxA.agentRules, 'правила проекта')
    assert.equal(ctxA.permissionMode, 'acceptEdits')
    // Вопрос, ждавший координатора, ушёл человеку.
    assert.ok(h.store.pendingRequests().some((r) => r.questionId === q.id), 'вопрос без координатора — запрос человеку')

    // Открытый dispatch: done → гейт по снимку графа прогона A (reviewer) с ревьюером типа → accept → мерж.
    h.done(a1.id)
    const [gateA1] = h.gates(a1.id)
    assert.equal(gateA1.roleId, 'reviewer')
    assert.deepEqual(brief(h.lastLaunch(gateA1.id)), { roleId: 'reviewer', agent: 'codex', model: 'gpt-5-codex' })
    reviewAccept(h.deps, a1.id)
    assert.equal(h.task(a1.id).status, 'done')
    assert.ok(merged('a1.txt'), 'a1 слита')
    h.done(gateA1.id)
    assert.equal(h.task(gateA1.id).status, 'done')

    // Задача на гейте со старой проверкой: accept → мерж, старая проверка закрывается своим done.
    reviewAccept(h.deps, a2.id)
    assert.equal(h.task(a2.id).status, 'done')
    assert.ok(merged('a2.txt'), 'a2 слита')
    h.done(oldGate.id)
    assert.equal(h.task(oldGate.id).status, 'done')

    // Прогон без снимка графа — граф типа «repo» (гейт QA на sonnet).
    h.deps.startWorker(b1.id)
    assert.deepEqual(brief(h.lastLaunch(b1.id)), { roleId: 'developer', agent: 'claude' })
    h.commit(b1.id, 'b1.txt')
    h.done(b1.id)
    const [gateB1] = h.gates(b1.id)
    assert.equal(gateB1.roleId, 'qa')
    assert.deepEqual(brief(h.lastLaunch(gateB1.id)), { roleId: 'qa', agent: 'claude', model: 'sonnet' })
    reviewAccept(h.deps, b1.id)
    assert.equal(h.task(b1.id).status, 'done')
    assert.ok(merged('b1.txt'))

    // «Входящие» — тип проекта по умолчанию, то есть тот же «repo» и его граф (изменение поведения, docs).
    assert.equal(pm.resolveRun(PID, inboxId).typeId, LEGACY_TID)
    h.deps.startWorker(i1.id)
    h.commit(i1.id, 'i1.txt')
    h.done(i1.id)
    assert.equal(h.gates(i1.id)[0]?.roleId, 'qa')
    reviewAccept(h.deps, i1.id)
    assert.ok(merged('i1.txt'))

    // Повторный старт: миграция не повторяется, файл не переписывается, типы прогонов те же.
    const text = readFileSync(path.join(tmp, 'user', 'projects.json'), 'utf8')
    const pm2 = newProjectManager()
    assert.equal(readFileSync(path.join(tmp, 'user', 'projects.json'), 'utf8'), text)
    assert.equal(pm2.store(PID).getRun(runA)?.typeId, LEGACY_TID)
    assert.equal(pm2.store(PID).getRun(inboxId)?.typeId, undefined)
    assert.equal(pm2.taskTypes().filter((t) => t.title === 'repo').length, 1, 'второй тип «repo» не появился')
  })
})

describe('сценарий 2: один проект, две глобальные задачи разных типов', () => {
  it('«Документация» и «Бэкенд»: у координаторов и воркеров свои агенты и модели, у задач свои графы', () => {
    const pm = newProjectManager()
    const pid = pm.add(repo).id
    // Исполнителя встроенного типа меняют на месте (решение 1 координатора).
    const docs = builtinTaskType('docs')!
    pm.saveTaskType({
      id: 'docs', title: docs.title, description: docs.description,
      settings: {
        ...docs.settings,
        roles: docs.settings.roles!.map((r) =>
          r.id === 'coordinator' ? { ...r, agent: 'codex', model: 'gpt-5.5' } : r.id === 'writer' ? { ...r, model: 'haiku' } : r)
      }
    })
    const backend = builtinTaskType('backend')!
    pm.saveTaskType({
      id: 'backend', title: backend.title, description: backend.description,
      settings: { ...backend.settings, roles: backend.settings.roles!.map((r) => (r.id === 'coordinator' ? { ...r, model: 'opus' } : r)) }
    })
    const h = appHarness(pm, pid)

    const runD = startCoordinator(pm, h, pid, 'Описать API', 'docs')
    const runB = startCoordinator(pm, h, pid, 'Сделать API', 'backend')
    const coords = h.launches.filter((l) => l.kind === 'coordinator')
    assert.deepEqual(coords.map(brief), [
      { roleId: 'coordinator', agent: 'codex', model: 'gpt-5.5' },
      { roleId: 'coordinator', agent: 'claude', model: 'opus' }
    ])
    assert.equal(h.store.getGlobalTask(runD).typeId, 'docs')
    assert.equal(h.store.getGlobalTask(runD).typeTitle, docs.title)
    assert.equal(h.store.getGlobalTask(runB).typeId, 'backend')
    // Повторный запуск координатора — тоже роль типа своего прогона.
    assert.equal(coordinatorOf(pm, pid, runD)?.agent, 'codex')
    assert.equal(coordinatorOf(pm, pid, runB)?.model, 'opus')

    // Роли — только типа своего прогона: программиста у «Документации» нет.
    const stray = h.store.createTask({ title: 'Код в доках', roleId: 'developer', runId: runD })
    assert.throws(() => h.deps.startWorker(stray.id), /роли «developer» нет/)
    assert.equal(h.task(stray.id).status, stray.status, 'воркер не стартовал, задача не сдвинулась')
    assert.equal(h.task(stray.id).dispatchId, undefined)

    const d1 = h.work('Страница API', 'writer', runD)
    const b1 = h.work('Ручка /users', 'developer', runB)
    assert.deepEqual(brief(h.lastLaunch(d1.id)), { roleId: 'writer', agent: 'claude', model: 'haiku' })
    assert.deepEqual(brief(h.lastLaunch(b1.id)), { roleId: 'developer', agent: 'claude' })
    assert.equal(pm.resolveRun(pid, runB).agentRules, backend.settings.agentRules, 'правила агентов — типа прогона')
    assert.equal(pm.resolveRun(pid, runD).agentRules, '')
    h.commit(d1.id, 'api.md')
    h.commit(b1.id, 'users.ts')
    h.done(d1.id)
    h.done(b1.id)

    // «Документация»: ревью человеком, без агентной проверки.
    assert.equal(h.task(d1.id).stage?.nodeId, 'review')
    assert.deepEqual(h.gates(d1.id), [])
    const approval = h.store.pendingRequests().find((r) => r.taskId === d1.id && r.kind === 'approval')
    assert.ok(approval, 'запрос человеку на ревью')
    resolveHumanRequest(h.store, repo, approval.id, { action: 'accept' }, h.deps.startWorker, (r) => approvalResolved(h.deps, r))
    assert.equal(h.task(d1.id).status, 'done')
    assert.ok(merged('api.md'))

    // «Бэкенд»: гейт ревьюера на opus, затем гейт QA, затем мерж.
    assert.equal(h.store.pendingRequests().some((r) => r.taskId === b1.id), false)
    const [review] = h.gates(b1.id)
    assert.deepEqual(brief(h.lastLaunch(review.id)), { roleId: 'reviewer', agent: 'claude', model: 'opus' })
    reviewAccept(h.deps, b1.id)
    assert.equal(h.task(b1.id).stage?.nodeId, 'tests')
    const tests = h.gates(b1.id).at(-1)!
    assert.equal(tests.roleId, 'qa')
    reviewAccept(h.deps, b1.id)
    assert.equal(h.task(b1.id).status, 'done')
    assert.ok(merged('users.ts'))
  })

  it('гейт берёт проверяющего из типа прогона: два одновременных прогона, ревьюеры на разных агентах и моделях', () => {
    const pm = newProjectManager()
    const pid = pm.add(repo).id
    const withReviewer = (patch: Partial<Role>): Role[] => DEFAULT_ROLES.map((r) => (r.id === 'reviewer' ? { ...r, ...patch } : { ...r }))
    const ta = pm.saveTaskType({ title: 'Ревью Claude', settings: { roles: withReviewer({ agent: 'claude', model: 'opus' }) } })
    const tb = pm.saveTaskType({ title: 'Ревью Codex', settings: { roles: withReviewer({ agent: 'codex', model: 'gpt-5.5' }) } })
    const h = appHarness(pm, pid)
    const runA = h.store.createGlobalTask({ title: 'A', type: pm.runType(pid, ta.id) }).id
    const runB = h.store.createGlobalTask({ title: 'B', type: pm.runType(pid, tb.id) }).id

    const a = h.work('Задача A', 'developer', runA)
    const b = h.work('Задача B', 'developer', runB)
    h.commit(a.id, 'a.txt')
    h.commit(b.id, 'b.txt')
    // Вперемешку: B сдаёт первой, A — второй, пока проверка B ещё идёт.
    h.done(b.id)
    h.done(a.id)
    const [gateA] = h.gates(a.id)
    const [gateB] = h.gates(b.id)
    assert.equal(gateA.agent, 'claude')
    assert.equal(gateB.agent, 'codex')
    assert.deepEqual(brief(h.lastLaunch(gateA.id)), { roleId: 'reviewer', agent: 'claude', model: 'opus' })
    assert.deepEqual(brief(h.lastLaunch(gateB.id)), { roleId: 'reviewer', agent: 'codex', model: 'gpt-5.5' })

    // Роли живые: смена модели ревьюера типа B действует на следующую проверку B и не трогает A.
    pm.patchTaskType(tb.id, { roles: withReviewer({ agent: 'codex', model: 'gpt-5.5-mini' }) })
    reviewReject(h.deps, b.id, 'нет тестов')
    h.done(gateB.id)
    h.commit(b.id, 'b-test.txt')
    h.done(b.id)
    const gateB2 = h.gates(b.id).at(-1)!
    assert.notEqual(gateB2.id, gateB.id)
    assert.deepEqual(brief(h.lastLaunch(gateB2.id)), { roleId: 'reviewer', agent: 'codex', model: 'gpt-5.5-mini' })
    assert.equal(pm.resolveRun(pid, runA).roles.find((r) => r.id === 'reviewer')?.model, 'opus')

    reviewAccept(h.deps, a.id)
    reviewAccept(h.deps, b.id)
    assert.ok(merged('a.txt') && merged('b.txt') && merged('b-test.txt'))
  })
})

describe('сценарий 3: тип удалён посреди прогона', () => {
  it('воркер, проверка и координатор стартуют по снимку типа; граф — снимок прогона', () => {
    const pm = newProjectManager()
    const pid = pm.add(repo).id
    const roles = DEFAULT_ROLES.map((r) =>
      r.id === 'developer' ? { ...r, agent: 'codex' as const, model: 'gpt-5-codex' } : r.id === 'coordinator' ? { ...r, model: 'opus' } : { ...r })
    const t = pm.saveTaskType({ title: 'Временный', settings: { roles, workflow: qaWorkflow(roles), agentRules: 'правила типа', permissionMode: 'acceptEdits' } })
    const h = appHarness(pm, pid)
    const runId = startCoordinator(pm, h, pid, 'Цель', t.id)
    const t1 = h.work('Первая', 'developer', runId)
    assert.deepEqual(brief(h.lastLaunch(t1.id)), { roleId: 'developer', agent: 'codex', model: 'gpt-5-codex' })

    pm.deleteTaskType(t.id)
    assert.equal(pm.taskType(t.id), undefined)
    const r = pm.resolveRun(pid, runId)
    assert.equal(r.source, 'snapshot')
    assert.equal(r.typeId, t.id)
    assert.equal(r.agentRules, 'правила типа')
    assert.equal(r.permissionMode, 'acceptEdits')
    assert.equal(h.store.getGlobalTask(runId).typeTitle, 'Временный')
    assert.equal(coordinatorOf(pm, pid, runId)?.model, 'opus', 'повторный запуск координатора — по снимку')

    const t2 = h.work('Вторая', 'developer', runId)
    assert.deepEqual(brief(h.lastLaunch(t2.id)), { roleId: 'developer', agent: 'codex', model: 'gpt-5-codex' })
    h.commit(t1.id, 't1.txt')
    h.done(t1.id)
    const [gate] = h.gates(t1.id)
    assert.equal(gate?.roleId, 'qa', 'граф — снимок прогона (гейт QA), а не дефолтный по ролям')
    reviewAccept(h.deps, t1.id)
    assert.equal(h.task(t1.id).status, 'done')
    assert.ok(merged('t1.txt'))

    // Новую глобальную задачу удалённого типа не создать.
    assert.throws(() => pm.runType(pid, t.id), /не найден/)
  })
})

describe('сценарий 4: тип проекта по умолчанию сменили до первой загрузки доски', () => {
  it('старые прогоны всё равно получают тип «repo» (legacyTypeId), «Входящие» — новый тип по умолчанию', () => {
    const old = legacyBoard()
    const runId = old.store.createRun('Старый прогон', undefined, defaultWorkflow(LEGACY_ROLES)).id
    const t = old.store.createTask({ title: 'Старая задача', roleId: 'developer', runId })
    const i = old.store.createTask({ title: 'Входящая', roleId: 'writer' })
    const inboxId = old.task(i.id).runId!
    writeLegacyProjects()

    const pm = newProjectManager()
    // Человек успел сменить типы проекта, не открывая доску: тип «repo» даже недоступен для новых задач.
    pm.setProjectTaskTypes(PID, { typeIds: ['docs'], defaultTypeId: 'docs' })
    assert.equal(pm.get(PID)?.legacyTypeId, LEGACY_TID)

    const h = appHarness(pm, PID)
    assert.equal(h.store.getRun(runId)?.typeId, LEGACY_TID)
    assert.equal(pm.resolveRun(PID, runId).roles.find((r) => r.id === 'reviewer')?.agent, 'codex', 'роли — бывшие роли проекта')
    assert.equal(pm.resolveRun(PID, inboxId).typeId, 'docs')
    h.deps.startWorker(t.id)
    assert.deepEqual(brief(h.lastLaunch(t.id)), { roleId: 'developer', agent: 'claude' })
    h.deps.startWorker(i.id)
    assert.deepEqual(brief(h.lastLaunch(i.id)), { roleId: 'writer', agent: 'claude', model: 'sonnet' })
  })

  it('тип «repo» удалили до первой загрузки доски: старые прогоны сохраняют роли проекта', {
    todo: 'дефект: прогоны незагруженной доски не получают ни тип, ни снимок и молча уходят на тип проекта по умолчанию'
  }, () => {
    const old = legacyBoard()
    const runId = old.store.createRun('Старый прогон', undefined, defaultWorkflow(LEGACY_ROLES)).id
    const t = old.store.createTask({ title: 'Старая задача', roleId: 'developer', runId })
    writeLegacyProjects()

    const pm = newProjectManager()
    pm.setProjectTaskTypes(PID, { defaultTypeId: 'docs' })
    pm.deleteTaskType(LEGACY_TID)
    const h = appHarness(pm, PID)
    // Ожидаемое: прогон помечен типом «repo» со снимком (как прогон удалённого типа) и идёт по ролям проекта.
    // Фактическое: typeId нет, роли — «Документации», у которой нет программиста, воркер не стартует.
    assert.equal(h.store.getRun(runId)?.typeId, LEGACY_TID)
    assert.equal(pm.resolveRun(PID, runId).roles.find((r) => r.id === 'reviewer')?.agent, 'codex')
    assert.doesNotThrow(() => h.deps.startWorker(t.id))
  })
})

describe('тексты ошибок после переноса ролей в типы задач', () => {
  it('нет роли: ошибка говорит о типе задачи и не ведёт в «О проекте → Роли»', {
    todo: 'дефект: missingRoleMessage (agents.ts) всё ещё пишет «нет в проекте» и советует «О проекте» → «Роли», а этого раздела больше нет'
  }, () => {
    const text = missingRoleMessage('reviewer', DEFAULT_ROLES.filter((r) => r.id !== 'reviewer'))
    assert.doesNotMatch(text, /нет в проекте/)
    assert.doesNotMatch(text, /О проекте/)
    assert.match(text, /тип/)
  })
})
