import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClientCommandContext } from '@orca-board/contracts'
import * as runtime from '../src/index.ts'
import { profileFixture, operator } from './profile-command-test-host.ts'

const two: ClientCommandContext = { clientId: 'two', actor: { kind: 'operator', id: 'person-two' } }
const code = (value: string) => (e: unknown) => e instanceof runtime.CommandError && e.code === value
function fixture(t: { after(fn: () => void): void }) {
  assert.equal(typeof runtime.createSessionCommands, 'function')
  assert.equal(typeof runtime.createSessionWriterLeases, 'function')
  const f = profileFixture(); t.after(f.close)
  let now = 1000; let lookups = 0; let allow = true
  const ports: Array<{ exit(): void; killed: boolean; size: number[] }> = []
  const starts: Array<{ command: string; cwd?: string; env: Record<string, string> }> = []
  const sessions = runtime.createSessionRegistry({ spawn: (command, _args, options) => {
    starts.push({ command, cwd: options.cwd, env: { ...options.env } })
    let output = (_data: string) => {}; let exit = (_event: { exitCode: number }) => {}
    const port = { killed: false, size: [options.cols, options.rows], exit: () => exit({ exitCode: 0 }) }; ports.push(port)
    return { onData: cb => { output = cb }, onExit: cb => { exit = cb }, write: data => { output(data) },
      resize: (cols, rows) => { port.size = [cols, rows] }, kill: () => { port.killed = true; port.exit() } }
  } })
  t.after(() => sessions.killAll())
  const leases = runtime.createSessionWriterLeases({ isAlive: sessions.isAlive, now: () => now })
  const commands = runtime.createSessionCommands({ sessions, leases, project: id => { lookups++; return f.manager.get(id) },
    authorize: ctx => allow && ctx.actor.kind === 'operator', defaultCwd: f.dataDir,
    env: p => ({ ORCA_SOCKET: 'test-endpoint', ...(p ? { ORCA_PROJECT: p.id } : {}), PATH: 'fixture-path' }) })
  return { ...f, commands, sessions, leases, starts, ports, clock: (at: number) => { now = at }, deny: () => { allow = false }, lookups: () => lookups }
}

