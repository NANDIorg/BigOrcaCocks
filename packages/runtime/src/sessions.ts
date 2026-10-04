import { newId } from '@orca-board/core'
import type { PtySpawnOptions, TerminalInfo, TerminalSnapshot } from '@orca-board/contracts'

/** Минимальный порт PTY; host выбирает native backend и его ABI. */
export interface PtyProcess {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type PtyFactory = (command: string, args: string[] | string, options: {
  name: string
  cols: number
  rows: number
  cwd?: string
  env: Record<string, string>
}) => PtyProcess

export type SessionEvent =
  | { type: 'data'; ptyId: string; data: string }
  | { type: 'exit'; ptyId: string; exitCode: number }
  | { type: 'changed'; terminals: TerminalInfo[] }

/** Команда с argv либо готовой командной строкой Windows. */
export interface PtyCommand {
  command: string
  args: string[] | string
}

export type PtySessionOptions = Omit<PtySpawnOptions, 'args' | 'label' | 'projectId'> & {
  meta: Omit<TerminalInfo, 'ptyId' | 'createdAt'>
  args?: string[] | string
  /** Подготовка в том же терминале; main запускается после любого exit code, кроме kill. */
  before?: PtyCommand
}

export interface SessionHost {
  spawn: PtyFactory
  onObserverError?: (error: unknown) => void
}

interface Session {
  info: TerminalInfo
  proc: PtyProcess
  tail: string
  lastOutputAt: number
  /** Последний ввод из вкладки (человек печатает) — активность для автозакрытия координатора. */
  lastInputAt?: number
  /** Текущий размер: с ним стартует основная команда после шага before. */
  size: { cols: number; rows: number }
}

const TAIL_LIMIT = 256 * 1024

/**
 * Окружение для агентов без служебных переменных Claude Code: если приложение запущено
 * из сессии Claude Code, агенты иначе считают себя её дочерними сессиями и не сохраняют транскрипт.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') delete env[key]
  }
  return env
}

/** Оболочка по умолчанию: на Windows — COMSPEC (обычно cmd.exe), иначе — $SHELL. */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe'
  return process.env.SHELL ?? '/bin/zsh'
}

/**
 * Накладывает extra на base. На Windows имена переменных регистронезависимы: если в base уже есть
 * `Path`, то `PATH` из extra пишется в этот же ключ, а не создаёт дубликат.
 */
function mergeEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env = { ...base } as Record<string, string>
  for (const [key, value] of Object.entries(extra)) {
    const existing =
      process.platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase()) : undefined
    env[existing ?? key] = value
  }
  return env
}

