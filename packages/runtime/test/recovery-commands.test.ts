import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '@orca-board/core'
import * as runtime from '../src/index.ts'

test('operator recovery валидирует principal/revision; решение изменяет только journal', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-recovery-api-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const old = runtime.createEffectJournal({ dataDir, ownerId: 'old' }); const id = old.begin({ projectId: 'p', repoRoot: dataDir }, { kind: 'git', operation: 'push', cwd: dataDir })
  const journal = runtime.createEffectJournal({ dataDir, ownerId: 'new' }); const store = new TaskStore(); const before = store.snapshot()
  const processes = runtime.createGitProcessService(); t.after(() => processes.stop()); let lookups = 0
  const commands = runtime.createRecoveryCommands({ journal: () => journal, processes, authorize: ctx => ctx.clientId === 'trusted',
    project: () => { lookups++; return { id: 'p', root: dataDir, store } }, isCurrent: () => true })
  const context = { clientId: 'trusted', actor: { kind: 'operator' as const, id: 'me' } }
  for (const actor of [{ kind: 'agent' as const, id: 'agent' }, { kind: 'system' as const, id: 'system' }]) {
    await assert.rejects(async () => commands.resolve({ ...context, actor }, id, 1, 'retry'), e => e instanceof runtime.CommandError && e.code === 'command.forbidden')
  }
  await assert.rejects(async () => commands.list({ ...context, clientId: 'foreign' }), e => e instanceof runtime.CommandError && e.code === 'command.forbidden')
  assert.equal(lookups, 0); assert.equal(commands.list(context).length, 1)
  await assert.rejects(async () => commands.resolve(context, id, 99, 'retry'))
  assert.equal(commands.resolve(context, id, 1, 'retry').phase, 'resolved')
  assert.equal(commands.list(context).length, 0); assert.deepEqual(store.snapshot(), before)
})
