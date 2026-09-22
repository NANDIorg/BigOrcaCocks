import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { newId } from '@orca-board/core'
import type { PtySpawnOptions } from '../shared/ipc'

interface Session {
  proc: pty.IPty
  tail: string
  lastOutputAt: number
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

export function spawnPty(
  win: BrowserWindow,
  // args строкой — готовая командная строка Windows, node-pty передаёт её без переквотирования.
  opts: Omit<PtySpawnOptions, 'args'> & { args?: string[] | string },
  onExit?: (id: string, code: number) => void
): string {
  const id = newId('pty')
  const shell = opts.command ?? defaultShell()
  const proc = pty.spawn(shell, opts.args ?? [], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd ?? process.env.HOME,
    env: mergeEnv(cleanEnv(), opts.env ?? {})
  })
  const session: Session = { proc, tail: '', lastOutputAt: Date.now() }
  sessions.set(id, session)
  proc.onData((data) => {
    session.tail = (session.tail + data).slice(-TAIL_LIMIT)
    session.lastOutputAt = Date.now()
    if (!win.isDestroyed()) win.webContents.send(`pty:data:${id}`, data)
  })
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    if (!win.isDestroyed()) win.webContents.send(`pty:exit:${id}`, exitCode)
    onExit?.(id, exitCode)
  })
  return id
}

export function writePty(id: string, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizePty(id: string, cols: number, rows: number): void {
  sessions.get(id)?.proc.resize(Math.max(cols, 2), Math.max(rows, 1))
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
