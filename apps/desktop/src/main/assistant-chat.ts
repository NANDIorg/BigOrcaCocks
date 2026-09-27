/**
 * Чат-режим панели ассистента поверх PTY (`docs/assistant-chat.md` → «3. Контракт чат-режима»): разбирает
 * транскрипт Claude Code того же ассистента в список сообщений чата. Источник — файл сессии по фиксированному
 * `sessionId` (`--session-id`, как у воркера/координатора — `agentSessionId` в `worker.ts`), поэтому путь известен
 * заранее и сканировать папку проекта Claude Code (как `findClaudeSession` в `transcripts.ts`) не нужно.
 *
 * Разбор — отдельный от `transcripts.ts`: там нужен расход токенов (`parseClaudeLine`), здесь — текст реплик и
 * tool-вызовы, свёрнутые в одну строку. Инкрементальность (дочитывание хвоста) переиспользует `readLines`
 * `transcripts.ts`; состояние разбора (открытая реплика, ожидающие результата tool-вызовы, статус) хранится
 * в кэше по (путь, размер, mtime) — тот же приём, что `TranscriptCache`.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSISTANT_START_PROMPT } from '@orca-board/core'
import type { AssistantChatMessage, AssistantChatSnapshot, AssistantChatStatus, AssistantChatToolCall, AssistantChatUpdate } from '../shared/ipc'
import { claudeSlug, readLines, type TranscriptEnv } from './transcripts'

/** Сколько последних сообщений отдаёт `getMessages` — по аналогии с `EVENT_ANSWER_LIMIT`: не тащим файл целиком. */
export const ASSISTANT_CHAT_MESSAGE_LIMIT = 300

const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Первая непустая строка текста, обрезанная — короткое превью результата инструмента (не весь вывод команды). */
function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? ''
  return truncate(line, 200)
}

/** `tool_result.content`: строка или блоки `{type: 'text', text}` (формат Anthropic API). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return firstLine(content)
  for (const block of arr(content)) {
    const b = obj(block)
    if (b?.type === 'text' && typeof b.text === 'string') return firstLine(b.text)
  }
  return ''
}

/**
 * Краткое представление аргументов `tool_use` для свёрнутой строки — не весь JSON вызова. У ассистента
 * фактически только `Bash(orca-board:*)`: `description` — человекочитаемая подпись, которую агент передаёт сам.
 */
function summarizeToolInput(input: unknown): string {
  const o = obj(input)
  if (o) {
    if (typeof o.description === 'string' && o.description.trim()) return truncate(o.description, 160)
    if (typeof o.command === 'string' && o.command.trim()) return truncate(o.command, 160)
  }
  return truncate(JSON.stringify(input ?? {}), 160)
}

function timeOf(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? Date.now() : t
}

/**
 * Служебные строки `type: 'user'`, которые агент сам не писал и человек в чате не набирал: `isMeta: true`
 * (Claude Code помечает так вставки вроде `<local-command-caveat>`) и обёртки локальных команд (`/login`,
 * `/mcp` и т.п.) — `<command-name>`, `<local-command-stdout>`, `<local-command-stderr>`, `<local-command-caveat>`.
 * Не всегда помечены `isMeta` (у `<command-name>` его нет), поэтому проверяем и текст.
 */
const LOCAL_COMMAND_RE = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/

function isServiceUserLine(o: Record<string, unknown>, text: string): boolean {
  return o.isMeta === true || LOCAL_COMMAND_RE.test(text) || text.startsWith('Caveat:')
}

/** Маркер прерывания хода агента клавишей Esc — Claude Code пишет его text-блоком в `type: 'user'`. */
const INTERRUPT_PREFIX = '[Request interrupted by user'

function isInterruptBlocks(blocks: Record<string, unknown>[]): boolean {
  return blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(INTERRUPT_PREFIX))
}

/** Esc прервал ответ (в тексте или на середине tool-вызова) — закрываем незавершённые вызовы и ход, статус не должен зависнуть на 'thinking'. */
function applyInterrupt(state: ChatBuildState): void {
  for (const [callId, loc] of state.pending) {
    const call = state.messages[loc.messageIndex]?.toolCalls?.[loc.callIndex]
    if (call) {
      call.status = 'error'
      touch(state, loc.messageIndex)
    }
    state.pending.delete(callId)
  }
  state.turn = null
  state.status = 'done'
}

/** Где лежит открытый tool-вызов в `messages` — чтобы `tool_result` дописал статус на то же место. */
interface PendingCall {
  messageIndex: number
  callIndex: number
}

/** Собираемая сейчас реплика ассистента: блоки транскрипта с одним `message.id` дописываются в одно сообщение чата. */
interface OpenTurn {
  messageId: string
  messageIndex: number
}

/**
 * Состояние разбора одного файла транскрипта — переживает между инкрементальными чтениями (как `CacheEntry`
 * в `transcripts.ts`). `touched` — индексы `messages`, изменённые с прошлого `drainChatUpdates` (для `onMessage`).
 */
