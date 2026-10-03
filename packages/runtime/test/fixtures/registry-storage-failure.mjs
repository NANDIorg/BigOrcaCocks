import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DialogRegistry, createDialogRepository } from '../../src/index.ts'
import { fixture, services, until } from '../conversation-fixture.ts'

const [mode, phase] = process.argv.slice(2)
test(`${mode}/${phase}: storage failure closes provider without a later turn or exit delay`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-registry-fault-exit-'))
  const file = join(dir, 'dialogs.json')
  let registry
  t.after(() => { registry?.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const factory = services()
  let provider
  registry = new DialogRegistry({ repository: createDialogRepository(file),
    errors: { unknown: () => new Error('unknown'), emptyText: () => new Error('empty'), readOnly: () => new Error('history only'), storage: () => new Error('storage failed') },
    create: (_settings, onUpdate) => {
      provider = fixture(t, mode, mode === 'codex' ? 'codex' : 'gemini', {}, options => factory.create({ ...options, onUpdate: update => {
        const fail = phase === 'state' ? update.type === 'state' && update.status === 'thinking' : update.type === 'message' && update.message.role === 'human'
        if (fail) mkdirSync(`${file}.tmp`)
        onUpdate(update)
      } }))
      return provider.engine
    }
  })
  const id = registry.create({ agent: mode === 'codex' ? 'codex' : 'gemini' })
  await until(() => registry.snapshot(id).dialog.conversation.status === 'done')
  await assert.rejects(registry.send(id, 'hello', 'hidden context'), /storage failed/)
  const snapshot = registry.snapshot(id)
  assert.equal(snapshot.readOnly, true)
  assert.equal(snapshot.storageFailed, true)
  assert.equal(snapshot.dialog.conversation.status, 'error')
  assert.deepEqual(snapshot.dialog.conversation.interactions, [])
  assert.equal(provider.wire().some(frame => frame.method === 'turn/start' || frame.method === 'session/prompt'), false)
  registry.dispose()
})
// Без process.exit: родитель проверяет естественное завершение, включая cleanup timers.
