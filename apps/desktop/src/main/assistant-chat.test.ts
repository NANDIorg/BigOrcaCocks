// Запуск: pnpm --filter @orca-board/desktop test. Разбор транскрипта в чат ассистента — на временных папках.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyChatLine,
  emptyChatState,
  AssistantChatCache,
  assistantTranscriptPath,
  assistantChatAvailable,
  chatSnapshot,
  drainChatUpdates,
  chatInputBytes,
  type ChatBuildState
} from './assistant-chat'
import { claudeSlug, type TranscriptEnv } from './transcripts'
import { ASSISTANT_START_PROMPT } from '@orca-board/core'

const iso = (ms: number): string => new Date(ms).toISOString()
const T0 = Date.UTC(2026, 8, 24, 10)

/** Реплика человека: `type: 'user'`, content — строка. */
function human(at: number, uuid: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: iso(at), message: { role: 'user', content: text } }) + '\n'
}

/** Реплика ассистента: один content-блок на строку транскрипта, как реально пишет Claude Code. */
function assistantBlock(at: number, uuid: string, msgId: string, block: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', uuid, timestamp: iso(at), message: { id: msgId, role: 'assistant', content: [block] } }) + '\n'
}

function toolResult(at: number, uuid: string, toolUseId: string, content: string, isError = false): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: iso(at),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] }
    }) + '\n'
  )
}

function apply(state: ChatBuildState, ...lines: string[]): void {
  for (const line of lines) applyChatLine(line.trim(), state)
}

/** Маркер прерывания (Esc) — Claude Code пишет его text-блоком в `type: 'user'`, как реальный транскрипт. */
function interrupt(at: number, uuid: string, forToolUse = false): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: iso(at),
      message: { role: 'user', content: [{ type: 'text', text: forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] }
    }) + '\n'
  )
}

/** Реплика человека с текстом и вставленной картинкой (как из терминала) — массив блоков без tool_result. */
function humanWithImage(at: number, uuid: string, text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: iso(at),
      message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }
    }) + '\n'
  )
}

/** Служебная строка `isMeta: true` — например, `<local-command-caveat>` перед выводом слэш-команды. */
function metaLine(at: number, uuid: string, content: string): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: iso(at), message: { role: 'user', content }, isMeta: true }) + '\n'
}

/** Обёртка локальной команды (`/login`, `/mcp`…) — не всегда `isMeta: true`, но не реплика человека. */
function localCommandLine(at: number, uuid: string, content: string): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: iso(at), message: { role: 'user', content } }) + '\n'
}

