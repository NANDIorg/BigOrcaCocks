import { it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import { isAlive, killPty, setPtyWindow, spawnPty, terminalSnapshots, writePty } from './pty'

/** Подменён только получатель IPC; запуск, ввод и вывод PTY настоящие. */
function windowSink() {
  const events: { channel: string; args: unknown[] }[] = []
  let destroyed = false
  const win = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, ...args: unknown[]) => { events.push({ channel, args }) } }
  } as unknown as BrowserWindow
  return { win, events, destroy: () => { destroyed = true } }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('PTY не выполнил ожидаемый шаг за 15 секунд')
    await delay(20)
  }
}

it('настоящий PTY переживает закрытие окна и доставляет прежние IPC новому окну', { timeout: 40_000 }, async () => {
  const first = windowSink()
  const second = windowSink()
  setPtyWindow(first.win)
  const id = spawnPty({ command: process.execPath, cwd: tmpdir(), args: ['-e', `
    let buffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      buffer += chunk
      let at
      while ((at = buffer.search(/[\\r\\n]/)) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        if (!line) continue
        process.stdout.write('ACK:' + line + '\\n')
        if (line === 'stop') process.exit(7)
      }
    })
    process.stdout.write('READY\\n')
  `], cols: 80, rows: 24, meta: { role: 'shell', label: 'проверка', projectId: 'p' } })
  try {
    await waitFor(() => first.events.some(event => event.channel === `pty:data:${id}` && String(event.args[0]).includes('READY')))
    first.destroy()
    setPtyWindow(null)
    const firstCount = first.events.length
    writePty(id, 'offline\r')
    await waitFor(() => terminalSnapshots().some(info => info.ptyId === id && info.tail.includes('ACK:offline')))
    assert.equal(isAlive(id), true)
    assert.equal(first.events.length, firstCount)
    setPtyWindow(second.win)
    writePty(id, 'online\r')
    await waitFor(() => second.events.some(event => event.channel === `pty:data:${id}` && String(event.args[0]).includes('ACK:online')))
    writePty(id, 'stop\r')
    await waitFor(() => second.events.some(event => event.channel === `pty:exit:${id}`))
    const exitIndex = second.events.findIndex(event => event.channel === `pty:exit:${id}`)
    assert.deepEqual(second.events[exitIndex].args, [7])
    assert.equal(second.events[exitIndex + 1].channel, 'terminals:changed')
    assert.equal(isAlive(id), false)
  } finally { setPtyWindow(null); killPty(id) }
})
