import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { newId } from '@orca-board/core'
import type { PtySpawnOptions, TerminalInfo, TerminalSnapshot } from '../shared/ipc'

interface Session {
  info: TerminalInfo
  proc: pty.IPty
  tail: string
  lastOutputAt: number
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

/** Реестр живых PTY: источник правды для вкладок «Терминалы». Порядок вставки = порядок открытия. */
const sessions = new Map<string, Session>()

/**
 * Окно, в которое идёт вывод PTY. Не захватывается при spawn: окно могут закрыть и создать заново
 * (фоновый режим), и новое окно должно получать данные тех же PTY. Нет окна — копится только tail.
 */
let ptyWindow: BrowserWindow | null = null

export function setPtyWindow(win: BrowserWindow | null): void {
  ptyWindow = win
}

function send(channel: string, ...args: unknown[]): void {
  if (ptyWindow && !ptyWindow.isDestroyed()) ptyWindow.webContents.send(channel, ...args)
}

export function listTerminals(): TerminalInfo[] {
  return [...sessions.values()].map((s) => ({ ...s.info }))
}

/** Реестр с хвостами вывода — для восстановления вкладок после перезагрузки/пересоздания окна. */
export function terminalSnapshots(): TerminalSnapshot[] {
  return listTerminals().map((t) => ({ ...t, tail: ptyTail(t.ptyId, 200) }))
}

function emitChanged(): void {
  send('terminals:changed', listTerminals())
}

/** Команда для pty.spawn; args строкой — готовая командная строка Windows, node-pty передаёт её без переквотирования. */
export interface PtyCommand {
  command: string
  args: string[] | string
}

export function spawnPty(
  opts: Omit<PtySpawnOptions, 'args' | 'label' | 'projectId'> & {
    /** Метаданные терминала для реестра (terminals:list/changed). */
    meta: Omit<TerminalInfo, 'ptyId' | 'createdAt'>
    args?: string[] | string
    /**
     * Шаг перед основной командой в том же терминале (тот же ptyId): после его выхода с любым кодом
     * запускается основная команда. Нужен на Windows, где подготовку нельзя склеить с агентом через exec.
     */
    before?: PtyCommand
  },
  onExit?: (id: string, code: number) => void
): string {
  const id = newId('pty')
  const env = mergeEnv(cleanEnv(), opts.env ?? {})
  const cwd = opts.cwd ?? process.env.HOME
  const size = { cols: opts.cols, rows: opts.rows }
  const start = (c: PtyCommand): pty.IPty =>
    pty.spawn(c.command, c.args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env })
  const main: PtyCommand = { command: opts.command ?? defaultShell(), args: opts.args ?? [] }
  const session: Session = {
    info: { ...opts.meta, ptyId: id, createdAt: Date.now() },
    proc: start(opts.before ?? main),
    tail: '',
    lastOutputAt: Date.now(),
    size
  }
  sessions.set(id, session)
  emitChanged()
  const attach = (proc: pty.IPty, last: boolean): void => {
    proc.onData((data) => {
      session.tail = (session.tail + data).slice(-TAIL_LIMIT)
      session.lastOutputAt = Date.now()
      send(`pty:data:${id}`, data)
    })
    proc.onExit(({ exitCode }) => {
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
          send(`pty:data:${id}`, msg)
        }
      }
      // Сначала pty:exit (renderer оставит вкладку «завершённой»), потом terminals:changed без этого id.
      // После killPty сессии в реестре уже нет и terminals:changed ушёл сразу — повторно не шлём.
      const registered = sessions.get(id) === session
      if (registered) sessions.delete(id)
      send(`pty:exit:${id}`, exitCode)
      if (registered) emitChanged()
      onExit?.(id, exitCode)
    })
  }
  attach(session.proc, !opts.before)
  return id
}

export function writePty(id: string, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizePty(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s) return
  // Мутируем, а не заменяем: объект size держит замыкание spawnPty для старта основной команды.
  s.size.cols = Math.max(cols, 2)
  s.size.rows = Math.max(rows, 1)
  s.proc.resize(s.size.cols, s.size.rows)
}

export function killPty(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  emitChanged()
  s.proc.kill()
}

export function killAll(): void {
  for (const [id] of sessions) killPty(id)
}

/** Хвост вывода без ANSI-кодов, последние `lines` строк. */
export function ptyTail(id: string, lines = 80): string {
  const raw = sessions.get(id)?.tail ?? ''
  const clean = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
  return clean.split('\n').slice(-lines).join('\n')
}

export function isAlive(id: string): boolean {
  return sessions.has(id)
}

export function silentFor(id: string): number {
  const s = sessions.get(id)
  return s ? Date.now() - s.lastOutputAt : 0
}
