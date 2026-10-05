import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

async function immediateInput(cancel: boolean) {
  await import('../../../scripts/ts-resolve.mjs')
  const native = await import('node-pty')
  const loader = fileURLToPath(new URL('../../../scripts/ts-resolve.mjs', import.meta.url))
  const secret = 'immediate-private-password-123'
  const prompt = 'Пароль для проверки: '
  const source = `
    import assert from 'node:assert/strict';
    import { readPassword } from ${JSON.stringify(new URL('../src/server/password.ts', import.meta.url).href)};
    const previous = process.stdin.isRaw;
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      const result = write(chunk, ...args);
      // Реальная PTY: удерживаем процесс после вывода подсказки, чтобы проверить быстрый ввод.
      if (chunk === ${JSON.stringify(prompt)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      return result;
    };
    ${cancel
      ? `await assert.rejects(readPassword(${JSON.stringify(prompt)}), /Ввод отменён/);`
      : `assert.equal(await readPassword(${JSON.stringify(prompt)}), ${JSON.stringify(secret)});`}
    assert.equal(process.stdin.isRaw, previous);
    process.stdout.write('accepted\\n');
  `
  const terminal = native.spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', loader, '--input-type=module', '--eval', source], {
    cols: 80, rows: 24, name: 'xterm', env: { ...process.env, TERM: 'xterm' },
  })
  let output = ''; let sent = false
  terminal.onData(data => {
    output += data
    if (!sent && output.includes(prompt)) {
      sent = true
      terminal.write(cancel ? '\u0003' : `${secret}\r`)
    }
  })
  const timer = setTimeout(() => terminal.kill(), 5000)
  const result = await new Promise<{ exitCode: number }>(resolve => terminal.onExit(resolve))
  clearTimeout(timer)
  return { ...result, output: stripVTControlCharacters(output), secret, sent }
}

test('немедленная вставка пароля не попадает в echo PTY и восстанавливает терминал', { skip: process.platform === 'win32' }, async () => {
  const result = await immediateInput(false)
  assert.equal(result.sent, true)
  assert.equal(result.exitCode, 0, result.output.replaceAll(result.secret, '[hidden]'))
  assert.equal(result.output.includes(result.secret), false, 'Пароль не должен отображаться до начала чтения')
  assert.match(result.output, /accepted/)
})

test('немедленный Ctrl+C отменяет пароль и восстанавливает режим PTY', { skip: process.platform === 'win32' }, async () => {
  const result = await immediateInput(true)
  assert.equal(result.exitCode, 0, result.output)
  assert.match(result.output, /accepted/)
})
