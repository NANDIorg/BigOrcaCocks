import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'

function profile(t: test.TestContext) { const dir = mkdtempSync(join(tmpdir(), 'orca-operator-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const input = { clientId: 'client', actorId: 'operator', id: 'send-1', issuedAt: 1000, method: 'dialog.send', args: ['hello'], revision: 1 }

test('долгий writer heartbeat не заполняет durable ledger; retry не восстанавливает освобождённый lease', async t => {
  const dataDir = profile(t); let clock = 1000; let changes = 0
  const ledger = runtime.createMutationLedger({ dataDir, ownerId: 'owner', now: () => clock, maxEntries: 1 })
  const leases = runtime.createSessionWriterLeases({ isAlive: () => true, now: () => clock })
  const ctx = { clientId: 'client', actor: { kind: 'operator' as const, id: 'human' } }
  const lease = leases.claim('pty', ctx.clientId)
  const api = runtime.createOperatorApi({ groups: {
    session: { renewWriter: (context: typeof ctx, id: string, token: string) => leases.renew(id, context.clientId, token) },
    profile: { createGroup: () => { changes++; return 'group' } }
  }, product: { name: 'test', version: '1' }, ownerId: 'owner', ledger,
  events: runtime.createObserverEvents({ epoch: 'owner' }), getRevision: () => 1,
  authorize: () => true, authorizeProject: () => true, onDetach: () => {} })
  const operator = api.operator(ctx)
  operator.hello({ protocolMajor: 1, schemaVersion: 1, product: { name: 'test', version: '1' } })
  let packet = { id: '', issuedAt: clock, method: 'session.renewWriter', args: ['pty', lease.id], revision: 1 }
  for (let i = 0; i < 1025; i++) {
    clock += 15_000; packet = { ...packet, id: `renew-${i}`, issuedAt: clock }
    assert.equal((await operator.call(packet)).ok, true, `heartbeat ${i}`)
  }
  assert.equal(existsSync(join(dataDir, 'operator-mutations.json')), false)
  assert.equal((await operator.call(packet)).ok, true)
  leases.release('pty', ctx.clientId, lease.id)
  assert.equal((await operator.call(packet)).ok, false)
  assert.equal(leases.current('pty'), null)
  const mutation = { id: 'create', issuedAt: clock, method: 'profile.createGroup', args: [], revision: 1 }
  assert.equal((await operator.call(mutation)).ok, true)
  assert.equal((await operator.call(mutation)).ok, true); assert.equal(changes, 1)
})

test('mutation duplicate исполняется один раз, replay переживает restart, новый payload конфликтует', async t => {
  const dataDir = profile(t); const ledger = runtime.createMutationLedger({ dataDir, ownerId: 'owner', now: () => 1000 })
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve }); let effects = 0
  const action = async () => { effects++; await barrier; return { accepted: true } }
  const first = ledger.execute(input, action); const second = ledger.execute(input, action)
  await new Promise(resolve => setImmediate(resolve)); assert.equal(effects, 1); finish()
  assert.deepEqual(await first, { status: 'applied', result: { accepted: true } }); assert.deepEqual(await second, await first)
  const restarted = runtime.createMutationLedger({ dataDir, ownerId: 'next', now: () => 1001 })
  assert.deepEqual(await restarted.execute(input, action), await first); assert.equal(effects, 1)
  await assert.rejects(restarted.execute({ ...input, args: ['different'] }, action), /конфликт/i)
  assert.doesNotMatch(readFileSync(join(dataDir, 'operator-mutations.json'), 'utf8'), /hello|different/)
})

test('pending после смены owner uncertain; capacity, TTL и I/O запрещают новый effect', async t => {
  const dataDir = profile(t); let clock = 1000
  const ledger = runtime.createMutationLedger({ dataDir, ownerId: 'owner', now: () => clock, ttlMs: 100, maxEntries: 1 })
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve })
  const pending = ledger.execute(input, async () => { await barrier; return null })
  await new Promise(resolve => setImmediate(resolve))
  const next = runtime.createMutationLedger({ dataDir, ownerId: 'next', now: () => clock, ttlMs: 100, maxEntries: 1 })
  let effects = 0; assert.equal((await next.execute(input, () => effects++)).status, 'uncertain')
  clock = 2000
  await assert.rejects(next.execute({ ...input, id: 'new', issuedAt: clock }, () => effects++), /лимит/i)
  await assert.rejects(next.execute({ ...input, id: 'expired' }, () => effects++), /истек/i)
  assert.equal(effects, 0); finish(); await pending
  const blocked = profile(t); mkdirSync(join(blocked, 'operator-mutations.json.tmp'))
  const bad = runtime.createMutationLedger({ dataDir: blocked, ownerId: 'blocked', now: () => 1000 })
  await assert.rejects(bad.execute(input, () => effects++)); assert.equal(effects, 0)
  const future = profile(t); const bytes = '{"version":99,"records":[]}'
  writeFileSync(join(future, 'operator-mutations.json'), bytes)
  assert.throws(() => runtime.createMutationLedger({ dataDir: future, ownerId: 'bad' }), /схем/i)
  assert.equal(readFileSync(join(future, 'operator-mutations.json'), 'utf8'), bytes)
})

