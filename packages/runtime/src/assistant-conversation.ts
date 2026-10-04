import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AssistantTransportMessages } from './assistant-conversation-messages.ts'
import type { AssistantConversation, ConversationOptions } from './assistant-conversation-types.ts'
import { CONVERSATION_MESSAGE_LIMIT } from '@orca-board/contracts'
import type {
  ConversationInteraction, ConversationMessage,
  ConversationSnapshot, ConversationBinding, ConversationStatus, ConversationToolCall, ConversationUpdate,
  InteractionAnswer, InteractionOption, InteractionQuestion
} from '@orca-board/contracts'

type JsonObject = Record<string, unknown>
type Protocol = 'claude' | 'codex' | 'acp'
type RpcId = string | number
interface PendingRequest { resolve(value: JsonObject): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }
interface PendingInteraction {
  value: ConversationInteraction
  wireId: RpcId
  answer(answer: InteractionAnswer): void
  cancel(): void
}
interface PromptAcceptance { turn: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface ClaudeBlock { type: string; text: string; json: string; id?: string; name?: string; input?: unknown }

const MAX_LINE = 2 * 1024 * 1024
const HANDSHAKE_TIMEOUT = 30_000
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value)
const copy = <T>(value: T): T => structuredClone(value)
const rpcKey = (id: RpcId): string => `${typeof id}:${id}`
const isRpcId = (id: unknown): id is RpcId => typeof id === 'string' || typeof id === 'number'

function preview(input: unknown): string {
  const data = object(input)
  return (string(data.description) || string(data.command) || string(data.path) || string(data.file_path) || JSON.stringify(input ?? {})).slice(0, 4000)
}

/** Карточка разрешения показывает полные аргументы, а не краткое описание действия. */
function permissionArguments(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input ?? {}, null, 2)
}

/** PATH передаёт вызывающая сторона; стандартные папки нужны Electron, запущенному из Finder. */
function findExecutable(deps: ConversationServicesDeps, name: string, env: NodeJS.ProcessEnv, platform = deps.platform): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? ''
  const dirs = pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  const home = deps.homeDir
  dirs.push(...(platform === 'win32'
    ? [env.APPDATA ? join(env.APPDATA, 'npm') : '', join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.cargo', 'bin')]
    : ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), join(home, '.cargo', 'bin')]))
  const suffixes = platform === 'win32' ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.toLowerCase()), ''] : ['']
  for (const dir of dirs.filter(Boolean)) for (const suffix of suffixes) {
    const file = isAbsolute(name) ? name : join(dir, name + suffix)
    try { accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return file } catch { /* Следующий кандидат. */ }
  }
  return undefined
}

/** npm-shim разворачивается без cmd.exe: промпты и метасимволы никогда не попадают в shell. */
function structuredLaunch(deps: ConversationServicesDeps, command: string, args: string[], env: NodeJS.ProcessEnv, platform = deps.platform): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const file = findExecutable(deps, command, env, platform)
  if (!file) throw new Error(deps.messages('assistantTransport.missingCli', { command }))
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { command: file, args, env }
  const source = readFileSync(file, 'utf8')
  const targets = [...source.matchAll(/"%(?:~dp0|dp0%)\\?([^"%]+\.(?:js|cjs|mjs|exe))"/gi)].map((m) => m[1]).filter((target) => !/(?:^|[\\/])node\.exe$/i.test(target))
  const target = targets.at(-1)
  if (!target) throw new Error(deps.messages('assistantTransport.windowsLauncher', { command }))
  const entry = resolve(dirname(file), target)
  if (!existsSync(entry)) throw new Error(deps.messages('assistantTransport.windowsEntry', { entry }))
  if (/\.exe$/i.test(entry)) return { command: entry, args, env }
  const localNode = join(dirname(file), 'node.exe')
  const configuredNode = env.ORCA_NODE && existsSync(env.ORCA_NODE) ? env.ORCA_NODE : undefined
  const node = existsSync(localNode) ? localNode : configuredNode ?? findExecutable(deps, 'node', env, platform) ?? deps.executablePath
  return { command: node, args: [entry, ...args], env: node === deps.executablePath ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env }
}

export interface ConversationServicesDeps {
  messages: AssistantTransportMessages
  env(): NodeJS.ProcessEnv
  homeDir: string
  executablePath: string
  platform: NodeJS.Platform
}

/** Каждый host задаёт своё окружение и сообщения; все provider conversations имеют отдельное состояние. */
export function createAssistantConversationServices(deps: ConversationServicesDeps) {
  const conversations = new Set<Conversation>()
  let stopped = false
  return {
    create(options: ConversationOptions): AssistantConversation {
      if (stopped) throw new Error('Служба диалогов остановлена')
      const conversation = new Conversation(options, deps); conversations.add(conversation)
      void conversation.finished.then(() => conversations.delete(conversation))
      return conversation
    },
    async stop(): Promise<void> {
      stopped = true
      const owned = [...conversations]; for (const conversation of owned) conversation.dispose()
      await Promise.all(owned.map(conversation => conversation.finished))
    },
    structuredLaunch(command: string, args: string[], env: NodeJS.ProcessEnv, platform = deps.platform) {
      return structuredLaunch(deps, command, args, env, platform)
    }
  }
}

