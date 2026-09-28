// Запуск: pnpm --filter @orca-board/desktop test. Логика чат-режима панели ассистента (без React/IPC).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantChatMessage, AssistantChatUpdate, OrcaApi } from '../../shared/ipc'
import {
  applyChatUpdate, checkChatSupport, chatStateFromSnapshot, emptyChatState, groupMessages, isAssistantViewMode,
  isStuckThinking, readAssistantViewMode, speakerOf, writeAssistantViewMode, STUCK_THINKING_MS
} from './assistantChat'

function msg(id: string, role: AssistantChatMessage['role'], text = '', at = 0): AssistantChatMessage {
  return { id, role, text, at }
}

/** Подставляет localStorage на время теста — как в `boardView.test.ts`. */
function withStorage(store: Map<string, string> | 'broken', fn: () => void): void {
  const g = globalThis as { localStorage?: unknown }
  const prev = g.localStorage
  g.localStorage =
    store === 'broken'
      ? { getItem: () => { throw new Error('нет доступа') }, setItem: () => { throw new Error('нет доступа') } }
      : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  try {
    fn()
  } finally {
    g.localStorage = prev
  }
}

describe('readAssistantViewMode/writeAssistantViewMode', () => {
  it('нет localStorage — по умолчанию чат, запись не падает', () => {
    assert.equal(readAssistantViewMode(), 'chat')
    writeAssistantViewMode('terminal')
  })

  it('сохранённое значение переживает чтение', () => {
    const store = new Map<string, string>()
    withStorage(store, () => {
      assert.equal(readAssistantViewMode(), 'chat')
      writeAssistantViewMode('terminal')
      assert.equal(readAssistantViewMode(), 'terminal')
      writeAssistantViewMode('chat')
      assert.equal(readAssistantViewMode(), 'chat')
    })
  })

  it('мусор в хранилище — как будто выбора не было', () => {
    withStorage(new Map([['orca.assistant.viewMode', 'что-то']]), () => {
      assert.equal(readAssistantViewMode(), 'chat')
    })
  })

  it('сломанный localStorage — тоже дефолт', () => {
    withStorage('broken', () => {
      assert.equal(readAssistantViewMode(), 'chat')
      writeAssistantViewMode('terminal')
    })
  })
})

describe('isAssistantViewMode', () => {
  it('только chat/terminal', () => {
    assert.equal(isAssistantViewMode('chat'), true)
    assert.equal(isAssistantViewMode('terminal'), true)
    assert.equal(isAssistantViewMode('other'), false)
    assert.equal(isAssistantViewMode(undefined), false)
  })
})

describe('checkChatSupport', () => {
  const api = (available: unknown): Partial<OrcaApi> => ({ assistantChat: { available } } as unknown as Partial<OrcaApi>)

  it('доступен — available() → true', async () => {
    assert.equal(await checkChatSupport(api(async () => true), 'p1'), 'available')
  })

  it('API есть, но транскрипта нет — unavailable', async () => {
    assert.equal(await checkChatSupport(api(async () => false), 'p1'), 'unavailable')
  })

  it('старый preload/main — stale', async () => {
    assert.equal(await checkChatSupport(undefined, 'p1'), 'stale')
    assert.equal(await checkChatSupport({}, 'p1'), 'stale')
    assert.equal(await checkChatSupport(api('не функция'), 'p1'), 'stale')
  })

  it('новый preload, старый main — invoke падает → stale', async () => {
    const noHandler = async (): Promise<boolean> => {
      throw new Error("Error invoking remote method 'assistantChat:available': Error: No handler registered for 'assistantChat:available'")
    }
    assert.equal(await checkChatSupport(api(noHandler), 'p1'), 'stale')
  })
})

describe('chatStateFromSnapshot/emptyChatState', () => {
  it('снимок → состояние ленты; пустое — done без сообщений', () => {
    assert.deepEqual(emptyChatState(), { messages: [], status: 'done' })
    const snap = { ptyId: 'p1', messages: [msg('1', 'human', 'привет')], status: 'thinking' as const }
    assert.deepEqual(chatStateFromSnapshot(snap), { messages: snap.messages, status: 'thinking' })
  })
})

describe('applyChatUpdate', () => {
  it('новое сообщение — добавляется в конец', () => {
    const state = { messages: [msg('1', 'human', 'привет')], status: 'thinking' as const }
    const next = applyChatUpdate(state, { ptyId: 'p1', message: msg('2', 'agent', 'да, слушаю') })
    assert.deepEqual(next.messages.map((m) => m.id), ['1', '2'])
    assert.equal(next.status, 'thinking')
  })

  it('знакомый id — заменяется на месте, не дублируется', () => {
    const state = { messages: [msg('1', 'human'), msg('2', 'tool', '')], status: 'thinking' as const }
    const updated: AssistantChatMessage = { id: '2', role: 'tool', text: 'готово', at: 5 }
    const next = applyChatUpdate(state, { ptyId: 'p1', message: updated })
    assert.equal(next.messages.length, 2)
    assert.deepEqual(next.messages[1], updated)
  })

  it('смена статуса не трогает сообщения; тот же статус — тот же объект состояния', () => {
    const state = { messages: [msg('1', 'human')], status: 'thinking' as const }
    const next = applyChatUpdate(state, { ptyId: 'p1', status: 'done' })
    assert.equal(next.status, 'done')
    assert.equal(next.messages, state.messages)
    const same = applyChatUpdate(next, { ptyId: 'p1', status: 'done' } as AssistantChatUpdate)
    assert.equal(same, next)
  })
})

describe('speakerOf/groupMessages', () => {
  it('human — отдельный собеседник, agent и tool — один и тот же (ассистент)', () => {
    assert.equal(speakerOf('human'), 'human')
    assert.equal(speakerOf('agent'), 'assistant')
    assert.equal(speakerOf('tool'), 'assistant')
  })

  it('подряд идущие реплики одного собеседника — одна группа; смена — новая', () => {
    const messages = [
      msg('1', 'human', 'сделай X'),
      msg('2', 'tool', ''),
      msg('3', 'agent', 'готово'),
      msg('4', 'human', 'спасибо')
    ]
    const groups = groupMessages(messages)
    assert.deepEqual(groups.map((g) => [g.speaker, g.messages.map((m) => m.id)]), [
      ['human', ['1']],
      ['assistant', ['2', '3']],
      ['human', ['4']]
    ])
  })

  it('пустая лента — нет групп', () => {
    assert.deepEqual(groupMessages([]), [])
  })
})

describe('isStuckThinking', () => {
  it('не thinking — никогда не зависла', () => {
    assert.equal(isStuckThinking('done', 0, 1_000_000), false)
    assert.equal(isStuckThinking('error', 0, 1_000_000), false)
  })

  it('thinking без сообщений — не с чем сравнить, не зависла', () => {
    assert.equal(isStuckThinking('thinking', undefined, 1_000_000), false)
  })

  it('thinking и порог не превышен — не зависла; превышен — зависла', () => {
    const at = 1000
    assert.equal(isStuckThinking('thinking', at, at + STUCK_THINKING_MS - 1), false)
    assert.equal(isStuckThinking('thinking', at, at + STUCK_THINKING_MS + 1), true)
  })
})
