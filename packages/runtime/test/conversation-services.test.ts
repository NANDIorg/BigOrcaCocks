import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, services, until } from './conversation-fixture.ts'

test('два host сохраняют свои env/messages и отменяют только собственный диалог', async t => {
  const left = services({ messages: key => `left:${key}`, env: () => ({ ...process.env, ORCA_TEST_HOST: 'left', ORCA_RUN_ID: 'foreign-run' }) })
  const right = services({ messages: key => `right:${key}`, env: () => ({ ...process.env, ORCA_TEST_HOST: 'right', ORCA_PROJECT: 'foreign-project' }) })
  const a = fixture(t, 'claude', 'claude', {}, left.create)
  const b = fixture(t, 'claude', 'claude', {}, right.create)
  await assert.rejects(a.engine.send(''), { message: 'left:assistantTransport.invalidMessage' })
  await assert.rejects(b.engine.send(''), { message: 'right:assistantTransport.invalidMessage' })
  await Promise.all([a.engine.send('permission'), b.engine.send('permission')])
  await until(() => a.engine.snapshot().status === 'waiting' && b.engine.snapshot().status === 'waiting')
  for (const [f, host] of [[a, 'left'], [b, 'right']] as const) {
    const spawn = f.wire().find(frame => frame.fixtureSpawn)!.fixtureSpawn as { env: Record<string, string> }
    assert.equal(spawn.env.ORCA_TEST_HOST, host)
    assert.equal(spawn.env.ORCA_ROLE, 'assistant')
    assert.equal(spawn.env.ORCA_PROJECT, undefined)
    assert.equal(spawn.env.ORCA_RUN_ID, undefined)
  }
  assert.notEqual(a.engine.snapshot().interactions[0].id, b.engine.snapshot().interactions[0].id)
  await a.engine.interrupt()
  await until(() => a.engine.snapshot().status === 'interrupted')
  assert.equal(b.engine.snapshot().status, 'waiting')
  const request = b.engine.snapshot().interactions[0]
  await b.engine.respond(request.id, { kind: 'option', optionId: 'deny' })
  await until(() => b.engine.snapshot().status === 'done')
  assert.equal(b.engine.snapshot().messages.at(-1)!.text, 'deny')
})

test('Windows structured shim использует executablePath host без поиска Node другого профиля', t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-conversation-host-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const homeDir = join(dir, 'empty-home')
  mkdirSync(homeDir)
  writeFileSync(join(dir, 'agent.cmd'), '@ECHO off\n"%dp0%entry.mjs" %*\n')
  writeFileSync(join(dir, 'entry.mjs'), '')
  const hostNode = join(dir, 'host-node.exe')
  const factory = services({ homeDir, executablePath: hostNode, platform: 'win32' })
  const args = ['--system', 'Привет & %PATH%\n(orca) "quoted"']
  const launch = factory.structuredLaunch('agent', args, { PATH: dir, PATHEXT: '.CMD' })
  assert.equal(launch.command, hostNode)
  assert.deepEqual(launch.args, [join(dir, 'entry.mjs'), ...args])
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
})

test('public Node entry выполняет реальный Codex fixture диалог без Electron/DISPLAY', () => {
  const helperUrl = new URL('./conversation-fixture.ts', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict';
    import { fixture, until } from ${JSON.stringify(helperUrl)};
    const cleanup = [];
    const f = fixture({ after: fn => cleanup.push(fn) }, 'codex', 'codex');
    try {
      await f.engine.send('permission');
      await until(() => f.engine.snapshot().interactions.length === 1);
      const request = f.engine.snapshot().interactions[0];
      await f.engine.respond(request.id, { kind: 'option', optionId: 'decline' });
      await until(() => f.engine.snapshot().status === 'done');
      assert.equal(f.engine.snapshot().messages.at(-1).text, 'Decision:decline');
      process.stdout.write(JSON.stringify({ status: 'done', agent: 'codex', electron: process.versions.electron ?? null, display: process.env.DISPLAY ?? null }));
    } finally { for (const fn of cleanup) await fn(); }
  `
  const env = { ...process.env }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { env, timeout: 15_000, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(output), { status: 'done', agent: 'codex', electron: null, display: null })
})