/** Реестр принадлежит runtime, а подписчики могут отсоединяться без остановки процессов. */
export function createSessionRegistry(host: SessionHost) {
  const sessions = new Map<string, Session>()
  const processes = new Set<PtyProcess>()
  const exitWaiters = new Set<() => void>()
  let stopping = false
  const observers = new Set<(event: SessionEvent) => void>()
  const pendingEvents: SessionEvent[] = []
  let emitting = false

  const subscribe = (observer: (event: SessionEvent) => void): (() => void) => {
    observers.add(observer)
    return () => { observers.delete(observer) }
  }

  const emit = (event: SessionEvent): void => {
    pendingEvents.push(event)
    if (emitting) return
    emitting = true
    try {
      // Команда из callback создаёт следующее событие, не обгоняя текущее у других клиентов.
      while (pendingEvents.length) {
        const next = pendingEvents.shift()!
        for (const observer of [...observers]) {
          try {
            // Подписчики не разделяют mutable payload друг с другом или реестром.
            observer(next.type === 'changed'
              ? { ...next, terminals: next.terminals.map(info => ({ ...info })) }
              : { ...next })
          } catch (error) {
            // Сломанный транспорт и его logger не должны менять lifecycle агента.
            try { host.onObserverError?.(error) } catch { /* Ошибка reporter изолирована так же. */ }
          }
        }
      }
    } finally {
      emitting = false
    }
  }

  function listTerminals(): TerminalInfo[] {
    return [...sessions.values()].map((s) => ({ ...s.info }))
  }

  /** Реестр с хвостами вывода — для восстановления вкладок после перезагрузки/пересоздания окна. */
  function terminalSnapshots(): TerminalSnapshot[] {
    return listTerminals().map((t) => ({ ...t, tail: ptyTail(t.ptyId, 200) }))
  }

  function emitChanged(): void {
    emit({ type: 'changed', terminals: listTerminals() })
  }

  function spawnPty(
    opts: PtySessionOptions,
    onExit?: (id: string, code: number) => void
  ): string {
    if (stopping) throw new Error('Реестр терминалов остановлен')
    const id = newId('pty')
    const env = mergeEnv(cleanEnv(), opts.env ?? {})
    const cwd = opts.cwd ?? process.env.HOME
    const size = { cols: opts.cols, rows: opts.rows }
    const start = (c: PtyCommand): PtyProcess => {
      const proc = host.spawn(c.command, c.args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env })
      processes.add(proc)
      return proc
    }
    const main: PtyCommand = { command: opts.command ?? defaultShell(), args: opts.args ?? [] }
    const session: Session = {
      info: { ...opts.meta, ptyId: id, createdAt: Date.now() },
      proc: start(opts.before ?? main),
      tail: '',
      lastOutputAt: Date.now(),
      size
    }
    sessions.set(id, session)
    const attach = (proc: PtyProcess, last: boolean): void => {
      proc.onData((data) => {
        session.tail = (session.tail + data).slice(-TAIL_LIMIT)
        session.lastOutputAt = Date.now()
        emit({ type: 'data', ptyId: id, data })
      })
      proc.onExit(({ exitCode }) => {
        processes.delete(proc)
        if (!processes.size) { for (const resolve of exitWaiters) resolve(); exitWaiters.clear() }
        // Подготовка завершилась — запускаем основную команду. Если терминал закрыли (killPty) —
        // не запускаем, а сообщаем о выходе как обычно.
        if (!last && sessions.get(id) === session) {
          try {
            session.proc = start(main)
            attach(session.proc, true)
            return
          } catch (e) {
            const msg = `\r\n[orca] не удалось запустить ${main.command}: ${e instanceof Error ? e.message : String(e)}\r\n`
            session.tail = (session.tail + msg).slice(-TAIL_LIMIT)
            emit({ type: 'data', ptyId: id, data: msg })
          }
        }
        // Сначала pty:exit (renderer оставит вкладку «завершённой»), потом terminals:changed без этого id.
        // После killPty сессии в реестре уже нет и terminals:changed ушёл сразу — повторно не шлём.
        const registered = sessions.get(id) === session
        if (registered) sessions.delete(id)
        emit({ type: 'exit', ptyId: id, exitCode })
        if (registered) emitChanged()
        onExit?.(id, exitCode)
      })
    }
    attach(session.proc, !opts.before)
    emitChanged()
    return id
  }

  function writePty(id: string, data: string): void {
    const s = sessions.get(id)
    if (!s) return
    s.lastInputAt = Date.now()
    s.proc.write(data)
  }

  function resizePty(id: string, cols: number, rows: number): void {
    const s = sessions.get(id)
    if (!s) return
    // Мутируем, а не заменяем: объект size держит замыкание spawnPty для старта основной команды.
    s.size.cols = Math.max(cols, 2)
    s.size.rows = Math.max(rows, 1)
    s.proc.resize(s.size.cols, s.size.rows)
  }

  function killPty(id: string): void {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    emitChanged()
    s.proc.kill()
  }

  function killAll(): void {
    for (const [id] of sessions) killPty(id)
  }

  /** Sync kill убирает вкладку сразу; owner lease требует дождаться настоящего native exit. */
  function stop(): Promise<void> {
    stopping = true
    for (const proc of [...processes]) proc.kill()
    sessions.clear(); emitChanged()
    const wait = processes.size ? new Promise<void>(resolve => { exitWaiters.add(resolve) }) : Promise.resolve()
    return wait
  }

  /** Хвост вывода без ANSI-кодов, последние `lines` строк. */
  function ptyTail(id: string, lines = 80): string {
    const raw = sessions.get(id)?.tail ?? ''
    const clean = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
    return clean.split('\n').slice(-lines).join('\n')
  }

  function isAlive(id: string): boolean {
    return sessions.has(id)
  }

  /** Время последней активности PTY — вывода или ввода человека; undefined — PTY уже не жив. */
  function lastActivityAt(id: string): number | undefined {
    const s = sessions.get(id)
    return s && Math.max(s.lastOutputAt, s.lastInputAt ?? 0)
  }

  function silentFor(id: string): number {
    const s = sessions.get(id)
    return s ? Date.now() - s.lastOutputAt : 0
  }

  return { subscribe, listTerminals, terminalSnapshots, spawnPty, writePty, resizePty, killPty, killAll, stop, ptyTail, isAlive, lastActivityAt, silentFor }
}
