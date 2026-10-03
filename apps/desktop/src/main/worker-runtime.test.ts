import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import * as pty from 'node-pty'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, TaskStore, type Workflow } from '@orca-board/core'
import { createAgentLauncher, createExecutionResources, createGitOperations, createSessionRegistry, createWorkerServices, createWorkflowServices, type RunWorkflowDeps } from '@orca-board/runtime'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Общий сервис не выполнил native шаг за 12 секунд')
    await delay(20)
  }
}

/** Настоящие Git/store/launcher/registry/PTY; только платный агент заменён тестовой программой. */
async function nativeScenario(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-worker-native-')))
  const repo = join(dir, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
  const messages = { error: (key: string) => new Error(key) }
  const operations = createGitOperations({ ...messages, untrackedLabel: () => 'Untracked:' })
  const resources = createExecutionResources({ messages, git: operations, logger: { warn: () => {} } })
  const launcher = createAgentLauncher({ settingsInvalid: path => new Error(path) })
  const sessions = createSessionRegistry({ spawn: (command, args, options) => {
    assert.equal(command, 'claude'); assert.ok(Array.isArray(args)); assert.ok(args.includes('--append-system-prompt'))
    return pty.spawn(process.execPath, ['-e', `
      let buffer = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => {
        buffer += chunk
        let at
        while ((at = buffer.search(/[\\r\\n]/)) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
          if (!line) continue
          process.stdout.write('ACK:' + line + '\\n')
          if (line === 'finish') process.exit(0)
        }
      })
      process.stdout.write('ROLE:' + (process.env.ORCA_ROLE ?? 'worker') + '\\nTASK:' + (process.env.ORCA_TASK_ID ?? '') + '\\n')
    `], options)
  } })
  const services = createWorkerServices({
    resources, messages, launcher, sessions,
    host: { dataDir: join(dir, 'profile'), cliBinDir: join(dir, 'cli'), nodePath: process.execPath,
      prompts: { worker: 'WORKER', coordinator: 'COORDINATOR', assistant: 'ASSISTANT' }, language: () => 'en',
      shell: () => process.env.COMSPEC ?? '/bin/sh', extraPathDirs: () => [],
      launchOptions: () => ({ platform: 'linux', home: dir, tempRoot: dir, env: {} }) }
  })
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const workflow: Workflow = { version: 1, nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 }, { id: 'work', type: 'work', x: 0, y: 0 },
    { id: 'human', type: 'human', x: 0, y: 0 }, { id: 'merge', type: 'merge', x: 0, y: 0 }, { id: 'end', type: 'end', x: 0, y: 0 }
  ], edges: [
    { id: 's', from: 'start', to: 'work', outcome: 'next' }, { id: 'w', from: 'work', to: 'human', outcome: 'next' },
    { id: 'h', from: 'human', to: 'merge', outcome: 'accept' }, { id: 'm', from: 'merge', to: 'end', outcome: 'ok' }
  ] }
  const ctx = { socketPath: join(dir, 'orca.sock'), projectId: 'native-project', permissionMode: 'auto' as const, roles: DEFAULT_ROLES, typeTitle: 'General', workflow }
  const workflows = createWorkflowServices({ resources, messages: {
    ...messages, text: key => key, displayError: error => error instanceof Error ? error.message : String(error)
  } })
  const deps: RunWorkflowDeps = { store, repoRoot: repo, run: () => ({ roles: DEFAULT_ROLES, workflow }),
    startWorker(taskId) { workflows.task.enterWork(deps, taskId); return services.startWorker(store, repo, ctx, taskId) },
    isAlive: sessions.isAlive, startCoordinator: runId => { services.startCoordinator(store, repo, ctx, '', undefined, undefined, [], runId) },
    mergeTarget: task => resources.mergeTarget(store, repo, task) }
  const binding = workflows.forProject(deps)
  try {
    const coordinator = services.startCoordinator(store, repo, ctx, 'Native feature')
    await waitFor(() => sessions.ptyTail(coordinator.ptyId).includes('ROLE:coordinator'))
    const task = store.createTask({ title: 'Native task', roleId: 'developer', runId: coordinator.runId })
    workflows.task.enterWork(deps, task.id)
    const worker = services.startWorker(store, repo, ctx, task.id)
    await waitFor(() => sessions.ptyTail(worker.ptyId).includes(`TASK:${task.id}`))
    assert.equal(store.getTask(task.id)?.status, 'in_progress')
    let observations = 0
    const off = sessions.subscribe(() => { observations++ }); off()
    sessions.writePty(worker.ptyId, 'offline\r')
    await waitFor(() => sessions.ptyTail(worker.ptyId).includes('ACK:offline'))
    assert.equal(observations, 0); assert.equal(sessions.isAlive(worker.ptyId), true)
    writeFileSync(join(worker.worktree, 'result.md'), 'native result\n')
    git(worker.worktree, 'add', 'result.md'); git(worker.worktree, 'commit', '-qm', 'result')
    const before = store.listEvents().length
    store.finishDispatch(worker.dispatchId, 'Completed', ['result.md'])
    binding.handleEvents(store.listEvents().slice(before))
    assert.equal(store.getTask(task.id)?.stage?.nodeId, 'human')
    const request = store.pendingRequests().find(r => r.taskId === task.id)!
    assert.ok(request)
    assert.equal(store.getTask(task.id)?.status, 'needs_input')
    const review = workflows.review.getReview(store, repo, task.id)
    assert.equal(review.base, store.getRun(coordinator.runId)?.git?.branch)
    assert.match(review.stat, /result\.md/)
    sessions.writePty(worker.ptyId, 'finish\r')
    await waitFor(() => !sessions.isAlive(worker.ptyId))
    assert.equal(store.snapshot().dispatches.find(d => d.id === worker.dispatchId)?.outcome, 'done')
    binding.resolveHumanRequest(request.id, { action: 'accept' })
    assert.equal(store.getRequest(request.id)?.status, 'resolved')
    assert.equal(store.getTask(task.id)?.status, 'done')
    assert.equal(readFileSync(join(store.getRun(coordinator.runId)!.git!.worktree!, 'result.md'), 'utf8'), 'native result\n')
    assert.equal(git(repo, 'branch', '--show-current'), 'master')
    sessions.writePty(coordinator.ptyId, 'finish\r')
    await waitFor(() => !sessions.isAlive(coordinator.ptyId))
    assert.equal(store.getRun(coordinator.runId)?.status, 'review')
  } finally {
    sessions.killAll(); launcher.dispose(); rmSync(dir, { recursive: true, force: true })
  }
}

// Изоляция завершает собственные native workers fixture, включая Windows conout после natural exit.
if (process.env.ORCA_TEST_WORKER_RUNTIME_FIXTURE === '1') {
  void nativeScenario().then(() => { process.exit(0) }, error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`, () => { process.exit(1) })
  })
} else {
  it('общий координатор и воркер проходят native PTY → detach → workflow → человек → review/merge без окна', { timeout: 45_000 }, () => {
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import',
      new URL('../../test/ts-resolve.mjs', import.meta.url).href, fileURLToPath(import.meta.url)], {
      encoding: 'utf8', timeout: 40_000,
      env: { ...process.env, NODE_OPTIONS: '', DISPLAY: '', ORCA_TEST_WORKER_RUNTIME_FIXTURE: '1' }
    })
    assert.equal(child.error, undefined, `${child.error?.message ?? ''}\n${child.stderr}`)
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
  })
}
