import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
