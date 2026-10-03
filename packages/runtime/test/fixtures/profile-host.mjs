import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import processes from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

assert.equal(process.versions.electron, undefined)
assert.equal(process.env.DISPLAY, undefined)
assert.equal(process.env.WAYLAND_DISPLAY, undefined)
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  processes[name] = () => { throw new Error('Bootstrap may not start a CLI') }
}
syncBuiltinESMExports()
const api = await import('../../src/index.ts')
const dataDir = process.argv[2]
const mode = process.argv[3]
const input = createInterface({ input: process.stdin })
const commands = input[Symbol.asyncIterator]()
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n')
emit({ type: 'waiting' })
try {
  const command = await commands.next()
  assert.equal(command.value, 'start')
  const runtime = await api.startProfileRuntime({ dataDir, start: context => {
    appendFileSync(join(context.dataDir, 'initializer.log'), 'init\n')
    // Реальные общие backup/load paths выполняются только внутри owned initializer.
    api.backupOnVersionChange(context.dataDir, '1.1.3')
    const messages = { Error, text: key => key }
    const { ProjectManager } = api.createProjectServices({ messages, settings: api.createRuntimeSettings(messages) })
    const projects = new ProjectManager(context.dataDir)
    const dialogs = api.createDialogRepository(join(context.dataDir, 'dialogs.json'))
    dialogs.list()
    const resource = join(context.dataDir, 'resource')
    writeFileSync(resource, 'opened')
    context.deferCleanup(() => rmSync(resource, { force: true }))
    if (mode === 'fail') throw new Error('initializer failed')
    return { projects, dialogs }
  } })
  emit({ type: 'ready', owner: runtime.owner })
  for await (const command of commands) {
    if (command === 'stop') {
      await runtime.stop()
      emit({ type: 'stopped' })
      input.close()
      process.stdin.destroy()
      break
    }
  }
  // Disconnect закрывает reader, но OS guard сохраняет owner; остановка только явная.
} catch (error) {
  emit({ type: 'error', code: error.code ?? 'startup.failed', message: error.message,
    cause: error.cause instanceof Error ? error.cause.message : undefined })
  process.exitCode = 1
  input.close()
  process.stdin.destroy()
}
