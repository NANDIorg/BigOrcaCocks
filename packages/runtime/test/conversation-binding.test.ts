import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, until } from './conversation-fixture.ts'

for (const [mode, agent, transport, sessionId] of [
  ['claude', 'claude', 'claude-stream-json', undefined],
  ['codex', 'codex', 'codex-app-server', 'thread-1'],
  ['acp', 'gemini', 'acp', 'session-1']
] as const) {
  test(`${agent} snapshot сохраняет собственный provider binding после реального handshake`, async t => {
    const f = fixture(t, mode, agent)
    const initial = f.engine.snapshot()
    assert.equal(initial.providerBinding?.transport, transport)
    if (agent !== 'claude') assert.equal(initial.providerBinding?.sessionId, undefined)
    await f.engine.send('permission')
    await until(() => f.engine.snapshot().status === 'waiting')
    const snapshot = f.engine.snapshot()
    assert.deepEqual(snapshot.providerBinding, { transport, sessionId: sessionId ?? f.engine.id })
    if (agent !== 'claude') assert.notEqual(snapshot.providerBinding!.sessionId, snapshot.id)
  })
}
