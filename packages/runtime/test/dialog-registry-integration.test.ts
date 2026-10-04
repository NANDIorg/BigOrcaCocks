import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssistantChatSnapshot } from '@orca-board/contracts'
import { AssistantSession, createDialogRepository } from '../src/index.ts'
import { fixture, services, until } from './conversation-fixture.ts'

for (const mode of ['codex', 'acp']) for (const phase of ['state', 'human']) {
  test(`${mode}/${phase}: ошибка записи не задерживает естественный выход Node и не отправляет turn`, () => {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./fixtures/registry-storage-failure.mjs', import.meta.url)), mode, phase], { env, encoding: 'utf8', timeout: 8000 })
    assert.match(output, /(?:# pass 1|ℹ pass 1)/u)
    assert.doesNotMatch(output, /(?:# fail [1-9]|ℹ fail [1-9])/u)
  })
}

test('session сама сохраняет Codex; отдельный Node восстанавливает Desktop-compatible history без CLI', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-registry-restart-'))
  let manager: AssistantSession | undefined
  t.after(() => { manager?.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const file = join(dir, 'profile-a', 'dialogs.json')
  const otherFile = join(dir, 'profile-b', 'dialogs.json')
  const repository = createDialogRepository(file)
  const other = createDialogRepository(otherFile)
  other.save({ id: 'unrelated', projectId: 'other', createdAt: 1, updatedAt: 1, revision: 0,
    conversation: { id: 'unrelated', agent: 'claude', status: 'done', messages: [], interactions: [] } }, null)
  const otherBytes = readFileSync(otherFile, 'utf8')
  const factory = services()
  manager = new AssistantSession({ repository,
    errors: { unknownPty: () => new Error('unknown'), emptyText: () => new Error('empty'), readOnly: () => new Error('history only') },
    settings: () => ({ agent: 'codex' }), assertUsable: () => {},
    create: (_settings, onUpdate) => fixture(t, 'codex', 'codex', {}, options => factory.create({ ...options, onUpdate })).engine,
    startTerminal: () => { throw new Error('no terminal') }, isAlive: () => false, killTerminal: () => {}, onUpdate: () => {}
  })
  const { ptyId } = manager.open(80, 30, false)
  await manager.send(ptyId, 'permission')
  await until(() => manager!.snapshot(ptyId).status === 'waiting')
  const live = manager.snapshot(ptyId)
  assert.ok(live.messages.length > 0)
  assert.ok(live.interactions!.length > 0)
  assert.deepEqual(repository.get(ptyId)!.conversation.providerBinding, { transport: 'codex-app-server', sessionId: 'thread-1' })
  assert.notEqual(ptyId, 'thread-1')
  manager.dispose()
  const bytes = readFileSync(file, 'utf8')
  const source = `
    import assert from 'node:assert/strict';
    import processes from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    assert.equal(process.versions.electron, undefined);
    assert.equal(process.env.DISPLAY, undefined);
    assert.equal(process.env.WAYLAND_DISPLAY, undefined);
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])
      processes[name] = () => { throw new Error('Reload may not create subprocesses'); };
    syncBuiltinESMExports();
    const { AssistantSession, createDialogRepository } = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
    const manager = new AssistantSession({ repository: createDialogRepository(process.argv[1]),
      errors: { unknownPty: () => new Error('unknown'), emptyText: () => new Error('empty'), readOnly: () => new Error('history only') },
      settings: () => { throw new Error('No settings on history path'); },
      assertUsable: () => { throw new Error('No discovery on history path'); },
      create: () => { throw new Error('No driver on history path'); },
      startTerminal: () => { throw new Error('No terminal on history path'); },
      isAlive: () => false, killTerminal: () => { throw new Error('No child'); }, onUpdate: () => {}
    });
    const { ptyId } = manager.open(80,30,false);
    const snapshot = manager.snapshot(ptyId);
    assert.equal(snapshot.readOnly, true);
    assert.throws(() => manager.send(ptyId,'continue'), /history only/);
    assert.throws(() => manager.respond(ptyId,'approval-1',{kind:'cancel'}), /history only/);
    assert.throws(() => manager.interrupt(ptyId), /history only/);
    assert.throws(() => manager.open(80,30,true), /No settings on history path/);
    assert.equal(manager.open(80,30,false).ptyId, ptyId);
    manager.dispose();
    process.stdout.write(JSON.stringify(snapshot));
  `
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source, file], { env, cwd: dir, encoding: 'utf8', timeout: 10_000 })
  const restored = JSON.parse(output) as AssistantChatSnapshot
  assert.equal(restored.ptyId, ptyId)
  assert.equal(restored.protocolVersion, 2)
  assert.equal(restored.transport, 'chat')
  assert.equal(restored.status, 'interrupted')
  assert.equal(restored.requiresNewConversation, true)
  assert.deepEqual(restored.providerBinding, { transport: 'codex-app-server', sessionId: 'thread-1' })
  assert.deepEqual(restored.interactions, [])
  assert.deepEqual(restored.messages.filter(message => !message.toolCalls?.length), live.messages.filter(message => !message.toolCalls?.length))
  assert.ok(restored.messages.some(message => message.toolCalls?.some(tool => tool.status === 'cancelled')))
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.equal(readFileSync(otherFile, 'utf8'), otherBytes)
})
