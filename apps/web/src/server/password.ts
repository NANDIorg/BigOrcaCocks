import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents, type Key } from 'node:readline'
import { stdin, stdout } from 'node:process'

/** Password остаётся в памяти процесса; argv/env и echo терминала не используются. */
export async function readPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Введите пароль в интерактивном терминале')
  stdout.write(prompt); emitKeypressEvents(stdin)
  const previous = stdin.isRaw
  stdin.setRawMode(true); stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const clean = () => { stdin.off('keypress', pressed); stdin.setRawMode(previous); stdin.pause(); stdout.write('\n') }
    const pressed = (text: string, key: Key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) { clean(); reject(new Error('Ввод отменён')); return }
      if (key.name === 'return' || key.name === 'enter') { clean(); resolve(value); return }
      if (key.name === 'backspace') { const points = Array.from(value); points.pop(); value = points.join(''); return }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text
    }
    stdin.on('keypress', pressed)
  })
}
