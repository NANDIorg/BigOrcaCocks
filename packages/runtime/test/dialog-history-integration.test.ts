import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DialogHistorySnapshot, DialogRecord, ConversationSnapshot } from '@orca-board/contracts'
import { createDialogRepository } from '../src/index.ts'
import { fixture, until } from './conversation-fixture.ts'

function directory(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-dialog-node-reload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function providerHost(t: { after(fn: () => void): void }) {
  const callbacks: (() => void)[] = []
  const stop = async (): Promise<void> => { while (callbacks.length) await callbacks.shift()!() }
  t.after(stop)
  return { after: (fn: () => void) => { callbacks.push(fn) }, stop }
}
function record(snapshot: ConversationSnapshot, projectId: string): DialogRecord {
  return Object.assign({ id: 'dialog-same-id', projectId, createdAt: 10, updatedAt: 20, revision: 0, conversation: snapshot }, { custom: { tag: projectId } })
}

/** Отдельный Node импортирует public API; subprocess creation запрещён на всём reload пути. */
function reload(files: string[], cwd: string): DialogHistorySnapshot[][] {
  const source = `
    import processes from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    assert.equal(process.versions.electron, undefined);
    assert.equal(process.env.DISPLAY, undefined);
    assert.equal(process.env.WAYLAND_DISPLAY, undefined);
    for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
      processes[method] = () => { throw new Error('History reload must not create a subprocess'); };
    }
    syncBuiltinESMExports();
    const { createDialogRepository } = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
    const result = JSON.parse(process.argv[1]).map(file => {
      const repo = createDialogRepository(file);
      return repo.list().map(record => repo.history(record.id));
    });
    process.stdout.write(JSON.stringify(result));
  `
  const env = { ...process.env }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(files)], { cwd, env, encoding: 'utf8', timeout: 10_000 })
  return JSON.parse(output) as DialogHistorySnapshot[][]
}

test('Claude/Codex: реальный snapshot → два profile → остановка CLI → public Node history-only', async t => {
  const dir = directory(t)
  const host = providerHost(t)
  const claude = fixture(host, 'claude', 'claude')
  const codex = fixture(host, 'codex', 'codex')
  const originals: DialogRecord[] = []
  const files = [join(dir, 'profile-A', 'dialogs.json'), join(dir, 'profile-B', 'dialogs.json')]
  for (const [i, provider] of [claude, codex].entries()) {
    await provider.engine.send('permission')
    await until(() => provider.engine.snapshot().status === 'waiting')
    const snapshot = provider.engine.snapshot()
    assert.ok(snapshot.interactions.length > 0)
    assert.ok(snapshot.messages.some(message => message.toolCalls?.some(tool => tool.status === 'running')))
    Object.assign(snapshot.messages[0], { custom: { source: 'native transcript' } })
    const saved = record(snapshot, `project-${i}`)
    createDialogRepository(files[i]).save(saved, null)
    originals.push(saved)
  }
  assert.deepEqual(originals[0].conversation.providerBinding, { transport: 'claude-stream-json', sessionId: claude.engine.id })
  assert.deepEqual(originals[1].conversation.providerBinding, { transport: 'codex-app-server', sessionId: 'thread-1' })
  assert.notEqual(codex.engine.id, 'thread-1')
  const bytes = files.map(file => readFileSync(file, 'utf8'))
  await host.stop()
  const histories = reload(files, dir)
  for (const [i, dialogs] of histories.entries()) {
    assert.equal(dialogs.length, 1)
    const history = dialogs[0]
    assert.equal(history.readOnly, true)
    assert.equal(history.requiresNewConversation, true)
    assert.equal(history.dialog.projectId, `project-${i}`)
    assert.equal(history.dialog.conversation.status, 'interrupted')
    assert.deepEqual(history.dialog.conversation.interactions, [])
    assert.deepEqual(history.dialog.conversation.providerBinding, originals[i].conversation.providerBinding)
    const expected = JSON.parse(JSON.stringify(originals[i])) as DialogRecord
    expected.conversation.status = 'interrupted'
    expected.conversation.interactions = []
    for (const message of expected.conversation.messages) for (const tool of message.toolCalls ?? []) if (tool.status === 'running') tool.status = 'cancelled'
    assert.deepEqual(history.dialog, expected)
    assert.equal(readFileSync(files[i], 'utf8'), bytes[i])
    assert.deepEqual(createDialogRepository(files[i]).get(originals[i].id), originals[i])
  }
})

test('ACP: завершённая реальная сессия сохраняет transcript/native id после Node reload', async t => {
  const dir = directory(t)
  const host = providerHost(t)
  const provider = fixture(host, 'acp', 'gemini')
  await provider.engine.send('permission')
  await until(() => provider.engine.snapshot().status === 'waiting')
  await provider.engine.respond(provider.engine.snapshot().interactions[0].id, { kind: 'option', optionId: 'reject-provider-specific' })
  await until(() => provider.engine.snapshot().status === 'done')
  const saved = record(provider.engine.snapshot(), 'project-acp')
  assert.deepEqual(saved.conversation.providerBinding, { transport: 'acp', sessionId: 'session-1' })
  assert.ok(saved.conversation.messages.at(-1)!.text.includes('reject-provider-specific'))
  const file = join(dir, 'dialogs.json')
  createDialogRepository(file).save(saved, null)
  const bytes = readFileSync(file, 'utf8')
  await host.stop()
  const [history] = reload([file], dir)[0]
  assert.equal(history.readOnly, true)
  assert.equal(history.requiresNewConversation, true)
  // Fixture завершает turn без финального tool update: history сохраняет done,
  // но показывает оставшийся running tool как cancelled, согласно DTO contract.
  const expected = JSON.parse(JSON.stringify(saved)) as DialogRecord
  const tools = expected.conversation.messages.flatMap(message => message.toolCalls ?? [])
  assert.equal(tools.length, 1)
  assert.equal(tools[0].status, 'running')
  tools[0].status = 'cancelled'
  assert.deepEqual(history.dialog, expected)
  assert.equal(readFileSync(file, 'utf8'), bytes)
})
