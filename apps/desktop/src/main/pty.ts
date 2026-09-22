import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { newId } from '@orca-board/core'
import type { PtySpawnOptions } from '../shared/ipc'

interface Session {
  proc: pty.IPty
  tail: string
}

const TAIL_LIMIT = 64 * 1024
const sessions = new Map<string, Session>()

export function spawnPty(
  win: BrowserWindow,
  opts: PtySpawnOptions,
  onExit?: (id: string, code: number) => void
): string {
  const id = newId('pty')
  const shell = opts.command ?? process.env.SHELL ?? '/bin/zsh'
  const proc = pty.spawn(shell, opts.args ?? [], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd ?? process.env.HOME,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>
  })
  const session: Session = { proc, tail: '' }
  sessions.set(id, session)
  proc.onData((data) => {
    session.tail = (session.tail + data).slice(-TAIL_LIMIT)
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
