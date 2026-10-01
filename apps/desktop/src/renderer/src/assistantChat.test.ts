import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantChatSnapshot, AssistantChatUpdate, OrcaApi } from '../../shared/ipc'
import { applyChatUpdate, chatStateFromSnapshot, groupMessages, isAssistantThinking, subscribeAssistantChat, toolActivityDetail } from './assistantChat'
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
it('между репликами виден вызов команды, но его результат не становится сообщением', () => {
  const messages: AssistantChatSnapshot['messages'] = [
    { id: 'h1', role: 'human', text: 'Покажи проекты', at: 1 },
    { id: 'a1', role: 'agent', text: 'Посмотрю доски.', at: 2 },
    { id: 't1', role: 'tool', text: '[{"id":"project-1","spec":"служебные данные"}]', at: 3, toolCalls: [{ name: 'Команда', input: 'orca-board projects list', status: 'ok' }] },
    { id: 't2', role: 'tool', text: '[]', at: 4 },
    { id: 'a2', role: 'agent', text: 'У вас три проекта.', at: 5 }
  ]
  assert.deepEqual(groupMessages(messages).map((group) => ({ speaker: group.speaker, ids: group.messages.map((message) => message.id) })), [
    { speaker: 'human', ids: ['h1'] }, { speaker: 'assistant', ids: ['a1', 't1', 'a2'] }
  ])
  const activity = groupMessages(messages)[1].messages[1]
  assert.equal(activity.text, '')
  assert.equal(activity.toolCalls?.[0].input, 'orca-board projects list')
  assert.equal(messages[2].text, '[{"id":"project-1","spec":"служебные данные"}]')
  assert.equal(messages.length, 5, 'данные протокола сохраняются для разрешений и состояния сессии')
})
it('пустые заготовки ответа и служебные сообщения не создают баблы', () => {
  assert.deepEqual(groupMessages([{ id: 'a1', role: 'agent', text: '  ', at: 1 }, { id: 't1', role: 'tool', text: 'готово', at: 2 }]), [])
  assert.equal(groupMessages([{ id: 'a1', role: 'agent', text: '', hasImage: true, at: 1 }]).length, 1)
})
it('индикатор сохраняется между частями ответа до завершения запроса', () => {
  let state = chatStateFromSnapshot({ ...snapshot, messages: [{ id: 'h1', role: 'human', text: 'Покажи проекты', at: 1 }] })
  assert.equal(isAssistantThinking(state), true)
  state = applyChatUpdate(state, { ptyId: 's1', revision: 3, message: { id: 't1', role: 'tool', text: '[{"id":"project-1"}]', at: 2 } })
  assert.equal(isAssistantThinking(state), true, 'результат команды не является ответом пользователю')
  state = applyChatUpdate(state, { ptyId: 's1', revision: 4, message: { id: 'a1', role: 'agent', text: '', at: 3 } })
  assert.equal(isAssistantThinking(state), true)
  state = applyChatUpdate(state, { ptyId: 's1', revision: 5, message: { id: 'a1', role: 'agent', text: 'У вас', at: 3 } })
  assert.equal(state.status, 'thinking')
  assert.equal(isAssistantThinking(state), true, 'первый фрагмент текста не завершает ответ')
  state = applyChatUpdate(state, { ptyId: 's1', revision: 6, message: { id: 't2', role: 'tool', text: '[]', at: 4 } })
  assert.equal(isAssistantThinking(state), true, 'после результата команды агент продолжает работу')
  state = applyChatUpdate(state, { ptyId: 's1', revision: 7, status: 'done' })
  assert.equal(isAssistantThinking(state), false, 'индикатор убирает завершение запроса')
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
it('один вызов обновляет статус на месте и не открывает найденные данные', () => {
  const initial = chatStateFromSnapshot({ ...snapshot, messages: [{ id: 'h1', role: 'human', text: 'Проекты', at: 1 }] })
  const tool = { id: 't1', role: 'tool' as const, text: '', at: 2, toolCalls: [{ id: 'exec-1', name: 'Команда', input: 'orca-board projects list', status: 'running' as const }] }
  const running = applyChatUpdate(initial, { ptyId: 's1', revision: 3, message: tool })
  assert.equal(groupMessages(running.messages)[1].messages[0].toolCalls?.[0].status, 'running')
  const finished = applyChatUpdate(running, { ptyId: 's1', revision: 4, message: { ...tool, text: '[{"root":"/private/project"}]', toolCalls: [{ ...tool.toolCalls[0], status: 'ok' }] } })
  const activity = groupMessages(finished.messages)[1].messages
  assert.equal(activity.length, 1)
  assert.equal(activity[0].id, 't1')
  assert.equal(activity[0].toolCalls?.[0].status, 'ok')
  assert.equal(activity[0].text, '')
})
it('после текста и команды индикатор возвращается до завершения ответа', () => {
  const initial = chatStateFromSnapshot({ ...snapshot, messages: [
    { id: 'h1', role: 'human', text: 'Создай воркфлоу', at: 1 },
    { id: 'a1', role: 'agent', text: 'Создам тип и проверю граф.', at: 2 }
  ] })
  const tool = { id: 't1', role: 'tool' as const, text: '', at: 2, toolCalls: [{ name: 'Команда', input: 'orca-board projects list', status: 'running' as const }] }
  const running = applyChatUpdate(initial, { ptyId: 's1', revision: 3, message: tool })
  assert.equal(isAssistantThinking(running), false)
  const finished = applyChatUpdate(running, { ptyId: 's1', revision: 4, message: { ...tool, toolCalls: [{ ...tool.toolCalls[0], status: 'ok' }] } })
  assert.equal(isAssistantThinking(finished), true)
  const answered = applyChatUpdate(finished, { ptyId: 's1', revision: 5, message: { id: 'a2', role: 'agent', text: 'Граф проверен, сохраняю тип.', at: 3 } })
  assert.equal(isAssistantThinking(answered), true)
  assert.equal(isAssistantThinking(applyChatUpdate(answered, { ptyId: 's1', revision: 6, status: 'done' })), false)
})
it('краткое описание действия показывает команду или цель, но не весь JSON аргументов', () => {
  assert.equal(toolActivityDetail('orca-board projects list'), 'orca-board projects list')
  assert.equal(toolActivityDetail('{"command":"orca-board projects list","output":"СЛУЖЕБНЫЙ ВЫВОД"}'), 'orca-board projects list')
  assert.equal(toolActivityDetail('{"file_path":"README.md","content":"ПОЛНОЕ СОДЕРЖИМОЕ"}'), 'README.md')
  assert.equal(toolActivityDetail('{"pattern":"TODO","path":"src"}'), 'TODO · src')
  assert.equal(toolActivityDetail('[{"path":"src/first.ts"},{"path":"src/second.ts"}]'), 'src/first.ts · src/second.ts')
  assert.equal(toolActivityDetail('{"content":"ПОЛНОЕ СОДЕРЖИМОЕ"}'), '')
  assert.equal(toolActivityDetail('{"command":"обрезанный JSON'), '')
  assert.equal(toolActivityDetail('"List projects"'), 'List projects')
  assert.ok(toolActivityDetail('a'.repeat(1000)).length <= 180)
})