class Conversation implements AssistantConversation {
  readonly id = randomUUID()
  private readonly options: ConversationOptions
  private readonly deps: ConversationServicesDeps
  private readonly protocol: Protocol
  private readonly ready: Promise<void>
  private child?: ChildProcessWithoutNullStreams
  private closed = false
  readonly finished: Promise<void>
  private finishExit!: () => void
  private failed = false
  private active = false
  private cancelling = false
  private firstPrompt = true
  private state: ConversationStatus = 'starting'
  private error?: string
  private messages: ConversationMessage[] = []
  private interactions = new Map<string, PendingInteraction>()
  private requests = new Map<string, PendingRequest>()
  private tools = new Map<string, ConversationMessage>()
  private toolArguments = new Map<string, string>()
  private incoming = ''
  private stderr = ''
  private threadId = ''
  private turnId = ''
  private sequence = 0
  private turnSequence = 0
  private acpMessageId = ''
  private claudeMessageId = ''
  private claudeOpenIndex = 0
  private claudeBlocks = new Map<string, ClaudeBlock>()
  private turnAgentText = false
  private codexStarting = false
  private codexDeferred: JsonObject[] = []
  private promptAcceptance?: PromptAcceptance
  private killTimer?: ReturnType<typeof setTimeout>
  private replyFlushTimer?: ReturnType<typeof setTimeout>

  constructor(options: ConversationOptions, deps: ConversationServicesDeps) {
    this.options = options
    this.deps = deps
    this.protocol = options.agent === 'claude' ? 'claude' : options.agent === 'codex' ? 'codex' : 'acp'
    this.finished = new Promise(resolve => { this.finishExit = resolve })
    this.ready = Promise.resolve().then(() => { if (this.closed) { this.finishExit(); return }; return this.start() }).catch((error: unknown) => { if (!this.child) this.finishExit(); this.fail(errorText(error)); throw error })
    // Создание синхронное: ошибка старта попадёт в snapshot, даже если send ещё не вызван.
    void this.ready.catch(() => undefined)
  }

  snapshot(): ConversationSnapshot {
    const providerBinding: ConversationBinding = {
      transport: this.protocol === 'claude' ? 'claude-stream-json' : this.protocol === 'codex' ? 'codex-app-server' : 'acp',
      ...(this.protocol === 'claude' ? { sessionId: this.id } : this.threadId ? { sessionId: this.threadId } : {})
    }
    return copy({ providerBinding, id: this.id, agent: this.options.agent, messages: this.messages, status: this.state, interactions: [...this.interactions.values()].map((pending) => pending.value), ...(this.error ? { error: this.error } : {}) })
  }

