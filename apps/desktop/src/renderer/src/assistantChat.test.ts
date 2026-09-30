import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantChatSnapshot, AssistantChatUpdate, OrcaApi } from '../../shared/ipc'
import { applyChatUpdate, chatStateFromSnapshot, groupMessages, isAssistantThinking, subscribeAssistantChat } from './assistantChat'
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
it('результаты команд не попадают в видимые сообщения между репликами ассистента', () => {
  const messages: AssistantChatSnapshot['messages'] = [
    { id: 'h1', role: 'human', text: 'Покажи проекты', at: 1 },
    { id: 'a1', role: 'agent', text: 'Посмотрю доски.', at: 2 },
    { id: 't1', role: 'tool', text: '[{"id":"project-1","spec":"служебные данные"}]', at: 3, toolCalls: [{ name: 'Команда', input: 'orca-board projects list', status: 'ok' }] },
    { id: 't2', role: 'tool', text: '[]', at: 4 },
    { id: 'a2', role: 'agent', text: 'У вас три проекта.', at: 5 }
  ]
  assert.deepEqual(groupMessages(messages).map((group) => ({ speaker: group.speaker, ids: group.messages.map((message) => message.id) })), [
    { speaker: 'human', ids: ['h1'] }, { speaker: 'assistant', ids: ['a1', 'a2'] }
  ])
  assert.equal(messages.length, 5, 'данные протокола сохраняются для разрешений и состояния сессии')
})
it('пустые заготовки ответа и служебные сообщения не создают баблы', () => {
  assert.deepEqual(groupMessages([{ id: 'a1', role: 'agent', text: '  ', at: 1 }, { id: 't1', role: 'tool', text: 'готово', at: 2 }]), [])
  assert.equal(groupMessages([{ id: 'a1', role: 'agent', text: '', hasImage: true, at: 1 }]).length, 1)
})
it('индикатор ожидания исчезает с первым текстом ответа, до завершения запроса', () => {
  let state = chatStateFromSnapshot({ ...snapshot, messages: [{ id: 'h1', role: 'human', text: 'Покажи проекты', at: 1 }] })
  assert.equal(isAssistantThinking(state), true)
  state = applyChatUpdate(state, { ptyId: 's1', revision: 3, message: { id: 't1', role: 'tool', text: '[{"id":"project-1"}]', at: 2 } })
  assert.equal(isAssistantThinking(state), true, 'результат команды не является ответом пользователю')
  state = applyChatUpdate(state, { ptyId: 's1', revision: 4, message: { id: 'a1', role: 'agent', text: '', at: 3 } })
  assert.equal(isAssistantThinking(state), true)
  state = applyChatUpdate(state, { ptyId: 's1', revision: 5, message: { id: 'a1', role: 'agent', text: 'У вас', at: 3 } })
  assert.equal(state.status, 'thinking')
  assert.equal(isAssistantThinking(state), false)
  state = applyChatUpdate(state, { ptyId: 's1', revision: 6, message: { id: 't2', role: 'tool', text: '[]', at: 4 } })
  assert.equal(isAssistantThinking(state), false, 'скрытые результаты не возвращают индикатор после ответа')
})
it('новый вопрос снова показывает ожидание, даже если в истории уже есть ответ', () => {
  const state = chatStateFromSnapshot({ ...snapshot, messages: [
    { id: 'h1', role: 'human', text: 'Первый вопрос', at: 1 },
    { id: 'a1', role: 'agent', text: 'Первый ответ', at: 2 },
    { id: 'h2', role: 'human', text: 'Второй вопрос', at: 3 }
  ] })
  assert.equal(isAssistantThinking(state), true)
  for (const status of ['waiting', 'done', 'interrupted', 'error', 'starting'] as const) {
    assert.equal(isAssistantThinking({ ...state, status }), false)
  }
  assert.equal(isAssistantThinking({ ...state, interactions: [{ id: 'r1', kind: 'permission', title: 'Команда' }] }), false)
})
