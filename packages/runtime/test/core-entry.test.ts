import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

it('обычный Node загружает core через пакет и восстанавливает доску runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-core-entry-'))
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
      import { jsonPersistence } from '@orca-board/runtime'
      const file = process.argv[1]
      const first = new TaskStore(jsonPersistence(file), () => DEFAULT_COLUMNS)
      const run = first.createRun('Серверный проект')
      const second = new TaskStore(jsonPersistence(file), () => DEFAULT_COLUMNS)
      assert.equal(second.getRun(run.id).objective, 'Серверный проект')
    `, join(dir, 'board.json')], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
    assert.equal(child.status, 0, child.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('обычный Node использует сессии и launcher без Electron, DISPLAY и exit hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-runtime-entry-'))
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { existsSync } from 'node:fs'
      import { getAgent } from '@orca-board/core'
      const listeners = process.listenerCount('exit')
      const { createSessionRegistry, createAgentLauncher } = await import('@orca-board/runtime')
      assert.equal(process.listenerCount('exit'), listeners)
      const dir = process.argv[1]
      let data, exit, killed = false
      const registry = createSessionRegistry({ spawn: () => ({
        onData: fn => { data = fn }, onExit: fn => { exit = fn },
        write: () => {}, resize: () => {}, kill: () => { killed = true }
      }) })
      const launcher = createAgentLauncher({ settingsInvalid: path => new Error(path) })
      let settingsFile = ''
      const id = launcher.launchAgent(getAgent('amp').invoke('sys', 'task', { permissionMode: 'auto', shell: 'sh' }), dir,
        (command, onExit) => {
          settingsFile = command.args[command.args.lastIndexOf('--settings-file') + 1]
          return registry.spawnPty({ command: command.command, args: command.args, env: command.env, cwd: dir,
            cols: 80, rows: 24, meta: { role: 'assistant', label: 'Amp' } }, onExit)
        }, undefined, { home: dir, tempRoot: dir, env: {}, platform: 'linux' })
      const off = registry.subscribe(() => {})
      off()
      data('headless output')
      assert.equal(killed, false)
      assert.equal(registry.terminalSnapshots()[0].tail, 'headless output')
      assert.equal(existsSync(settingsFile), true)
      exit({ exitCode: 0 })
      assert.equal(registry.isAlive(id), false)
      assert.equal(existsSync(settingsFile), false)
      launcher.dispose()
      assert.equal(process.listenerCount('exit'), listeners)
    `, dir], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', DISPLAY: '' } })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('package entrypoint запускает общий воркер под Node без Electron loader и сохраняет результат', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-worker-entry-'))
  const repo = join(dir, 'repo'); mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' })
  try {
    git('init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README.md'), 'base\n')
    git('add', 'README.md'); git('commit', '-qm', 'init')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { join } from 'node:path'
      import { TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES } from '@orca-board/core'
      const listeners = process.listenerCount('exit')
      const { createExecutionResources, createGitOperations, createWorkerServices,
        createSessionRegistry, createAgentLauncher, jsonPersistence } = await import('@orca-board/runtime')
      const dir = process.argv[1], repo = process.argv[2]
      let data, exit
      const sessions = createSessionRegistry({ spawn: () => ({ onData: fn => { data = fn }, onExit: fn => { exit = fn },
        write: () => {}, resize: () => {}, kill: () => {} }) })
      const messages = { error: key => new Error(key) }
      const git = createGitOperations({ ...messages, untrackedLabel: () => 'Untracked:' })
      const resources = createExecutionResources({ messages, git, logger: { warn: () => {} } })
      const launcher = createAgentLauncher({ settingsInvalid: path => new Error(path) })
      const services = createWorkerServices({ resources, messages, sessions, launcher, host: {
        dataDir: dir, cliBinDir: join(dir, 'cli'), prompts: { worker: 'WORKER', coordinator: 'COORDINATOR', assistant: 'ASSISTANT' },
        language: () => 'en', shell: () => 'sh', extraPathDirs: () => [],
        launchOptions: () => ({ home: dir, tempRoot: dir, env: {}, platform: 'linux' })
      } })
      const file = join(dir, 'board.json')
      const store = new TaskStore(jsonPersistence(file), () => DEFAULT_COLUMNS)
      const task = store.createTask({ title: 'Headless worker', roleId: 'developer' })
      const worker = services.startWorker(store, repo, { socketPath: join(dir, 'orca.sock'), projectId: 'project',
        roles: DEFAULT_ROLES, typeTitle: 'General', permissionMode: 'auto' }, task.id)
      assert.equal(store.getTask(task.id).status, 'in_progress')
      data('output without window')
      assert.equal(sessions.terminalSnapshots()[0].tail, 'output without window')
      store.finishDispatch(worker.dispatchId, 'Headless result', [])
      exit({ exitCode: 0 })
      assert.equal(sessions.isAlive(worker.ptyId), false)
      const restored = new TaskStore(jsonPersistence(file), () => DEFAULT_COLUMNS)
      assert.equal(restored.getTask(task.id).status, 'review')
      assert.equal(restored.snapshot().dispatches.find(d => d.id === worker.dispatchId).summary, 'Headless result')
      launcher.dispose()
      assert.equal(process.listenerCount('exit'), listeners)
    `, dir, repo], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', DISPLAY: '' } })
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