  async send(text: string, context?: string): Promise<void> {
    this.assertOpen()
    if (typeof text !== 'string' || !text.trim() || text.length > 1_000_000) throw new Error(this.deps.messages('assistantTransport.invalidMessage'))
    await this.ready
    this.assertOpen()
    if (this.failed) throw new Error(this.error ?? this.deps.messages('assistantTransport.unavailable'))
    if (this.active) throw new Error(this.deps.messages('assistantTransport.busy'))
    this.active = true
    this.cancelling = false
    this.turnId = ''
    this.turnSequence += 1
    this.acpMessageId = ''
    this.claudeMessageId = ''
    this.claudeBlocks.clear()
    this.turnAgentText = false
    this.tools.clear()
    this.setState('thinking')
    // Host callback может синхронно закрыть driver, например при ошибке истории.
    this.assertOpen()
    const providerText = context ? `${context}\n\n${text}` : text
    const human: ConversationMessage = { id: randomUUID(), role: 'human', text, at: Date.now() }
    try {
      // Handoff ждёт acceptance; оригинальный текст уже должен предшествовать раннему ответу.
      if (context !== undefined) { this.putMessage(human); this.assertOpen() }
      if (this.protocol === 'claude') {
        this.write({ type: 'user', session_id: this.id, parent_tool_use_id: null, message: { role: 'user', content: providerText } })
      } else if (this.protocol === 'codex') {
        // turn/start подтверждает приём; ответ модели приходит отдельными notifications.
        this.codexStarting = true
        this.codexDeferred = []
        const turn = this.turnSequence
        const acceptance = context !== undefined ? this.waitForPromptAcceptance(turn) : undefined
        const accepted = this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: providerText }], cwd: null, approvalPolicy: null, sandboxPolicy: null, model: this.options.model ?? null, effort: this.options.effort ?? null, summary: null }, context !== undefined ? HANDSHAKE_TIMEOUT : undefined)
        const started = accepted.then((result) => {
          if (this.closed || !this.active || turn !== this.turnSequence) return
          this.turnId = string(object(result.turn).id)
          if (!this.turnId) throw new Error(this.deps.messages('assistantTransport.noTurn'))
          this.codexStarting = false
          this.acceptPrompt(turn)
          const deferred = this.codexDeferred.splice(0)
          for (const frame of deferred) this.receive(frame)
        }).catch((error: unknown) => { if (!this.closed && turn === this.turnSequence) this.fail(errorText(error)); throw error })
        // Только handoff ждёт ACK: обычный send сохраняет прежний early-resolve контракт.
        void started.catch(() => undefined)
        if (acceptance) await acceptance
      } else {
        const prompt = this.firstPrompt && this.options.system ? `${this.options.system}\n\n${providerText}` : providerText
        const turn = this.turnSequence
        // ACP не имеет ACK: принятие подтверждает первая activity/permission либо успешный final response.
        // Ошибка до этого отклоняет handoff; завершения turn и ответа человека не ждём.
        const accepted = context !== undefined ? this.waitForPromptAcceptance(turn) : undefined
        void this.request('session/prompt', { sessionId: this.threadId, prompt: [{ type: 'text', text: prompt }] }).then((result) => {
          if (this.closed || turn !== this.turnSequence) return
          const cancelled = string(result.stopReason) === 'cancelled' || this.cancelling
          if (cancelled) this.rejectPrompt(new Error(this.deps.messages('assistantTransport.interruptedSend')))
          else this.acceptPrompt(turn)
          if (!this.closed && turn === this.turnSequence && this.active) this.finish(cancelled ? 'interrupted' : 'done')
        }).catch((error: unknown) => { if (!this.closed && turn === this.turnSequence) this.fail(errorText(error)) })
        if (accepted) await accepted
      }
      this.firstPrompt = false
      if (context === undefined) this.putMessage(human)
    } catch (error) {
      this.rejectPrompt(error instanceof Error ? error : new Error(errorText(error)))
      if (!this.cancelling) this.fail(errorText(error))
      throw error
    }
  }

  async interrupt(): Promise<void> {
    this.assertOpen()
    await this.ready
    if (!this.active) return
    this.cancelling = true
    this.rejectPrompt(new Error(this.deps.messages('assistantTransport.interruptedSend')))
    this.cancelTools()
    if (this.protocol === 'claude') {
      const interrupted = this.control('interrupt', {}, HANDSHAKE_TIMEOUT)
      this.clearInteractions(false)
      await interrupted
    } else if (this.protocol === 'codex') {
      this.clearInteractions(true)
      if (!this.turnId) await this.waitForTurnId()
      if (this.active) await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, HANDSHAKE_TIMEOUT)
    } else {
      this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.threadId } })
      this.clearInteractions(true)
    }
  }

  async respond(requestId: string, answer: InteractionAnswer): Promise<void> {
    this.assertOpen()
    const pending = this.interactions.get(requestId)
    if (!pending) throw new Error(this.deps.messages('assistantTransport.staleRequest'))
    validateAnswer(pending.value, answer, this.deps.messages)
    pending.answer(answer)
    this.removeInteraction(requestId)
    if (this.active && !this.interactions.size) this.setState('thinking')
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.rejectPrompt(new Error(this.deps.messages('assistantTransport.closed')))
    this.rejectRequests(new Error(this.deps.messages('assistantTransport.closed')))
    this.interactions.clear()
    this.stopChild()
  }

  private waitForPromptAcceptance(turn: number): Promise<void> {
    this.assertOpen()
    const accepted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.deps.messages('assistantTransport.timeout')), HANDSHAKE_TIMEOUT)
      this.promptAcceptance = { turn, resolve, reject, timer }
    })
    // Синхронная ошибка записи может возникнуть раньше await в send.
    void accepted.catch(() => undefined)
    return accepted
  }

  private acceptPrompt(turn: number): void {
    const pending = this.promptAcceptance
    if (!pending || pending.turn !== turn) return
    this.promptAcceptance = undefined
    clearTimeout(pending.timer)
    pending.resolve()
  }

  private rejectPrompt(error: Error): void {
    const pending = this.promptAcceptance
    if (!pending) return
    this.promptAcceptance = undefined
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private assertOpen(): void { if (this.closed) throw new Error(this.deps.messages('assistantTransport.closed')) }
  private emit(update: ConversationUpdate): void { if (!this.closed) this.options.onUpdate(copy(update)) }

  private setState(status: ConversationStatus, error?: string): void {
    if (this.closed) return
    this.state = status
    this.error = error
    this.emit({ type: 'state', status, ...(error ? { error } : {}) })
  }

  private putMessage(message: ConversationMessage): void {
    if (this.closed) return
    const existing = this.messages.findIndex((m) => m.id === message.id)
    if (existing < 0) this.messages.push(message)
    else this.messages[existing] = message
    if (this.messages.length > CONVERSATION_MESSAGE_LIMIT) {
      const removed = this.messages.splice(0, this.messages.length - CONVERSATION_MESSAGE_LIMIT)
      for (const old of removed) for (const tool of old.toolCalls ?? []) if (tool.id) { this.tools.delete(tool.id); this.toolArguments.delete(tool.id) }
    }
    this.emit({ type: 'message', message })
  }

  private agentText(id: string, text: string, append = false): void {
    const previous = this.messages.find((m) => m.id === id)
    this.putMessage({ id, role: 'agent', text: append ? `${previous?.text ?? ''}${text}` : text, at: previous?.at ?? Date.now() })
    this.turnAgentText ||= Boolean(text)
  }

  private tool(id: string, name: string, input: unknown, status: ConversationToolCall['status'] = 'running', output?: string): void {
    if (input !== undefined) this.toolArguments.set(id, permissionArguments(input))
    const previous = this.tools.get(id)
    const existing = previous?.toolCalls?.[0]
    const call: ConversationToolCall = { id, name: name || existing?.name || this.deps.messages('assistantTransport.tool'), input: input === undefined ? existing?.input ?? '' : preview(input), status: existing?.status === 'cancelled' ? 'cancelled' : status }
    const message: ConversationMessage = { id: previous?.id ?? `tool:${this.turnSequence}:${id}`, role: 'tool', text: output ?? previous?.text ?? '', at: previous?.at ?? Date.now(), toolCalls: [call] }
    this.tools.set(id, message)
    this.putMessage(message)
    this.acpMessageId = ''
  }

  private cancelTools(): void {
    for (const [id, message] of this.tools) if (message.toolCalls?.[0]?.status === 'running') this.tool(id, '', undefined, 'cancelled')
  }

  private finish(status: 'done' | 'interrupted' | 'error', error?: string): void {
    if (!this.active || this.closed) return
    if (status === 'interrupted') this.cancelTools()
    this.active = false
    this.clearInteractions(false)
    this.setState(status, error)
  }

  private fail(message: string, flushReply = false): void {
    if (this.closed || this.failed) return
    this.failed = true
    this.rejectPrompt(new Error(message))
    this.active = false
    this.cancelTools()
    this.clearInteractions(false)
    this.rejectRequests(new Error(message))
    this.setState('error', message)
    if (flushReply && !this.closed && this.child && !this.child.stdin.destroyed && this.child.stdin.writable) {
      // EOF идёт после уже записанного ответа: занятый CLI сможет прочитать его.
      // Если CLI не завершится сам, ограничиваем ожидание перед остановкой своей группы.
      this.child.stdin.end()
      this.replyFlushTimer = setTimeout(() => this.stopChild(), 1500)
      this.replyFlushTimer.unref()
    } else this.stopChild()
  }

  private stopChild(): void {
    if (this.replyFlushTimer) { clearTimeout(this.replyFlushTimer); this.replyFlushTimer = undefined }
    const child = this.child
    if (!child?.pid || this.killTimer) return
    const pid = child.pid
    child.stdin.destroy()
    if (this.deps.platform === 'win32') {
      // Только дерево собственного PID; npm-shim уже развёрнут в native/Node executable.
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false })
      killer.on('error', () => child.kill('SIGKILL'))
      killer.on('exit', (code) => { if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    } else {
      // detached создал отдельную группу: Bash и дочерние CLI завершаются вместе с агентом.
      try { process.kill(-pid, 'SIGTERM') } catch { /* Группа уже завершилась. */ }
    }
    this.killTimer = setTimeout(() => {
      if (this.deps.platform === 'win32') { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
      else { try { process.kill(-pid, 'SIGKILL') } catch { /* Группа уже завершилась. */ } }
    }, 1500)
    this.killTimer.unref()
  }

  private write(frame: JsonObject): void {
    this.assertOpen()
    if (!this.child || this.failed || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error(this.error ?? this.deps.messages('assistantTransport.writeUnavailable'))
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private request(method: string, params: JsonObject, timeout?: number): Promise<JsonObject> {
    const id = `${this.id}:${++this.sequence}`
    return this.pending(id, () => this.write({ ...(this.protocol === 'acp' ? { jsonrpc: '2.0' } : {}), id, method, params }), timeout)
  }

  private control(subtype: string, fields: JsonObject = {}, timeout?: number): Promise<JsonObject> {
    const id = `${this.id}:${++this.sequence}`
    return this.pending(id, () => this.write({ type: 'control_request', request_id: id, request: { subtype, ...fields } }), timeout)
  }

  private pending(id: RpcId, send: () => void, timeout?: number): Promise<JsonObject> {
    const key = rpcKey(id)
    let pending!: PendingRequest
    const promise = new Promise<JsonObject>((resolveRequest, reject) => {
      pending = { resolve: resolveRequest, reject }
      if (timeout) pending.timer = setTimeout(() => { this.requests.delete(key); reject(new Error(this.deps.messages('assistantTransport.timeout'))) }, timeout)
      this.requests.set(key, pending)
    })
    // Ошибка записи синхронно отклоняет send, чтобы renderer сохранил черновик.
    try { send() } catch (error) { this.requests.delete(key); if (pending.timer) clearTimeout(pending.timer); throw error }
    return promise
  }

  private resolveRequest(id: RpcId, result: unknown, error?: unknown): void {
    const pending = this.requests.get(rpcKey(id))
    if (!pending) return
    this.requests.delete(rpcKey(id))
    if (pending.timer) clearTimeout(pending.timer)
    if (error !== undefined) pending.reject(new Error(string(object(error).message) || errorText(error)))
    else pending.resolve(object(result))
  }

  private rejectRequests(error: Error): void {
    for (const pending of this.requests.values()) { if (pending.timer) clearTimeout(pending.timer); pending.reject(error) }
    this.requests.clear()
  }

  private reply(id: RpcId, result: JsonObject): void { this.write({ ...(this.protocol === 'acp' ? { jsonrpc: '2.0' } : {}), id, result }) }
  private replyControl(id: RpcId, result: JsonObject): void { this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: result } }) }

  private addInteraction(wireId: RpcId, value: Omit<ConversationInteraction, 'id'>, answer: PendingInteraction['answer'], cancel: PendingInteraction['cancel']): void {
    if (this.closed || this.cancelling || !this.active) { cancel(); return }
    const id = `${this.id}:interaction:${++this.sequence}`
    const interaction = { ...value, id }
    this.acceptPrompt(this.turnSequence)
    this.interactions.set(id, { value: interaction, wireId, answer, cancel })
    this.emit({ type: 'interaction', interaction })
    this.setState('waiting')
  }

  private removeInteraction(id: string): void { if (this.interactions.delete(id)) this.emit({ type: 'interaction-resolved', requestId: id }) }

  private clearInteractions(answerCancelled: boolean): void {
    for (const [id, pending] of [...this.interactions]) {
      if (answerCancelled && !this.closed && !this.failed) pending.cancel()
      this.removeInteraction(id)
    }
  }

  private async start(): Promise<void> {
    this.assertOpen()
    if (this.options.agent === 'amp' || this.options.agent === 'shell') throw new Error(this.deps.messages('assistantTransport.terminalOnly', { agent: this.options.agent }))
    if (this.protocol === 'acp' && this.options.effort) throw new Error(this.deps.messages('assistantTransport.effortUnsupported', { agent: this.options.agent }))
    const env: NodeJS.ProcessEnv = { ...this.deps.env(), ...this.options.env }
    for (const name of Object.keys(env)) if (name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_')) delete env[name]
    for (const name of ['ORCA_PROJECT', 'ORCA_RUN_ID', 'ORCA_TASK_ID', 'ORCA_DISPATCH_ID']) delete env[name]
    if (this.options.projectId !== undefined) env.ORCA_PROJECT = this.options.projectId
    env.ORCA_ROLE = 'assistant'
    let command = this.options.agent as string
    let args: string[]
    if (this.protocol === 'claude') {
      args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'auto', '--allowedTools', 'Bash(orca-board:*)', '--session-id', this.id, '--append-system-prompt', this.options.system]
      if (this.options.model) args.push('--model', this.options.model)
      if (this.options.effort) args.push('--effort', this.options.effort)
    } else if (this.protocol === 'codex') args = ['app-server']
    else {
      if (this.options.agent === 'cursor') command = findExecutable(this.deps, 'agent', env) ? 'agent' : 'cursor-agent'
      args = this.options.agent === 'gemini' ? ['--acp'] : this.options.agent === 'copilot' ? ['--acp', '--stdio'] : ['acp']
      if (this.options.model && (this.options.agent === 'gemini' || this.options.agent === 'cursor')) args.push('--model', this.options.model)
    }
    // Подкоманда Codex/Goose идёт первой: variadic-флаг пользователя не должен поглотить её.
    // Остальные служебные опции завершают argv, сохраняя выбор протокола приложения.
    const extra = this.options.extraArgs ?? []
    args = this.options.agent === 'goose' || this.protocol === 'codex' ? [args[0], ...extra, ...args.slice(1)] : [...extra, ...args]
    const launch = structuredLaunch(this.deps, command, args, env)
    this.child = spawn(launch.command, launch.args, { cwd: this.options.cwd, env: launch.env, stdio: 'pipe', windowsHide: true, shell: false, detached: this.deps.platform !== 'win32' })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000) })
    this.child.stdin.on('error', (error: Error) => this.fail(error.message))
    this.child.on('error', (error: Error) => this.fail(this.deps.messages('assistantTransport.startFailed', { command, error: error.message })))
    this.child.on('close', (code: number | null) => {
      if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = undefined }
      this.finishExit()
      if (!this.closed && !this.failed) this.fail(this.deps.messages('assistantTransport.processExited', { command, code: code ?? 'signal', detail: this.stderr.trim() }).trim())
      else if (this.replyFlushTimer) this.stopChild()
    })
    if (this.protocol === 'claude') await this.control('initialize', { hooks: null }, HANDSHAKE_TIMEOUT)
    else if (this.protocol === 'codex') {
      await this.request('initialize', { clientInfo: { name: 'orca-board', version: '1.0.0' } }, HANDSHAKE_TIMEOUT)
      this.write({ method: 'initialized' })
      const result = await this.request('thread/start', { model: this.options.model ?? null, modelProvider: null, cwd: this.options.cwd, approvalPolicy: null, sandbox: null, config: null, baseInstructions: null, developerInstructions: this.options.system || null, experimentalRawEvents: false }, HANDSHAKE_TIMEOUT)
      this.threadId = string(object(result.thread).id)
    } else {
      const result = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'orca-board', version: '1.0.0' } }, HANDSHAKE_TIMEOUT)
      if (result.protocolVersion !== 1) throw new Error(this.deps.messages('assistantTransport.acpVersion'))
      const session = await this.request('session/new', { cwd: this.options.cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT)
      this.threadId = string(session.sessionId)
      // Старый ACP отдаёт models, новый — configOptions; CLI-флаг Gemini/Cursor служит совместимым запасным путём.
      if (this.options.model) {
        const models = object(session.models)
        const config = list(session.configOptions).map(object).find((value) => value.category === 'model' || value.id === 'model')
        if (config) {
          const available = list(config.options).flatMap((value) => { const option = object(value); return option.value === undefined ? list(option.options).map(object) : [option] })
          if (!available.some((value) => value.value === this.options.model)) throw new Error(this.deps.messages('assistantTransport.modelUnavailable', { model: this.options.model }))
          if (config.currentValue !== this.options.model) await this.request('session/set_config_option', { sessionId: this.threadId, configId: config.id, value: this.options.model }, HANDSHAKE_TIMEOUT)
        } else if (list(models.availableModels).length) {
          if (!list(models.availableModels).some((value) => string(object(value).modelId) === this.options.model)) throw new Error(this.deps.messages('assistantTransport.modelUnavailable', { model: this.options.model }))
          if (models.currentModelId !== this.options.model) await this.request('session/set_model', { sessionId: this.threadId, modelId: this.options.model }, HANDSHAKE_TIMEOUT)
        } else if (this.options.agent !== 'gemini' && this.options.agent !== 'cursor') throw new Error(this.deps.messages('assistantTransport.modelUnsupported', { agent: this.options.agent }))
      }
    }
    if (this.protocol !== 'claude' && !this.threadId) throw new Error(this.deps.messages('assistantTransport.noSession'))
    this.assertOpen()
    this.setState('done')
  }

  private consume(chunk: string): void {
    if (this.closed || this.failed) return
    this.incoming += chunk
    let newline: number
    while ((newline = this.incoming.indexOf('\n')) >= 0) {
      const line = this.incoming.slice(0, newline).trim()
      this.incoming = this.incoming.slice(newline + 1)
      if (!line) continue
      if (line.length > MAX_LINE) { this.fail(this.deps.messages('assistantTransport.lineTooLarge')); return }
      let frame: unknown
      try { frame = JSON.parse(line) } catch { this.fail(this.deps.messages('assistantTransport.invalidJson')); return }
      try { this.receive(object(frame)) } catch (error) { this.fail(errorText(error)); return }
    }
    if (this.incoming.length > MAX_LINE) this.fail(this.deps.messages('assistantTransport.lineTooLarge'))
  }

  private receive(frame: JsonObject): void {
    if (this.protocol === 'claude') { this.receiveClaude(frame); return }
    if (isRpcId(frame.id) && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) { this.resolveRequest(frame.id, frame.result, frame.error); return }
    if (this.protocol === 'codex' && this.codexStarting && typeof frame.method === 'string') {
      if (this.codexDeferred.length >= 1000) { this.fail(this.deps.messages('assistantTransport.noTurn')); return }
      this.codexDeferred.push(frame)
      return
    }
    if (isRpcId(frame.id) && typeof frame.method === 'string') {
      if (this.protocol === 'codex') this.codexRequest(frame.id, frame.method, object(frame.params))
      else this.acpRequest(frame.id, frame.method, object(frame.params))
      return
    }
    if (this.protocol === 'codex') this.codexNotification(string(frame.method), object(frame.params))
    else if (frame.method === 'session/update') this.acpUpdate(object(frame.params))
  }

  private receiveClaude(frame: JsonObject): void {
    if (frame.type === 'control_response') {
      const response = object(frame.response)
      if (isRpcId(response.request_id)) this.resolveRequest(response.request_id, response.response, response.subtype === 'error' ? response.error : undefined)
      return
    }
    if (frame.type === 'control_cancel_request') {
      for (const [id, pending] of this.interactions) if (pending.wireId === frame.request_id) this.removeInteraction(id)
      if (this.active && !this.interactions.size && !this.cancelling) this.setState('thinking')
      return
    }
    if (frame.type === 'control_request' && isRpcId(frame.request_id)) {
      const request = object(frame.request)
      if (request.subtype === 'can_use_tool') this.claudePermission(frame.request_id, request)
      else this.write({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unsupported control request' } })
      return
    }
    if (!this.active) return
    if (frame.type === 'stream_event') {
      const event = object(frame.event)
      if (event.type === 'message_start') this.claudeMessageId = string(object(event.message).id) || randomUUID()
      const index = typeof event.index === 'number' ? event.index : 0
      const key = `${this.claudeMessageId}:${index}`
      if (event.type === 'content_block_start') {
        this.claudeOpenIndex = index
        const content = object(event.content_block)
        const block: ClaudeBlock = { type: string(content.type), text: string(content.text), json: '', id: string(content.id), name: string(content.name), input: content.input }
        this.claudeBlocks.set(key, block)
        if (block.type === 'tool_use' && block.id) this.tool(block.id, block.name ?? '', block.input)
        else if (block.type === 'text' && block.text) this.agentText(`claude:${key}`, block.text)
      } else if (event.type === 'content_block_delta') {
        const block = this.claudeBlocks.get(key)
        const delta = object(event.delta)
        if (block && delta.type === 'text_delta') { block.text += string(delta.text); this.agentText(`claude:${key}`, block.text) }
        else if (block && delta.type === 'input_json_delta') block.json += string(delta.partial_json)
      } else if (event.type === 'content_block_stop') {
        const block = this.claudeBlocks.get(key)
        if (block?.type === 'tool_use' && block.id && block.json) { try { this.tool(block.id, block.name ?? '', JSON.parse(block.json)) } catch { /* Неполный JSON не заменяет завершённый tool_use. */ } }
      }
    } else if (frame.type === 'assistant') {
      const message = object(frame.message)
      const messageId = string(message.id) || string(frame.uuid) || randomUUID()
      const content = list(message.content)
      content.forEach((raw, offset) => {
        const block = object(raw)
        if (block.type === 'text') {
          const index = messageId === this.claudeMessageId && content.length === 1 ? this.claudeOpenIndex : offset
          this.agentText(`claude:${messageId}:${index}`, string(block.text))
        } else if (block.type === 'tool_use') this.tool(string(block.id) || randomUUID(), string(block.name), block.input)
      })
    } else if (frame.type === 'user') {
      for (const raw of list(object(frame.message).content)) {
        const block = object(raw)
        if (block.type === 'tool_result') {
          const output = typeof block.content === 'string' ? block.content : list(block.content).map((entry) => string(object(entry).text)).join('\n')
          this.tool(string(block.tool_use_id), '', undefined, block.is_error === true ? 'error' : 'ok', output.slice(0, 8000))
        }
      }
    } else if (frame.type === 'result') {
      if (!this.turnAgentText && string(frame.result)) this.agentText(`claude:result:${this.turnSequence}`, string(frame.result))
      const error = frame.is_error === true ? list(frame.errors).map(String).join('\n') || string(frame.result) || string(frame.subtype) : undefined
      this.finish(this.cancelling ? 'interrupted' : error ? 'error' : 'done', error)
    }
  }

  private claudePermission(id: RpcId, request: JsonObject): void {
    const input = object(request.input)
    const name = string(request.tool_name)
    const deny = (): void => this.replyControl(id, { behavior: 'deny', message: 'User cancelled the request.' })
    if (name === 'AskUserQuestion') {
      const questions: InteractionQuestion[] = list(input.questions).map((raw, index) => {
        const question = object(raw)
        return { id: String(index), question: string(question.question), header: string(question.header), options: list(question.options).map((entry, optionIndex) => { const option = object(entry); return { id: String(optionIndex), label: string(option.label), description: string(option.description) } }), multiSelect: question.multiSelect === true, allowFreeform: true }
      })
      this.addInteraction(id, { kind: 'question', title: this.deps.messages('assistantTransport.question'), questions }, (answer) => {
        if (answer.kind === 'cancel') { deny(); return }
        const answers = answerLabels(questions, answer)
        const mapped: Record<string, string> = Object.create(null) as Record<string, string>
        for (const question of questions) mapped[question.question] = answers[question.id].join(', ')
        this.replyControl(id, { behavior: 'allow', updatedInput: { ...input, answers: mapped } })
      }, deny)
    } else {
      this.addInteraction(id, { kind: 'permission', title: name || this.deps.messages('assistantTransport.tool'), text: preview(input), tool: { name, input: permissionArguments(input) }, options: [{ id: 'allow', label: this.deps.messages('assistantTransport.allow'), kind: 'allow_once' }, { id: 'deny', label: this.deps.messages('assistantTransport.deny'), kind: 'reject_once' }] }, (answer) => {
        if (answer.kind === 'option' && answer.optionId === 'allow') this.replyControl(id, { behavior: 'allow', updatedInput: input })
        else deny()
      }, deny)
    }
  }

  private codexRequest(id: RpcId, method: string, params: JsonObject): void {
    const thread = string(params.threadId) || string(params.conversationId)
    if (thread && thread !== this.threadId) { this.rpcUnsupported(id, method); return }
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
    if (typeof params.turnId === 'string' && params.turnId !== this.turnId) {
      this.reply(id, { decision: legacy ? 'abort' : 'cancel' })
      return
    }
    if (legacy || method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const itemId = string(params.itemId) || string(params.callId)
      const existing = this.tools.get(itemId)?.toolCalls?.[0]
      const name = existing?.name || this.deps.messages(method.includes('file') || method.includes('Patch') ? 'assistantTransport.fileChange' : 'assistantTransport.command')
      const input = params.command != null || params.changes != null ? permissionArguments(params) : this.toolArguments.get(itemId) || existing?.input || permissionArguments(params)
      const options: InteractionOption[] = [{ id: 'accept', label: this.deps.messages('assistantTransport.allow'), kind: 'allow_once' }, { id: 'acceptForSession', label: this.deps.messages('assistantTransport.allowSession'), kind: 'allow_always' }, { id: 'decline', label: this.deps.messages('assistantTransport.deny'), kind: 'reject_once' }, { id: 'cancel', label: this.deps.messages('assistantTransport.cancelTurn'), kind: 'reject_once' }]
      const native = (decision: string): string => legacy ? ({ accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied', cancel: 'abort' } as Record<string, string>)[decision] : decision
      this.addInteraction(id, { kind: 'permission', title: name, text: string(params.reason), tool: { name, input }, options }, (answer) => {
        const decision = answer.kind === 'option' ? answer.optionId : 'cancel'
        this.reply(id, { decision: native(decision) })
      }, () => this.reply(id, { decision: native('cancel') }))
    } else if (method === 'item/tool/requestUserInput') {
      const questions: InteractionQuestion[] = list(params.questions).map((raw) => {
        const question = object(raw)
        return { id: string(question.id), question: string(question.question), header: string(question.header), options: list(question.options).map((entry, index) => { const option = object(entry); return { id: String(index), label: string(option.label), description: string(option.description) } }), multiSelect: false, allowFreeform: question.isOther !== false }
      })
      this.addInteraction(id, { kind: 'question', title: this.deps.messages('assistantTransport.question'), questions }, (answer) => {
        const answers: Record<string, { answers: string[] }> = Object.create(null) as Record<string, { answers: string[] }>
        if (answer.kind !== 'cancel') for (const [key, values] of Object.entries(answerLabels(questions, answer))) answers[key] = { answers: values }
        this.reply(id, { answers })
      }, () => this.reply(id, { answers: {} }))
    } else this.rpcUnsupported(id, method)
  }

  private codexNotification(method: string, params: JsonObject): void {
    if (!this.active || params.threadId && params.threadId !== this.threadId) return
    if (typeof params.turnId === 'string') {
      if (this.turnId && params.turnId !== this.turnId) return
      this.turnId ||= params.turnId
    }
    if (method === 'serverRequest/resolved') {
      for (const [id, pending] of this.interactions) if (pending.wireId === params.requestId) this.removeInteraction(id)
      if (!this.interactions.size && !this.cancelling) this.setState('thinking')
    }
    else if (method === 'turn/started') this.turnId = string(object(params.turn).id)
    else if (method === 'item/agentMessage/delta') this.agentText(`codex:${this.turnSequence}:${string(params.itemId)}`, string(params.delta), true)
    else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item)
      const id = string(item.id)
      if (item.type === 'agentMessage') this.agentText(`codex:${this.turnSequence}:${id}`, string(item.text))
      else if (item.type === 'commandExecution') this.tool(id, this.deps.messages('assistantTransport.command'), { command: item.command }, item.status === 'inProgress' ? 'running' : item.status === 'completed' ? 'ok' : 'error', typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 8000) : undefined)
      else if (item.type === 'fileChange') this.tool(id, this.deps.messages('assistantTransport.fileChange'), item.changes, item.status === 'inProgress' ? 'running' : item.status === 'completed' ? 'ok' : 'error')
      else if (item.type === 'mcpToolCall') this.tool(id, string(item.tool), item.arguments, item.status === 'inProgress' ? 'running' : item.status === 'completed' ? 'ok' : 'error', item.result === undefined ? undefined : preview(item.result))
    } else if (method === 'turn/completed') {
      const turn = object(params.turn)
      if (this.turnId && turn.id !== this.turnId) return
      const error = turn.status === 'failed' ? string(object(turn.error).message) || this.deps.messages('assistantTransport.codexFailed') : undefined
      this.finish(this.cancelling || turn.status === 'interrupted' ? 'interrupted' : error ? 'error' : 'done', error)
    } else if (method === 'error' && params.willRetry !== true) this.finish('error', string(object(params.error).message) || this.deps.messages('assistantTransport.codexError'))
  }

  private async waitForTurnId(): Promise<void> {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT
    while (this.active && !this.turnId && !this.closed && !this.failed) {
      if (Date.now() > deadline) throw new Error(this.deps.messages('assistantTransport.noTurn'))
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
  }

  private acpRequest(id: RpcId, method: string, params: JsonObject): void {
    if (params.sessionId && params.sessionId !== this.threadId) { this.rpcUnsupported(id, method); return }
    if (method === 'session/request_permission') {
      const tool = object(params.toolCall)
      const toolId = string(tool.toolCallId)
      const existing = this.tools.get(toolId)?.toolCalls?.[0]
      const options: InteractionOption[] = list(params.options).map((raw) => {
        const option = object(raw)
        const kind = string(option.kind)
        return { id: string(option.optionId), label: string(option.name), ...(['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(kind) ? { kind: kind as NonNullable<InteractionOption['kind']> } : {}) }
      })
      const cancelled = (): void => this.reply(id, { outcome: { outcome: 'cancelled' } })
      this.addInteraction(id, { kind: 'permission', title: string(tool.title) || existing?.name || this.deps.messages('assistantTransport.tool'), tool: { name: existing?.name || string(tool.title), input: tool.rawInput != null ? permissionArguments(tool.rawInput) : this.toolArguments.get(toolId) || existing?.input || permissionArguments(tool) }, options }, (answer) => {
        if (answer.kind === 'option') this.reply(id, { outcome: { outcome: 'selected', optionId: answer.optionId } })
        else cancelled()
      }, cancelled)
    } else if (method === 'cursor/ask_question') {
      const questions: InteractionQuestion[] = list(params.questions).map((raw) => {
        const question = object(raw)
        return { id: string(question.id), question: string(question.prompt), options: list(question.options).map((entry) => { const option = object(entry); return { id: string(option.id), label: string(option.label) } }), multiSelect: question.allowMultiple === true, allowFreeform: false }
      })
      const cancelled = (): void => this.reply(id, { outcome: { outcome: 'cancelled' } })
      this.addInteraction(id, { kind: 'question', title: string(params.title) || this.deps.messages('assistantTransport.question'), questions }, (answer) => {
        if (answer.kind !== 'answers') { cancelled(); return }
        this.reply(id, { outcome: { outcome: 'answered', answers: answer.answers.map((value) => ({ questionId: value.questionId, selectedOptionIds: value.optionIds })) } })
      }, cancelled)
    } else if (method === 'cursor/create_plan') {
      const cancelled = (): void => this.reply(id, { outcome: { outcome: 'cancelled' } })
      this.addInteraction(id, { kind: 'confirmation', title: string(params.title) || this.deps.messages('assistantTransport.plan'), text: string(params.plan), options: [{ id: 'accept', label: this.deps.messages('assistantTransport.accept'), kind: 'allow_once' }, { id: 'reject', label: this.deps.messages('assistantTransport.reject'), kind: 'reject_once' }] }, (answer) => {
        if (answer.kind === 'option') this.reply(id, { outcome: { outcome: answer.optionId === 'accept' ? 'accepted' : 'rejected' } })
        else cancelled()
      }, cancelled)
    } else this.rpcUnsupported(id, method)
  }

  private acpUpdate(params: JsonObject): void {
    if (!this.active || params.sessionId !== this.threadId) return
    const update = object(params.update)
    this.acceptPrompt(this.turnSequence)
    if (update.sessionUpdate === 'agent_message_chunk' && object(update.content).type === 'text') {
      const sourceId = string(update.messageId)
      if (sourceId) this.agentText(`acp:${this.turnSequence}:${sourceId}`, string(object(update.content).text), true)
      else {
        this.acpMessageId ||= `acp:${this.turnSequence}:${++this.sequence}`
        this.agentText(this.acpMessageId, string(object(update.content).text), true)
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const status = string(update.status)
      const current = this.tools.get(string(update.toolCallId))?.toolCalls?.[0]?.status ?? 'running'
      const output = update.rawOutput !== undefined ? preview(update.rawOutput) : list(update.content).map((raw) => string(object(object(raw).content).text)).filter(Boolean).join('\n') || undefined
      this.tool(string(update.toolCallId), string(update.title) || string(update.kind), update.rawInput, status === 'completed' ? 'ok' : status === 'failed' ? 'error' : status ? 'running' : current, output)
    }
  }

  private rpcUnsupported(id: RpcId, method: string): void {
    this.write({ ...(this.protocol === 'acp' ? { jsonrpc: '2.0' } : {}), id, error: { code: -32601, message: `Unsupported client request: ${method}` } })
    this.fail(this.deps.messages('assistantTransport.unsupportedRequest', { method }), true)
    // Не объявляем fs/terminal capabilities, не расширяем доступ молча.
  }
}

/** Ответ IPC проверяется по сохранённому запросу, без доверия к input/option id от renderer. */
function validateAnswer(interaction: ConversationInteraction, answer: InteractionAnswer, mt: AssistantTransportMessages): void {
  const value = object(answer)
  if (value.kind === 'cancel') return
  if (interaction.questions) {
    if (value.kind !== 'answers' || !Array.isArray(value.answers) || value.answers.length !== interaction.questions.length) throw new Error(mt('assistantTransport.answerAll'))
    const seen = new Set<string>()
    for (const raw of value.answers) {
      const item = object(raw)
      const question = interaction.questions.find((q) => q.id === item.questionId)
      if (!question || seen.has(question.id) || !Array.isArray(item.optionIds) || !item.optionIds.every((id) => typeof id === 'string')) throw new Error(mt('assistantTransport.unknownQuestion'))
      seen.add(question.id)
      const ids = item.optionIds as string[]
      if (new Set(ids).size !== ids.length || ids.some((id) => !question.options.some((option) => option.id === id))) throw new Error(mt('assistantTransport.unknownOption'))
      if (!question.multiSelect && ids.length + (string(item.text).trim() ? 1 : 0) > 1) throw new Error(mt('assistantTransport.singleChoice'))
      if (item.text !== undefined && (typeof item.text !== 'string' || !question.allowFreeform || item.text.length > 20_000)) throw new Error(mt('assistantTransport.freeformUnavailable'))
      if (!ids.length && !string(item.text).trim()) throw new Error(mt('assistantTransport.answerRequired'))
    }
  } else if (value.kind !== 'option' || !interaction.options?.some((option) => option.id === value.optionId)) throw new Error(mt('assistantTransport.unknownOption'))
}

function answerLabels(questions: InteractionQuestion[], answer: InteractionAnswer): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  if (answer.kind !== 'answers') return result
  for (const value of answer.answers) {
    const question = questions.find((q) => q.id === value.questionId)!
    result[question.id] = [...value.optionIds.map((id) => question.options.find((option) => option.id === id)!.label), ...(value.text?.trim() ? [value.text.trim()] : [])]
  }
  return result
}
