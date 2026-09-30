import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantChatSnapshot, AssistantChatUpdate, OrcaApi } from '../../shared/ipc'
import { applyChatUpdate, chatStateFromSnapshot, subscribeAssistantChat } from './assistantChat'
const snapshot: AssistantChatSnapshot = { ptyId: 's1', protocolVersion: 2, revision: 2, agent: 'claude', transport: 'chat', messages: [{ id: 'm1', role: 'agent', text: 'новый текст', at: 1 }], status: 'thinking', interactions: [] }
it('разрешение появляется один раз и исчезает после ответа; история сохраняется', () => {
  const initial = chatStateFromSnapshot(snapshot)
  const request = { ptyId: 's1', revision: 3, interaction: { id: 'r1', kind: 'permission' as const, title: 'Bash' } }
  const waiting = applyChatUpdate(initial, request)
  assert.equal(waiting.interactions.length, 1)
  assert.equal(applyChatUpdate(waiting, request), waiting)
  const answered = applyChatUpdate(waiting, { ptyId: 's1', revision: 4, resolvedRequestId: 'r1' })
  assert.equal(answered.interactions.length, 0)
  assert.equal(answered.messages, initial.messages)
})
it('старый фрагмент и событие чужой сессии не заменяют свежий текст', () => {
  const state = chatStateFromSnapshot(snapshot)
  assert.equal(applyChatUpdate(state, { ptyId: 's1', revision: 1, message: { ...snapshot.messages[0], text: 'старый' } }), state)
  assert.equal(applyChatUpdate(state, { ptyId: 's2', revision: 9, status: 'done' }), state)
})
it('ошибка и прерывание сохраняют уже полученные сообщения', () => {
  const state = chatStateFromSnapshot(snapshot)
  const failed = applyChatUpdate(state, { ptyId: 's1', revision: 3, status: 'error', error: 'auth failed' })
  assert.equal(failed.error, 'auth failed')
  const stopped = applyChatUpdate(failed, { ptyId: 's1', revision: 4, status: 'interrupted' })
  assert.equal(stopped.error, undefined)
  assert.equal(stopped.messages, state.messages)
})
function fixture() {
  let listener: ((event: AssistantChatUpdate) => void) | undefined
  let resolveSnapshot!: (value: AssistantChatSnapshot) => void
  let unsubscribed = false
  const pending = new Promise<AssistantChatSnapshot>((resolve) => { resolveSnapshot = resolve })
  const api = { assistantChat: { getMessages: () => pending, onMessage: (_id: string, cb: (event: AssistantChatUpdate) => void) => { listener = cb; return () => { unsubscribed = true } }, interrupt: async () => {}, respond: async () => {}, send: async () => {}, available: async () => true } } satisfies Pick<OrcaApi, 'assistantChat'>
  return { api, emit: (event: AssistantChatUpdate) => listener?.(event), resolveSnapshot, unsubscribed: () => unsubscribed }
}
it('подписка перед снимком сохраняет новые события и отбрасывает включённые в снимок', async () => {
  const f = fixture()
  const states: ReturnType<typeof chatStateFromSnapshot>[] = []
  const connection = subscribeAssistantChat(f.api, 's1', (state) => states.push(state), (error) => assert.fail(error))
  f.emit({ ptyId: 's1', revision: 1, message: { ...snapshot.messages[0], text: 'старый текст' } })
  f.emit({ ptyId: 's1', revision: 3, message: { id: 'm2', role: 'human', text: 'ещё', at: 2 } })
  f.resolveSnapshot(snapshot)
  await connection.ready
  assert.deepEqual(states.at(-1)?.messages.map((message) => message.text), ['новый текст', 'ещё'])
  connection.dispose()
  assert.equal(f.unsubscribed(), true)
})
it('закрытая подписка не публикует поздний снимок или событие', async () => {
  const f = fixture()
  let publications = 0
  const connection = subscribeAssistantChat(f.api, 's1', () => publications++, () => publications++)
  connection.dispose()
  f.resolveSnapshot(snapshot)
  await connection.ready
  f.emit({ ptyId: 's1', revision: 9, status: 'done' })
  assert.equal(publications, 0)
})
it('старый main не принимается за полноценный чат без разрешений', async () => {
  const f = fixture()
  let error = ''
  const connection = subscribeAssistantChat(f.api, 's1', () => assert.fail('старый снимок принят'), (value) => { error = value })
  f.resolveSnapshot({ ptyId: 's1', messages: [], status: 'done' })
  await connection.ready
  assert.equal(error, 'stale')
  connection.dispose()
})
