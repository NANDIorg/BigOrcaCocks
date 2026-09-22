import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { newId } from '@orca-board/core'
import type { PtySpawnOptions } from '../shared/ipc'

interface Session {
  proc: pty.IPty
  tail: string
  lastOutputAt: number
  /** Текущий размер: с ним стартует основная команда после шага before. */
  size: { cols: number; rows: number }
}

const TAIL_LIMIT = 64 * 1024

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

const sessions = new Map<string, Session>()

/** Команда для pty.spawn; args строкой — готовая командная строка Windows, node-pty передаёт её без переквотирования. */
export interface PtyCommand {
  command: string
  args: string[] | string
}

export function spawnPty(
  win: BrowserWindow,
  opts: Omit<PtySpawnOptions, 'args'> & {
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
  const session: Session = { proc: start(opts.before ?? main), tail: '', lastOutputAt: Date.now(), size }
  sessions.set(id, session)
  const attach = (proc: pty.IPty, last: boolean): void => {
    proc.onData((data) => {
      session.tail = (session.tail + data).slice(-TAIL_LIMIT)
      session.lastOutputAt = Date.now()
      if (!win.isDestroyed()) win.webContents.send(`pty:data:${id}`, data)
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
          if (!win.isDestroyed()) win.webContents.send(`pty:data:${id}`, msg)
        }
      }
      sessions.delete(id)
      if (!win.isDestroyed()) win.webContents.send(`pty:exit:${id}`, exitCode)
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
  sessions.get(id)?.proc.kill()
  sessions.delete(id)
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
