import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as runtime from '../src/index.ts'

test('reentrant filter сохраняет порядок всем observers, сбой фильтра изолирован', () => {
  const events = runtime.createObserverEvents({ epoch: 'owner' }); let nested = false
  const a = events.subscribe(events.cursor, () => { if (!nested) { nested = true; events.publish('second', null) }; return true })
  const broken = events.subscribe(events.cursor, () => { throw new Error('bad subscriber') })
  const b = events.subscribe(events.cursor)
  assert.doesNotThrow(() => events.publish('first', null))
  const topics = (sub: runtime.ObserverSubscription) => sub.take().flatMap(item => item.type === 'event' ? [item.event.topic] : [])
  assert.deepEqual(topics(a), ['first', 'second']); assert.deepEqual(topics(b), ['first', 'second']); assert.deepEqual(broken.take(), [])
})

test('handshake принимает независимые product versions и отвергает несовместимость/capability до effects', () => {
  const metadata = { protocolMajor: 1, schemaVersion: 1, runtimeRevision: 'commit', product: { name: 'desktop', version: '1.1.3' }, capabilities: ['board.read', 'events.replay'] }
  assert.deepEqual(runtime.assertOperatorHello({ protocolMajor: 1, schemaVersion: 1, product: { name: 'cli', version: '9.0.0' }, requiredCapabilities: ['board.read'] }, metadata), metadata)
  for (const hello of [null, { protocolMajor: 2, schemaVersion: 1 }, { protocolMajor: 1, schemaVersion: 99 },
    { protocolMajor: 1, schemaVersion: 1, product: { name: 'web', version: '0.1.0' }, requiredCapabilities: ['secrets.read'] }]) {
    assert.throws(() => runtime.assertOperatorHello(hello, metadata))
  }
})
test('snapshot barrier сохраняет reentrant event; независимые observers не потребляют события', () => {
  const events = runtime.createObserverEvents({ epoch: 'owner' })
  const first = events.snapshot(() => { events.publish('project.changed', { taskId: 't' }, 'p'); return { value: 'after' } })
  const second = events.subscribe(first.cursor)
  assert.deepEqual(first.snapshot, { value: 'after' })
  const a = first.subscription.take(); const b = second.take()
  assert.equal(a.length, 1); assert.deepEqual(a, b); assert.equal(a[0].type, 'event')
  assert.deepEqual(first.subscription.take(), [])
  events.publish('project.changed', { taskId: 'next' }, 'p'); assert.equal(second.take().length, 1)
  first.subscription.close(); events.publish('project.changed', {}, 'p'); assert.deepEqual(first.subscription.take(), [])
  assert.equal(second.take().length, 1)
})
test('slow queue, expired/restarted cursor и oversized payload требуют snapshot без unbounded memory', () => {
  let now = 1000; const events = runtime.createObserverEvents({ epoch: 'owner', maxEvents: 2, maxBytes: 1024, maxAgeMs: 100, queueEvents: 1, queueBytes: 512, now: () => now })
  const cursor = events.cursor; const slow = events.subscribe(cursor)
  for (let i = 0; i < 10; i++) events.publish('pty.data', { data: String(i) }, 'p')
  const reset = slow.take(); assert.equal(reset.length, 1); assert.equal(reset[0].type, 'snapshotRequired')
  assert.equal(events.subscribe(cursor).take()[0].type, 'snapshotRequired')
  assert.equal(events.subscribe({ epoch: 'previous-owner', sequence: 10 }).take()[0].type, 'snapshotRequired')
  const recent = events.cursor; now += 200; events.publish('project.changed', {}, 'p')
  assert.equal(events.subscribe(recent).take()[0].type, 'snapshotRequired')
  const large = events.subscribe(events.cursor); events.publish('pty.data', { data: 'x'.repeat(4096) }, 'p')
  const message = large.take()[0]; assert.equal(message.type, 'event')
  if (message.type === 'event') assert.equal(message.event.truncated, true)
  assert.ok(JSON.stringify(message).length < 512)
})
