import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { createSessionRegistry } from '@orca-board/runtime'

export { defaultShell } from '@orca-board/runtime'
export type { PtyCommand } from '@orca-board/runtime'

const registry = createSessionRegistry({ spawn: pty.spawn })
export const sessionRegistry = registry

/** Окно может закрыться и появиться снова; процессы и их tail принадлежат runtime. */
let ptyWindow: BrowserWindow | null = null
export function setPtyWindow(win: BrowserWindow | null): void {
  ptyWindow = win
}

function send(channel: string, ...args: unknown[]): void {
  if (ptyWindow && !ptyWindow.isDestroyed()) ptyWindow.webContents.send(channel, ...args)
}

registry.subscribe(event => {
  switch (event.type) {
    case 'data': send(`pty:data:${event.ptyId}`, event.data); break
    case 'exit': send(`pty:exit:${event.ptyId}`, event.exitCode); break
    case 'changed': send('terminals:changed', event.terminals); break
  }
})

export const { listTerminals, terminalSnapshots, spawnPty, writePty, resizePty, killPty, killAll, ptyTail, isAlive, lastActivityAt, silentFor } = registry