export interface ChatBuildState {
  messages: AssistantChatMessage[]
  status: AssistantChatStatus
  pending: Map<string, PendingCall>
  turn: OpenTurn | null
  touched: Set<number>
}

export function emptyChatState(): ChatBuildState {
  return { messages: [], status: 'done', pending: new Map(), turn: null, touched: new Set() }
}

function touch(state: ChatBuildState, index: number): void {
  state.touched.add(index)
}

/** Реплика человека — печатает как сообщение чата: `id`, если есть `uuid`, иначе позиционный. */
function pushHuman(o: Record<string, unknown>, text: string, state: ChatBuildState): void {
  const index = state.messages.length
  // Первая реплика сессии — служебный стартовый промпт ассистента (`worker.ts` → `startAssistant`), человек его не писал.
  if (index === 0 && text === ASSISTANT_START_PROMPT) return
  state.messages.push({ id: typeof o.uuid === 'string' ? o.uuid : `u${index}`, role: 'human', text, at: timeOf(o.timestamp) })
  touch(state, index)
  state.turn = null
  state.status = 'thinking'
}

/**
 * Реплика человека — печатает `content` строкой; `tool_result` (тоже `type: 'user'`) размечен массивом блоков,
 * так же как маркер прерывания (Esc) и реплика с вложением (текст + картинка, вставленная в терминал).
 */
function applyUserLine(o: Record<string, unknown>, state: ChatBuildState): void {
  const content = obj(o.message)?.content
  if (typeof content === 'string') {
    const text = content.trim()
    if (!text || isServiceUserLine(o, text)) return
    pushHuman(o, text, state)
    return
  }
  const blocks = arr(content).map(obj).filter((b): b is Record<string, unknown> => b !== undefined)
  if (isInterruptBlocks(blocks)) {
    applyInterrupt(state)
    return
  }
  const results = blocks.filter((b) => b.type === 'tool_result')
  if (results.length) {
    let sawError = false
    for (const r of results) {
      if (r.is_error === true) sawError = true
      const callId = typeof r.tool_use_id === 'string' ? r.tool_use_id : undefined
      if (!callId) continue
      const loc = state.pending.get(callId)
      if (!loc) continue
      const message = state.messages[loc.messageIndex]
      const call = message?.toolCalls?.[loc.callIndex]
      if (!message || !call) continue
      call.status = r.is_error === true ? 'error' : 'ok'
      if (message.role === 'tool') message.text = toolResultText(r.content)
      touch(state, loc.messageIndex)
      state.pending.delete(callId)
    }
    state.status = sawError ? 'error' : 'thinking'
    return
  }
  if (o.isMeta === true) return
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim())
  if (!texts.length) return
  const text = texts.map((b) => (b.text as string).trim()).join('\n')
  // Картинка, вставленная в терминал вместе с текстом, — помечаем, само изображение чат не показывает (нет поля под него в AssistantChatMessage).
  const hasImage = blocks.some((b) => b.type === 'image')
  pushHuman(o, hasImage ? `${text}\n[+ изображение]` : text, state)
}

/**
 * Реплика ассистента. Блоки одного `message.id` могут прийти несколькими строками транскрипта (Claude Code
 * пишет по одному content-блоку на строку, `apiBlockIndex` по порядку): `thinking` игнорируется (не для чата),
 * `text` и `tool_use` дописываются в одно сообщение чата — текст и её же collapsed tool-вызовы.
 * Сообщение без текста (только `tool_use`) получает `role: 'tool'`; текст в том же `message.id` — `role: 'agent'`.
 */
function applyAssistantLine(o: Record<string, unknown>, state: ChatBuildState): void {
  const msg = obj(o.message)
  const messageId = typeof msg?.id === 'string' ? msg.id : undefined
  if (!messageId) return
  if (!state.turn || state.turn.messageId !== messageId) state.turn = { messageId, messageIndex: -1 }
  const turn = state.turn
  const at = timeOf(o.timestamp)
  const uuid = typeof o.uuid === 'string' ? o.uuid : `a${state.messages.length}`
  let lastBlockType = ''
  for (const block of arr(msg?.content)) {
    const b = obj(block)
    if (!b || typeof b.type !== 'string') continue
    lastBlockType = b.type
    if (b.type === 'thinking') continue
    if (b.type === 'text') {
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (!text) continue
      if (turn.messageIndex === -1) {
        turn.messageIndex = state.messages.length
        state.messages.push({ id: uuid, role: 'agent', text, at })
      } else {
        const message = state.messages[turn.messageIndex]
        message.role = 'agent'
        message.text = message.text ? `${message.text}\n${text}` : text
      }
      touch(state, turn.messageIndex)
      continue
    }
    if (b.type === 'tool_use') {
      const call: AssistantChatToolCall = { name: typeof b.name === 'string' ? b.name : '?', input: summarizeToolInput(b.input), status: 'running' }
      if (turn.messageIndex === -1) {
        turn.messageIndex = state.messages.length
        state.messages.push({ id: uuid, role: 'tool', text: '', at, toolCalls: [call] })
      } else {
        const message = state.messages[turn.messageIndex]
        message.toolCalls = [...(message.toolCalls ?? []), call]
      }
      const callIndex = (state.messages[turn.messageIndex].toolCalls?.length ?? 1) - 1
      if (typeof b.id === 'string') state.pending.set(b.id, { messageIndex: turn.messageIndex, callIndex })
      touch(state, turn.messageIndex)
      continue
    }
  }
  if (lastBlockType) state.status = lastBlockType === 'text' ? 'done' : 'thinking'
}