describe('чат ассистента: разбор транскрипта', () => {
  it('сообщение человека — role human, пустое и служебные строки пропускаются', () => {
    const state = emptyChatState()
    apply(
      state,
      JSON.stringify({ type: 'mode', payload: {} }),
      human(T0, 'u1', 'Привет, ассистент'),
      human(T0 + 1, 'u2', '   ')
    )
    assert.equal(state.messages.length, 1)
    assert.deepEqual(state.messages[0], { id: 'u1', role: 'human', text: 'Привет, ассистент', at: T0 })
    assert.equal(state.status, 'thinking')
  })

  it('ответ текстом без инструментов — role agent, thinking игнорируется, статус done', () => {
    const state = emptyChatState()
    apply(state, assistantBlock(T0, 'a1', 'm1', { type: 'thinking', thinking: '...' }), assistantBlock(T0 + 1, 'a2', 'm1', { type: 'text', text: 'Привет!' }))
    assert.equal(state.messages.length, 1)
    assert.deepEqual(state.messages[0], { id: 'a2', role: 'agent', text: 'Привет!', at: T0 + 1 })
    assert.equal(state.status, 'done')
  })

  it('только tool_use — role tool, свёрнутая строка по description, статус thinking; tool_result дописывает ok и текст', () => {
    const state = emptyChatState()
    apply(
      state,
      assistantBlock(T0, 'a1', 'm1', { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'orca-board task list', description: 'Список задач' } })
    )
    assert.equal(state.status, 'thinking')
    assert.equal(state.messages.length, 1)
    assert.deepEqual(state.messages[0].toolCalls, [{ name: 'Bash', input: 'Список задач', status: 'running' }])
    assert.equal(state.messages[0].role, 'tool')

    apply(state, toolResult(T0 + 1, 'u1', 'call_1', '[]\n'))
    assert.equal(state.messages[0].toolCalls?.[0].status, 'ok')
    assert.equal(state.messages[0].text, '[]')
    assert.equal(state.status, 'thinking')
  })

  it('текст и tool_use в одной реплике — одно сообщение agent с toolCalls', () => {
    const state = emptyChatState()
    apply(
      state,
      assistantBlock(T0, 'a1', 'm1', { type: 'text', text: 'Смотрю задачи' }),
      assistantBlock(T0 + 1, 'a2', 'm1', { type: 'tool_use', id: 'call_2', name: 'Bash', input: { command: 'orca-board task list' } })
    )
    assert.equal(state.messages.length, 1)
    const m = state.messages[0]
    assert.equal(m.role, 'agent')
    assert.equal(m.text, 'Смотрю задачи')
    assert.equal(m.toolCalls?.length, 1)
    assert.equal(m.toolCalls?.[0].input, 'orca-board task list')
    assert.equal(state.status, 'thinking')
  })

  it('ошибка инструмента — call.status error и общий статус error, до следующего ответа агента', () => {
    const state = emptyChatState()
    apply(state, assistantBlock(T0, 'a1', 'm1', { type: 'tool_use', id: 'call_3', name: 'Bash', input: { command: 'orca-board task remove --id x' } }))
    apply(state, toolResult(T0 + 1, 'u1', 'call_3', 'ошибка: не найдено', true))
    assert.equal(state.messages[0].toolCalls?.[0].status, 'error')
    assert.equal(state.status, 'error')
    apply(state, assistantBlock(T0 + 2, 'a2', 'm2', { type: 'text', text: 'Такой задачи нет.' }))
    assert.equal(state.status, 'done')
  })

  it('несколько сообщений подряд не путают id и порядок', () => {
    const state = emptyChatState()
    apply(
      state,
      human(T0, 'u1', 'Создай задачу «Тест»'),
      assistantBlock(T0 + 1, 'a1', 'm1', { type: 'tool_use', id: 'call_4', name: 'Bash', input: { description: 'Создать задачу' } }),
      toolResult(T0 + 2, 'u2', 'call_4', 'задача task_1 создана'),
      assistantBlock(T0 + 3, 'a2', 'm2', { type: 'text', text: 'Готово: task_1' })
    )
    assert.deepEqual(
      state.messages.map((m) => m.role),
      ['human', 'tool', 'agent']
    )
    assert.equal(state.messages[1].text, 'задача task_1 создана')
    assert.equal(state.status, 'done')
  })

  it('прерывание (Esc) во время текстового ответа — статус done, не thinking навсегда', () => {
    const state = emptyChatState()
    apply(state, human(T0, 'u1', 'Расскажи подробно'), assistantBlock(T0 + 1, 'a1', 'm1', { type: 'text', text: 'Начинаю рассказ' }))
    assert.equal(state.status, 'done')
    apply(state, interrupt(T0 + 2, 'u2'))
    assert.equal(state.status, 'done')
    assert.equal(state.turn, null)
    // Маркер прерывания не показан как реплика человека.
    assert.equal(state.messages.length, 2)
    assert.deepEqual(
      state.messages.map((m) => m.role),
      ['human', 'agent']
    )
  })

  it('прерывание (Esc) во время tool-вызова — pending toolCalls закрываются как error, статус done', () => {
    const state = emptyChatState()
    apply(
      state,
      human(T0, 'u1', 'Выполни команду'),
      assistantBlock(T0 + 1, 'a1', 'm1', { type: 'tool_use', id: 'call_5', name: 'Bash', input: { description: 'Долгая команда' } })
    )
    assert.equal(state.messages[1].toolCalls?.[0].status, 'running')
    apply(state, interrupt(T0 + 2, 'u2', true))
    assert.equal(state.messages[1].toolCalls?.[0].status, 'error')
    assert.equal(state.status, 'done')
    assert.equal(state.pending.size, 0)
    assert.equal(state.messages.length, 2) // маркер не добавлен отдельным сообщением
  })

  it('реплика человека массивом блоков (текст + картинка) — попадает в чат, картинка помечена', () => {
    const state = emptyChatState()
    apply(state, humanWithImage(T0, 'u1', 'Что на скриншоте?'))
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0].role, 'human')
    assert.match(state.messages[0].text, /^Что на скриншоте\?/)
    assert.match(state.messages[0].text, /изображение/)
    assert.equal(state.status, 'thinking')
  })

  it('isMeta:true и обёртки локальных команд пропускаются, не становятся репликой человека', () => {
    const state = emptyChatState()
    apply(
      state,
      metaLine(T0, 'u1', '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'),
      localCommandLine(T0 + 1, 'u2', '<command-name>/login</command-name>'),
      localCommandLine(T0 + 2, 'u3', '<local-command-stdout>Login successful</local-command-stdout>')
    )
    assert.equal(state.messages.length, 0)
    assert.equal(state.status, 'done')
  })

  it('первая реплика сессии — стартовый промпт ассистента, не показывается человеку', () => {
    const state = emptyChatState()
    apply(state, human(T0, 'u1', ASSISTANT_START_PROMPT), assistantBlock(T0 + 1, 'a1', 'm1', { type: 'text', text: 'Привет!' }))
    assert.equal(state.messages.length, 1)
    assert.equal(state.messages[0].role, 'agent')
  })
})

