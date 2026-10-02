import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, validateAttachments, type AgentKind, type Role } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import type { PtyFactory, PtyProcess } from '../src/sessions.ts'
import type { WorkerHostContext } from '../src/workers.ts'
import { messages, resources, HostError } from './execution-test-host.ts'

class TestProcess implements PtyProcess {
  data: (value: string) => void = () => {}
  exit: (value: { exitCode: number }) => void = () => {}
  killed = false
  onData(fn: (value: string) => void): void { this.data = fn }
  onExit(fn: (value: { exitCode: number }) => void): void { this.exit = fn }
  write(): void {}
  resize(): void {}
  kill(): void { this.killed = true; this.exit({ exitCode: 130 }) }
}

let dir: string
let repo: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-worker-')))
  repo = join(dir, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function fixture(overrides: Partial<WorkerHostContext> = {}) {
  assert.equal(typeof runtime.createWorkerServices, 'function', 'Запуск агентов доступен без Electron')
  const processes: Array<{ command: string; args: string[] | string; options: Parameters<PtyFactory>[2]; proc: TestProcess }> = []
  let failSpawn = false
  const sessions = runtime.createSessionRegistry({ spawn: (command, args, options) => {
    if (failSpawn) throw new Error('native spawn failed')
    const proc = new TestProcess(); processes.push({ command, args, options, proc }); return proc
  } })
  const launcher = runtime.createAgentLauncher({ settingsInvalid: path => new Error(path) })
  const platform = overrides.platform ?? process.platform
  const host: WorkerHostContext = {
    dataDir: join(dir, 'profile'), cliBinDir: join(dir, 'cli'), nodePath: '/test/node',
    prompts: { worker: 'WORKER_SKILL', coordinator: 'COORDINATOR_SKILL', assistant: 'ASSISTANT_SKILL' },
    language: () => 'en', shell: () => platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    extraPathDirs: () => ['/agents'], env: { PATH: '/bin' }, platform,
    launchOptions: () => ({ platform, home: dir, tempRoot: dir, env: {}, findBin: bin => join(dir, `${bin}.exe`) }),
    ...overrides
  }
  const common = resources()
  const services = runtime.createWorkerServices({ host, resources: common, messages, sessions, launcher })
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const ctx: runtime.WorkerEnvContext = { socketPath: join(dir, 'orca.sock'), projectId: 'project_one', permissionMode: 'auto', roles: DEFAULT_ROLES, typeTitle: 'General' }
  return { host, services, common, sessions, launcher, processes, store, ctx, fail: () => { failSpawn = true } }
}

function argsOf(process: ReturnType<typeof fixture>['processes'][number]): string[] {
  assert.ok(Array.isArray(process.args)); return process.args
}

it('воркер сохраняет dispatch, ветку, session id и явное окружение проекта', () => {
  const f = fixture(); const run = f.store.createGlobalTask({ title: 'Feature' })
  const task = f.store.createTask({ title: 'Implement', spec: 'Fix login', roleId: 'developer', runId: run.id })
  const result = f.services.startWorker(f.store, repo, f.ctx, task.id, 100, 40)
  assert.equal(f.store.getTask(task.id)?.status, 'in_progress')
  assert.equal(result.branch, `orca/${task.id}`)
  assert.equal(git(result.worktree, 'branch', '--show-current'), result.branch)
  assert.equal(git(repo, 'branch', '--show-current'), 'master')
  const dispatch = f.store.snapshot().dispatches.find(d => d.id === result.dispatchId)!
  assert.equal(dispatch.ptyId, result.ptyId); assert.match(dispatch.sessionId!, /^[0-9a-f-]{36}$/)
  const launch = f.processes[0]
  assert.equal(launch.options.cols, 100); assert.equal(launch.options.rows, 40)
  assert.equal(launch.options.env.ORCA_DISPATCH_ID, result.dispatchId)
  assert.equal(launch.options.env.ORCA_TASK_ID, task.id)
  assert.equal(launch.options.env.ORCA_PROJECT, 'project_one')
  assert.equal(launch.options.env.ORCA_NODE, '/test/node')
  assert.equal(launch.options.env.ORCA_SOCKET, f.ctx.socketPath)
  assert.ok(argsOf(launch).some(arg => arg.includes('WORKER_SKILL')))
  assert.ok(argsOf(launch).some(arg => arg.includes('Fix login')))
  f.processes[0].proc.exit({ exitCode: 3 })
  assert.equal(f.sessions.isAlive(result.ptyId), false)
  assert.equal(f.store.snapshot().dispatches.find(d => d.id === result.dispatchId)?.outcome, 'failed')
  assert.ok(f.store.snapshot().dispatches.find(d => d.id === result.dispatchId)?.endedAt)
})

it('нет роли и испорченные флаги отвергаются до Git, dispatch и нового прогона', () => {
  const f = fixture(); const task = f.store.createTask({ title: 'Task', roleId: 'developer' })
  const before = f.store.snapshot()
  assert.throws(() => f.services.startWorker(f.store, repo, { ...f.ctx, roles: [] }, task.id), e => e instanceof HostError && e.key === 'worker.cannotStart')
  const badRoles = f.ctx.roles.map(role => ({ ...role, extraArgs: '--name "unfinished' }))
  assert.throws(() => f.services.startWorker(f.store, repo, { ...f.ctx, roles: badRoles }, task.id), e => e instanceof HostError && e.key === 'worker.cannotStart')
  assert.throws(() => f.services.startCoordinator(f.store, repo, { ...f.ctx, roles: [] }, 'goal'), e => e instanceof HostError && e.key === 'coordinator.cannotStart')
  assert.throws(() => f.services.startCoordinator(f.store, repo, { ...f.ctx, roles: badRoles }, 'goal'), e => e instanceof HostError && e.key === 'coordinator.cannotStart')
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(existsSync(join(dir, '.orca-worktrees')), false)
  assert.equal(f.processes.length, 0)
})

it('роль отдельного этапа меняет запуск, сохраняя роль и агента карточки', () => {
  const f = fixture()
  const roles: Role[] = [{ id: 'developer', title: 'Dev', agent: 'codex' }, { id: 'reviewer', title: 'Reviewer', agent: 'claude', model: 'review-model', extraArgs: '--verbose' }]
  const task = f.store.createTask({ title: 'Question', roleId: 'developer', agent: 'codex' })
  const result = f.services.startWorker(f.store, repo, { ...f.ctx, roles }, task.id, 80, 24, 'reviewer')
  assert.equal(f.store.getTask(task.id)?.roleId, 'developer'); assert.equal(f.store.getTask(task.id)?.agent, 'codex')
  const dispatch = f.store.snapshot().dispatches.find(d => d.id === result.dispatchId)!
  assert.equal(dispatch.roleId, 'reviewer'); assert.equal(dispatch.agent, 'claude'); assert.equal(dispatch.model, 'review-model')
  assert.ok(argsOf(f.processes[0]).includes('--verbose'))
})

it('повторный воркер получает прошлый ответ и уточнение человека', () => {
  const f = fixture(); const task = f.store.createTask({ title: 'Task', roleId: 'developer', answerFor: 'coordinator' })
  const old = f.store.startDispatch(task.id, 'pty_old'); f.store.finishDispatch(old.id, 'done', [], 'PREVIOUS_RESULT')
  f.store.reopenTask(task.id, 'HUMAN_FEEDBACK')
  f.services.startWorker(f.store, repo, f.ctx, task.id)
  const prompt = argsOf(f.processes[0]).join('\n')
  assert.match(prompt, /PREVIOUS_RESULT/); assert.match(prompt, /HUMAN_FEEDBACK/)
})

it('отписка observer сохраняет воркер, вывод и обработку exit', () => {
  const f = fixture(); const task = f.store.createTask({ title: 'Task', roleId: 'developer' })
  let seen = 0; const off = f.sessions.subscribe(() => { seen++ })
  const result = f.services.startWorker(f.store, repo, f.ctx, task.id)
  off(); const detachedCount = seen
  f.processes[0].proc.data('continued offline')
  assert.equal(f.sessions.isAlive(result.ptyId), true)
  assert.equal(f.sessions.terminalSnapshots()[0].tail, 'continued offline')
  assert.equal(f.processes[0].proc.killed, false); assert.equal(seen, detachedCount)
  f.processes[0].proc.exit({ exitCode: 7 })
  assert.equal(f.store.snapshot().dispatches[0].outcome, 'failed')
  assert.ok(f.store.snapshot().dispatches[0].endedAt)
})

it('host profiles, язык, PATH и сессии разных экземпляров независимы', () => {
  const a = fixture({ dataDir: join(dir, 'one'), cliBinDir: '/one/cli', env: { PATH: '/one/bin' }, language: () => 'ru', platform: 'linux' })
  const b = fixture({ dataDir: join(dir, 'two'), cliBinDir: '/two/cli', env: { PATH: '/two/bin' }, language: () => 'en', platform: 'linux', nodePath: undefined })
  const first = a.services.startAssistant({ socketPath: '/one/socket', settings: { agent: 'claude' } })
  const second = b.services.startAssistant({ socketPath: '/two/socket', settings: { agent: 'claude' } })
  assert.equal(a.processes[0].options.cwd, join(dir, 'one', 'assistant'))
  assert.equal(b.processes[0].options.cwd, join(dir, 'two', 'assistant'))
  assert.equal(a.processes[0].options.env.PATH, '/one/cli:/one/bin:/agents')
  assert.equal(b.processes[0].options.env.PATH, '/two/cli:/two/bin:/agents')
  assert.equal('ORCA_NODE' in b.processes[0].options.env, false)
  assert.ok(argsOf(a.processes[0]).every(arg => !arg.includes('The person uses the app in English')))
  assert.ok(argsOf(b.processes[0]).some(arg => arg.includes('English')))
  assert.equal(a.sessions.isAlive(second.ptyId), false); assert.equal(b.sessions.isAlive(first.ptyId), false)
  assert.equal('ORCA_PROJECT' in a.processes[0].options.env, false)
  assert.equal(a.store.listRuns().length, 0)
})

it('Windows PATH из переданного Path читается без учёта регистра', () => {
  const f = fixture({ platform: 'win32', cliBinDir: 'C:\\orca\\cli', env: { Path: 'C:\\node;C:\\tools' }, extraPathDirs: () => ['C:\\agents'] })
  assert.equal(f.services.workerPath(), 'C:\\orca\\cli;C:\\node;C:\\tools;C:\\agents')
})

it('Windows setup выполняется отдельным before и не теряет команду агента', () => {
  const f = fixture({ platform: 'win32' })
  writeFileSync(join(repo, 'package.json'), '{}'); writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0')
  git(repo, 'add', 'package.json', 'pnpm-lock.yaml'); git(repo, 'commit', '-qm', 'deps')
  const task = f.store.createTask({ title: 'Task', roleId: 'developer' })
  const result = f.services.startWorker(f.store, repo, f.ctx, task.id)
  assert.equal(f.processes[0].command, 'cmd.exe')
  assert.match(String(f.processes[0].args), /pnpm install/)
  assert.equal(f.store.getTask(task.id)?.status, 'in_progress')
  f.processes[0].proc.exit({ exitCode: 1 })
  assert.equal(f.processes.length, 2)
  assert.match(f.processes[1].command, /claude\.exe$/)
  assert.ok(argsOf(f.processes[1]).some(arg => arg.includes('WORKER_SKILL')))
  assert.equal(f.sessions.isAlive(result.ptyId), true)
})

it('Unix setup сохраняет аргументы агента с пробелом и одинарной кавычкой', () => {
  const f = fixture({ platform: 'linux' })
  writeFileSync(join(repo, 'package.json'), '{}'); writeFileSync(join(repo, 'package-lock.json'), '{}')
  git(repo, 'add', 'package.json', 'package-lock.json'); git(repo, 'commit', '-qm', 'deps')
  const roles = f.ctx.roles.map(role => ({ ...role, extraArgs: '--name "two words" --label "it\'s"' }))
  const task = f.store.createTask({ title: 'Task', roleId: 'developer' })
  f.services.startWorker(f.store, repo, { ...f.ctx, roles }, task.id)
  assert.equal(f.processes[0].command, '/bin/sh')
  const command = argsOf(f.processes[0])[1]
  assert.match(command, /npm ci/); assert.match(command, /'two words'/); assert.match(command, /'it'\\''s'/)
})

it('координатор получает сохранённые вложения первыми, новые следом', () => {
  const f = fixture(); const root = runtime.runImagesRoot(f.host.dataDir)
  const saved = validateAttachments([{ name: 'saved.txt', data: new TextEncoder().encode('saved') }])
  const pasted = validateAttachments([{ name: 'pasted.pdf', data: new TextEncoder().encode('pasted') }])
  const run = f.common.createTaskWithImages(f.store, root, f.ctx.projectId, { title: 'Goal' }, saved)
  const result = f.services.startCoordinator(f.store, repo, { ...f.ctx, runImagesRoot: root }, '', 90, 25, pasted, run.id)
  assert.equal(result.runId, run.id); assert.equal(f.store.listRuns().length, 1)
  const cwd = f.processes[0].options.cwd!
  const first = join(cwd, '.orca-attachments', run.id, 'file-1-saved.txt')
  const second = join(cwd, '.orca-attachments', run.id, 'file-2-pasted.pdf')
  assert.equal(readFileSync(first, 'utf8'), 'saved'); assert.equal(readFileSync(second, 'utf8'), 'pasted')
  const prompt = argsOf(f.processes[0]).at(-1)!
  assert.ok(prompt.indexOf(first) < prompt.indexOf(second)); assert.ok(prompt.includes(first))
  assert.equal(f.processes[0].options.env.ORCA_RUN_ID, run.id)
  assert.equal(f.processes[0].options.env.BASH_MAX_TIMEOUT_MS, '3600000')
  assert.equal(f.store.getRun(run.id)?.coordinatorPtyId, result.ptyId)
})

it('второй координатор существующего прогона отвергается до эффектов', () => {
  const f = fixture(); const first = f.services.startCoordinator(f.store, repo, f.ctx, 'Goal')
  const before = f.store.snapshot()
  assert.throws(() => f.services.startCoordinator(f.store, repo, f.ctx, '', 80, 24, [], first.runId), e => e instanceof HostError && e.key === 'coordinator.alreadyRunning')
  assert.deepEqual(f.store.snapshot(), before); assert.equal(f.processes.length, 1)
  assert.equal(f.sessions.isAlive(first.ptyId), true)
})

it('выход координатора передаёт его открытый вопрос человеку', () => {
  const f = fixture(); const coordinator = f.services.startCoordinator(f.store, repo, f.ctx, 'Goal')
  const task = f.store.createTask({ title: 'Question', roleId: 'developer', runId: coordinator.runId })
  const question = f.store.ask({ taskId: task.id, question: 'Which option?' }, { coordinatorAlive: true })
  assert.equal(f.store.pendingRequests().length, 0)
  f.processes[0].proc.exit({ exitCode: 0 })
  const request = f.store.pendingRequests().find(request => request.questionId === question.id)
  assert.ok(request); assert.equal(request.kind, 'question'); assert.equal(request.taskId, task.id)
  assert.equal(f.sessions.isAlive(coordinator.ptyId), false)
})

it('отказ native spawn закрывает новый прогон и удаляет его стартовые файлы', () => {
  const f = fixture(); f.fail()
  const files = validateAttachments([{ name: 'start.txt', data: new TextEncoder().encode('start') }])
  assert.throws(() => f.services.startCoordinator(f.store, repo, f.ctx, 'Goal', 80, 24, files), /native spawn failed/)
  const run = f.store.listRuns()[0]
  assert.ok(run.closedAt); assert.equal(f.sessions.listTerminals().length, 0)
  assert.equal(existsSync(join(run.git!.worktree!, '.orca-attachments', run.id)), false)
})

it('отказ повторного запуска сохраняет существующий прогон и вложения возврата', () => {
  const f = fixture(); const run = f.store.createGlobalTask({ title: 'Existing' })
  f.store.moveGlobalTask(run.id, 'review')
  const paths = f.common.returnRunWithImages(f.store, repo, run.id, [{ name: 'return.txt', data: new TextEncoder().encode('return') }], 'Fix', saved => {
    f.store.returnGlobalTask(run.id, 'Fix', saved); return saved
  })
  f.fail()
  const fresh = validateAttachments([{ name: 'start.txt', data: new TextEncoder().encode('start') }])
  assert.throws(() => f.services.startCoordinator(f.store, repo, f.ctx, '', 80, 24, fresh, run.id), /native spawn failed/)
  assert.equal(f.store.getRun(run.id)?.closedAt, undefined)
  assert.equal(readFileSync(paths[0], 'utf8'), 'return')
  assert.equal(existsSync(join(f.store.getRun(run.id)!.git!.worktree!, '.orca-attachments', run.id, 'file-1-start.txt')), false)
})

for (const invalidRole of ['missing', 'extraArgs'] as const) {
  it(`возврат в работу при ${invalidRole} сохраняет состояние и живого координатора`, () => {
    const f = fixture(); const first = f.services.startCoordinator(f.store, repo, f.ctx, 'Goal')
    f.store.moveGlobalTask(first.runId, 'review')
    const before = structuredClone(f.store.snapshot())
    const roles = invalidRole === 'missing'
      ? f.ctx.roles.filter(role => role.id !== 'coordinator')
      : f.ctx.roles.map(role => role.id === 'coordinator' ? { ...role, extraArgs: '--name "unfinished' } : role)
    assert.throws(() => f.services.returnToWork(f.store, repo, { ...f.ctx, roles }, first.runId, 'FIX_THIS'),
      e => e instanceof HostError && e.key === 'coordinator.cannotStart')
    assert.deepEqual(f.store.snapshot(), before)
    assert.equal(f.sessions.isAlive(first.ptyId), true)
    assert.equal(f.processes[0].proc.killed, false)
    assert.equal(f.processes.length, 1)
  })
}

it('возврат в работу останавливает старый терминал и продолжает тот же прогон', () => {
  const f = fixture(); const first = f.services.startCoordinator(f.store, repo, f.ctx, 'Goal')
  f.store.moveGlobalTask(first.runId, 'review')
  const resumed = f.services.returnToWork(f.store, repo, f.ctx, first.runId, 'FIX_THIS')
  assert.equal(resumed.runId, first.runId); assert.notEqual(resumed.ptyId, first.ptyId)
  assert.equal(f.sessions.isAlive(first.ptyId), false); assert.equal(f.processes[0].proc.killed, true)
  assert.equal(f.sessions.isAlive(resumed.ptyId), true)
  assert.ok(argsOf(f.processes.at(-1)!).some(arg => arg.includes('FIX_THIS')))
})

for (const kind of ['worker', 'coordinator', 'assistant'] as const) {
  function launch(f: ReturnType<typeof fixture>, agent: AgentKind) {
    const ctx = { ...f.ctx, roles: f.ctx.roles.map(role => ({ ...role, agent, extraArgs: '--label "two words"' })) }
    if (kind === 'assistant') return f.services.startAssistant({ socketPath: f.ctx.socketPath, settings: { agent, extraArgs: '--label "two words"' } })
    if (kind === 'coordinator') return f.services.startCoordinator(f.store, repo, ctx, 'Goal')
    const task = f.store.createTask({ title: 'Task', roleId: 'developer', agent })
    return f.services.startWorker(f.store, repo, ctx, task.id)
  }

  it(`${kind}: язык читается на каждом запуске, флаги и cleanup настроек Amp сохраняются`, () => {
    let language: 'ru' | 'en' = 'ru'
    const f = fixture({ platform: 'linux', language: () => language })
    const first = launch(f, 'amp')
    const args = argsOf(f.processes[0])
    assert.ok(args.includes('--label')); assert.ok(args.includes('two words'))
    assert.ok(args.every(arg => !arg.includes('The person uses the app in English')))
    const settings = args[args.indexOf('--settings-file') + 1]
    const config = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>
    assert.equal(config['amp.dangerouslyAllowAll'], false)
    f.sessions.killPty(first.ptyId)
    assert.equal(existsSync(settings), false)
    language = 'en'
    launch(f, 'amp')
    assert.ok(argsOf(f.processes.at(-1)!).some(arg => arg.includes('The person uses the app in English')))
    f.sessions.killAll(); f.launcher.dispose()
  })

  it(`${kind}: окружение permissions OpenCode проходит через launcher в PTY`, () => {
    const f = fixture({ platform: 'linux' })
    launch(f, 'opencode')
    const env = f.processes[0].options.env
    const permissions = JSON.parse(env.OPENCODE_PERMISSION) as { edit: Record<string, string>; bash: Record<string, string> }
    assert.equal(permissions.edit['*'], 'ask')
    assert.equal(permissions.bash['*'], 'ask')
    f.sessions.killAll()
  })
}
