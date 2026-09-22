import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { newId } from '@orca-board/core'
import type { PtySpawnOptions } from '../shared/ipc'

const sessions = new Map<string, pty.IPty>()

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
  sessions.set(id, proc)
  proc.onData((data) => {
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
  sessions.get(id)?.write(data)
}

export function resizePty(id: string, cols: number, rows: number): void {
  sessions.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1))
}

export function killPty(id: string): void {
  sessions.get(id)?.kill()
  sessions.delete(id)
}

export function killAll(): void {
  for (const [id] of sessions) killPty(id)
}