test('session context/payload guards run before project lookup or real registry spawn', t => {
  const f = fixture(t)
  assert.throws(() => f.commands.spawn({ ...operator, actor: { kind: 'agent', id: 'forged' } }, { cols: 80, rows: 24 }), code('command.forbidden'))
  for (const raw of [{ cols: NaN, rows: 24 }, { cols: 80, rows: 0 }, { cols: 80, rows: 24, env: { X: 7 } },
    { cols: 80, rows: 24, env: { 'BAD=KEY': 'bad' } }, { cols: 80, rows: 24, projectId: '' }, { cols: 80, rows: 24, meta: { role: 'worker' } }]) {
    assert.throws(() => f.commands.spawn(operator, raw as { cols: number; rows: number }), code('command.invalidInput'))
  }
  assert.equal(f.lookups(), 0); assert.equal(f.sessions.listTerminals().length, 0); assert.equal(f.starts.length, 0)
})
test('global and two explicit project shells use host env/root/meta without selecting a board', t => {
  const f = fixture(t)
  const global = f.commands.spawn(operator, { cols: 80, rows: 24, command: 'fixture-shell', label: 'global' })
  const a = f.commands.spawn(operator, { cols: 80, rows: 24, projectId: f.a.id, label: 'A' })
  const b = f.commands.spawn(two, { cols: 100, rows: 30, projectId: f.b.id, label: 'B', env: { EXTRA: 'set' } })
  assert.equal(f.starts[0].cwd, f.dataDir); assert.equal(f.starts[0].command, 'fixture-shell')
  assert.equal(f.starts[1].cwd, f.a.root); assert.equal(f.starts[1].env.ORCA_PROJECT, f.a.id)
  assert.equal(f.starts[2].cwd, f.b.root); assert.equal(f.starts[2].env.EXTRA, 'set')
  const snapshot = f.commands.list(operator)
  assert.deepEqual(snapshot.map(s => s.ptyId), [global, a, b]); assert.ok(snapshot.every(s => s.role === 'shell'))
  snapshot[0].label = 'changed'; assert.equal(f.sessions.listTerminals()[0].label, 'global')
  assert.equal(f.manager.active()?.id, f.a.id); assert.equal(f.manager.loadedStores().length, 0)
  assert.throws(() => f.commands.spawn(operator, { cols: 80, rows: 24, projectId: 'foreign' }), code('command.projectNotFound'))
})
test('one writer: foreign claim/token/input never changes terminal tail', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 })
  const lease = f.commands.claimWriter(operator, id)
  assert.throws(() => f.commands.claimWriter(two, id), code('command.conflict'))
  assert.throws(() => f.commands.write(two, id, 'foreign', lease.id), code('command.conflict'))
  assert.throws(() => f.commands.write(operator, id, 'wrong', 'foreign-token'), code('command.conflict'))
  assert.equal(f.sessions.ptyTail(id), '')
  f.commands.write(operator, id, 'accepted', lease.id); assert.equal(f.sessions.ptyTail(id), 'accepted')
  lease.clientId = 'changed'; assert.equal(f.commands.writer(operator, id)?.clientId, operator.clientId)
})
test('resize validates dimensions and current writer before native resize', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 }); const lease = f.commands.claimWriter(operator, id)
  assert.throws(() => f.commands.resize(two, id, 100, 30, lease.id), code('command.conflict'))
  assert.throws(() => f.commands.resize(operator, id, 100, 0, lease.id), code('command.invalidInput'))
  assert.deepEqual(f.ports[0].size, [80, 24])
  f.commands.resize(operator, id, 100, 30, lease.id); assert.deepEqual(f.ports[0].size, [100, 30])
})
test('expiry enables another writer; late previous input/resize cannot affect the PTY', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 }); const first = f.commands.claimWriter(operator, id)
  assert.equal(first.expiresAt, 31000)
  f.clock(31000); const second = f.commands.claimWriter(two, id); assert.notEqual(second.id, first.id)
  assert.throws(() => f.commands.write(operator, id, 'late', first.id), code('command.conflict'))
  assert.throws(() => f.commands.resize(operator, id, 90, 28, first.id), code('command.conflict'))
  f.commands.write(two, id, 'new owner', second.id); assert.equal(f.sessions.ptyTail(id), 'new owner')
  assert.deepEqual(f.ports[0].size, [80, 24]); assert.equal(f.ports[0].killed, false)
})
test('release then explicit claim transfers control without stopping a process', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 }); const first = f.commands.claimWriter(operator, id)
  f.commands.releaseWriter(operator, id, first.id); assert.equal(f.commands.writer(two, id), null)
  const second = f.commands.claimWriter(two, id); f.commands.write(two, id, 'transferred', second.id)
  assert.equal(f.sessions.ptyTail(id), 'transferred'); assert.equal(f.sessions.isAlive(id), true)
})
test('renew keeps identity, expires after renewed TTL and does not renew a foreign token', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 }); const first = f.commands.claimWriter(operator, id)
  f.clock(20000); const renewed = f.commands.renewWriter(operator, id, first.id)
  assert.equal(renewed.id, first.id); assert.equal(renewed.expiresAt, 50000)
  assert.throws(() => f.commands.renewWriter(two, id, first.id), code('command.conflict'))
  f.clock(49999); assert.throws(() => f.commands.claimWriter(two, id), code('command.conflict'))
  f.clock(50000); assert.equal(f.commands.claimWriter(two, id).clientId, two.clientId)
})
test('disconnect drops only client leases; same sessions/output survive for observers/new writer', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 }); const first = f.commands.claimWriter(operator, id)
  f.commands.write(operator, id, 'before', first.id); f.leases.dropClient(operator.clientId)
  assert.equal(f.sessions.isAlive(id), true); assert.equal(f.commands.list(two)[0].tail, 'before')
  const next = f.commands.claimWriter(two, id); f.commands.write(two, id, 'after', next.id)
  assert.equal(f.sessions.ptyTail(id), 'beforeafter'); assert.equal(f.ports[0].killed, false)
})
test('actual registry exit/explicit kill invalidate writer; kill does not require taking writer from another client', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 }); f.commands.claimWriter(operator, id)
  f.ports[0].exit(); assert.throws(() => f.commands.claimWriter(two, id), code('command.rejected'))
  const other = f.commands.spawn(two, { cols: 80, rows: 24 }); f.commands.claimWriter(two, other)
  f.commands.kill(operator, other); assert.equal(f.sessions.isAlive(other), false); assert.equal(f.ports[1].killed, true)
})
test('bounded input rejects over64KiB before changing activity/output; valid lease alone is insufficient after policy revocation', t => {
  const f = fixture(t); const id = f.commands.spawn(operator, { cols: 80, rows: 24 }); const lease = f.commands.claimWriter(operator, id)
  const before = f.sessions.lastActivityAt(id)
  assert.throws(() => f.commands.write(operator, id, 'я'.repeat(32769), lease.id), code('command.invalidInput'))
  assert.equal(f.sessions.lastActivityAt(id), before); assert.equal(f.sessions.ptyTail(id), '')
  f.deny(); assert.throws(() => f.commands.write(operator, id, 'revoked', lease.id), code('command.forbidden'))
  assert.equal(f.sessions.ptyTail(id), '')
})
test('lease configuration rejects nonpositive/oversized TTL rather than granting indefinite writers', () => {
  assert.equal(typeof runtime.createSessionWriterLeases, 'function')
  for (const ttlMs of [0, -1, NaN, 1.5, 60001]) assert.throws(() => runtime.createSessionWriterLeases({ isAlive: () => true, ttlMs }), RangeError)
})