test('operator sessions проверяют principal/handshake/revision; selection и disconnect независимы', async t => {
  const ledger = runtime.createMutationLedger({ dataDir: profile(t), ownerId: 'owner', now: () => 1000 })
  const events = runtime.createObserverEvents({ epoch: 'owner' }); let effects = 0; const detached: string[] = []
  const metadata = { protocolMajor: 1, schemaVersion: 1, runtimeRevision: 'owner', product: { name: 'host', version: '1' }, capabilities: ['dialog'] }
  const commands = { 'dialog.send': { capability: 'dialog', mutation: true, scope: 'project' as const, invoke: () => { effects++; return null } } }
  const make = (clientId: string) => runtime.createOperatorSession({ context: { clientId, actor: { kind: 'operator' as const, id: 'human' } }, metadata, events, ledger, commands, getRevision: () => 1, onDetach: ctx => { detached.push(ctx.clientId) } })
  const a = make('a'); const b = make('b'); const call = { id: 'request', issuedAt: 1000, method: 'dialog.send', args: [], projectId: 'one', revision: 1 }
  const hello = { protocolMajor: 1, schemaVersion: 1, product: { name: 'client', version: '9' } }
  assert.equal((await a.call(call)).ok, false); a.hello(hello); b.hello(hello)
  a.select({ projectId: 'one', dialogId: 'dialog-a' }); b.select({ projectId: 'two', dialogId: 'dialog-b' })
  assert.equal(a.selection.projectId, 'one'); assert.equal(b.selection.projectId, 'two')
  assert.equal((await a.call({ ...call, actor: { kind: 'system', id: 'forged' } })).ok, false)
  assert.equal((await a.call({ ...call, id: 'stale-request', revision: 0 })).ok, false)
  assert.equal((await a.call({ ...call, method: 'toString' })).ok, false); assert.equal(effects, 0)
  assert.equal((await a.call(call)).ok, true); assert.equal(effects, 1)
  const sa = a.subscribe(events.cursor); const sb = b.subscribe(events.cursor); a.close()
  events.publish('changed', null, 'two'); assert.deepEqual(sa.take(), []); assert.equal(sb.take().length, 1)
  assert.deepEqual(detached, ['a']); assert.equal(b.selection.dialogId, 'dialog-b'); assert.equal((await a.call(call)).ok, false)
  const agent = () => runtime.createOperatorSession({ context: { clientId: 'agent', actor: { kind: 'agent', id: 'worker' } }, metadata, events, ledger, commands, getRevision: () => 1 })
  assert.throws(agent, /operator/i)
})