/** Строка транскрипта → изменения в `state`. Строки не `user`/`assistant` (`attachment`, `mode`, служебные…) — пропускаются. */
export function applyChatLine(line: string, state: ChatBuildState): void {
  const o = obj(JSON.parse(line))
  if (!o) return
  if (o.type === 'user') applyUserLine(o, state)
  else if (o.type === 'assistant') applyAssistantLine(o, state)
}

interface CacheEntry {
  size: number
  mtimeMs: number
  offset: number
  state: ChatBuildState
}

/**
 * Кэш разбора транскрипта чата на процесс main — параллель `TranscriptCache`, но с состоянием сообщений вместо
 * расхода токенов (поэтому отдельный класс, не переиспользование `TranscriptCache.read`). Файл не менялся —
 * состояние из кэша; вырос — дочитывается хвост; уменьшился или переписан — разбор заново (новая сессия ассистента,
 * `reset`, работает на новом `sessionId`, поэтому переписывания старого файла на практике не бывает).
 */
export class AssistantChatCache {
  private files = new Map<string, CacheEntry>()

  async read(path: string): Promise<ChatBuildState | undefined> {
    let st
    try {
      st = await stat(path)
    } catch {
      this.files.delete(path)
      return undefined
    }
    let entry = this.files.get(path)
    if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) return entry.state
    if (!entry || st.size < entry.offset) entry = { size: 0, mtimeMs: 0, offset: 0, state: emptyChatState() }
    try {
      entry.offset = await readLines(path, entry.offset, st.size, (line) => {
        try {
          applyChatLine(line, entry.state)
        } catch {
          // Битая строка (обрыв записи на середине, чужой формат) — пропускаем, как TranscriptCache.
        }
      })
    } catch {
      return this.files.get(path)?.state
    }
    entry.size = st.size
    entry.mtimeMs = st.mtimeMs
    this.files.set(path, entry)
    return entry.state
  }
}

/** Путь к файлу сессии Claude Code ассистента — детерминированный: `sessionId` задан приложением через `--session-id`. */
export function assistantTranscriptPath(env: TranscriptEnv, cwd: string, sessionId: string): string {
  return join(env.claudeDir, 'projects', claudeSlug(cwd), `${sessionId}.jsonl`)
}

/** `assistantChat.available`: агент без `sessionId` (не принимает `--session-id`) или файл ещё не появился — false. */
export async function assistantChatAvailable(env: TranscriptEnv, cwd: string, sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false
  try {
    await stat(assistantTranscriptPath(env, cwd, sessionId))
    return true
  } catch {
    return false
  }
}

/** Снимок для `assistantChat.getMessages`: последние `ASSISTANT_CHAT_MESSAGE_LIMIT` сообщений. */
export function chatSnapshot(ptyId: string, state: ChatBuildState | undefined): AssistantChatSnapshot {
  const messages = state ? state.messages.slice(-ASSISTANT_CHAT_MESSAGE_LIMIT) : []
  return { ptyId, messages, status: state?.status ?? 'done' }
}

/** Глубокая копия — `onMessage` шлёт снимок сообщения, а не ссылку на объект, который `applyChatLine` мутирует дальше. */
function cloneMessage(m: AssistantChatMessage): AssistantChatMessage {
  return { ...m, toolCalls: m.toolCalls?.map((c) => ({ ...c })) }
}

/**
 * События для `assistantChat.onMessage` с прошлого вызова: изменённые сообщения (`state.touched`, очищается)
 * и смена статуса сессии (сравнение с `prevStatus`, которое хранит вызывающий код между тиками).
 */
export function drainChatUpdates(ptyId: string, state: ChatBuildState, prevStatus: AssistantChatStatus | undefined): AssistantChatUpdate[] {
  const updates: AssistantChatUpdate[] = []
  for (const index of state.touched) {
    const m = state.messages[index]
    if (m) updates.push({ ptyId, message: cloneMessage(m) })
  }
  state.touched.clear()
  if (state.status !== prevStatus) updates.push({ ptyId, status: state.status })
  return updates
}

/**
 * Байты для `pty.write` при отправке сообщения из чата: как реальная вставка в терминал. Однострочный текст —
 * просто `text + '\r'` (Enter); многострочный — обёрнут в bracketed paste (`ESC[200~ … ESC[201~`), иначе
 * интерактивный агент (readline в raw-режиме) принял бы перевод строки внутри текста за отдельные Enter и отправил
 * сообщение по первой строке.
 */
export function chatInputBytes(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized.includes('\n')) return `\x1b[200~${normalized}\x1b[201~\r`
  return `${normalized}\r`
}