describe('AssistantChatCache: инкрементальное чтение', () => {
  let tmp: string
  let env: TranscriptEnv

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'orca-assistant-chat-'))
    env = { claudeDir: path.join(tmp, 'claude'), codexDir: path.join(tmp, 'codex') }
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function sessionFile(cwd: string, sessionId: string): string {
    const dir = path.join(env.claudeDir, 'projects', claudeSlug(cwd))
    mkdirSync(dir, { recursive: true })
    return path.join(dir, `${sessionId}.jsonl`)
  }

  it('путь строится из slug(cwd) и sessionId', () => {
    const p = assistantTranscriptPath(env, '/Users/me/Library/assistant', 'sid-1')
    assert.equal(p, path.join(env.claudeDir, 'projects', claudeSlug('/Users/me/Library/assistant'), 'sid-1.jsonl'))
  })

  it('available: без sessionId или без файла — false, файл появился — true', async () => {
    const cwd = path.join(tmp, 'assistant')
    assert.equal(await assistantChatAvailable(env, cwd, undefined), false)
    assert.equal(await assistantChatAvailable(env, cwd, 'sid-1'), false)
    writeFileSync(sessionFile(cwd, 'sid-1'), '')
    assert.equal(await assistantChatAvailable(env, cwd, 'sid-1'), true)
  })

  it('файл не менялся — из кэша; дописан — дочитывается хвост; getMessages режет по лимиту', async () => {
    const cwd = path.join(tmp, 'assistant')
    const file = sessionFile(cwd, 'sid-2')
    writeFileSync(file, human(T0, 'u1', 'первое сообщение'))
    const cache = new AssistantChatCache()
    const first = await cache.read(file)
    assert.equal(first?.messages.length, 1)
    assert.equal(await cache.read(file), first)

    appendFileSync(file, assistantBlock(T0 + 1, 'a1', 'm1', { type: 'text', text: 'ответ' }))
    const grown = await cache.read(file)
    assert.equal(grown?.messages.length, 2)
    assert.equal(grown, first) // то же состояние, дописанное на месте

    const snap = chatSnapshot('pty_1', grown)
    assert.equal(snap.ptyId, 'pty_1')
    assert.equal(snap.status, 'done')
    assert.equal(snap.messages.length, 2)
  })

  it('нет файла — undefined; getMessages/available корректно деградируют', async () => {
    const cache = new AssistantChatCache()
    const state = await cache.read(path.join(tmp, 'нет-такого.jsonl'))
    assert.equal(state, undefined)
    const snap = chatSnapshot('pty_1', state)
    assert.deepEqual(snap, { ptyId: 'pty_1', messages: [], status: 'done' })
  })

  it('drainChatUpdates: новые/изменённые сообщения и смена статуса — по одному разу, потом пусто', async () => {
    const cwd = path.join(tmp, 'assistant')
    const file = sessionFile(cwd, 'sid-3')
    writeFileSync(file, human(T0, 'u1', 'привет'))
    const cache = new AssistantChatCache()
    const state = await cache.read(file)
    const updates = drainChatUpdates('pty_1', state!, undefined)
    // Сообщение + смена статуса (undefined → thinking).
    assert.equal(updates.length, 2)
    assert.deepEqual(
      updates.find((u) => 'status' in u),
      { ptyId: 'pty_1', status: 'thinking' }
    )
    assert.equal(drainChatUpdates('pty_1', state!, state!.status).length, 0)

    appendFileSync(file, assistantBlock(T0 + 1, 'a1', 'm1', { type: 'text', text: 'ответ' }))
    const grown = await cache.read(file)
    const more = drainChatUpdates('pty_1', grown!, 'thinking')
    assert.equal(more.length, 2) // новое сообщение + смена статуса на done
  })
})

describe('chatInputBytes', () => {
  it('однострочный текст — просто Enter', () => {
    assert.equal(chatInputBytes('привет'), 'привет\r')
  })
  it('многострочный текст — bracketed paste, CRLF нормализуется в LF', () => {
    assert.equal(chatInputBytes('строка1\r\nстрока2'), '\x1b[200~строка1\nстрока2\x1b[201~\r')
  })
  it('пустая строка — просто Enter (валидацию пустого текста делает вызывающий код)', () => {
    assert.equal(chatInputBytes(''), '\r')
  })
})
