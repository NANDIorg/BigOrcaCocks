import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'

async function runWizard(directory: string, command: 'setup' | 'configure', answers: [string, string][]) {
  await import('../../../scripts/ts-resolve.mjs')
  const native = await import('node-pty')
  const loader = fileURLToPath(new URL('../../../scripts/ts-resolve.mjs', import.meta.url))
  const source = `import { setup } from ${JSON.stringify(new URL('../src/server/setup.ts', import.meta.url).href)}; try { await setup({ reconfigure: ${command === 'configure'} }); } catch (error) { console.error(error.message); process.exitCode = 1; }`
  const terminal = native.spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', loader, '--input-type=module', '--eval', source], {
    cols: 54, rows: 28, cwd: directory, name: 'xterm', env: { ...process.env, HOME: directory,
      ORCA_WEB_HOME: join(directory, 'install'), ORCA_WEB_CONFIG: join(directory, 'config/config.json'), ORCA_WEB_INSTALLER: '0',
      GIT_CONFIG_GLOBAL: join(directory, 'gitconfig'), NO_COLOR: '1', TERM: 'xterm' },
  })
  let output = ''; let cursor = 0; let step = 0
  terminal.onData(data => {
    output += data
    const plain = stripVTControlCharacters(output)
    if (step >= answers.length) return
    const [prompt, answer] = answers[step]
    const at = plain.indexOf(prompt, cursor)
    if (at < 0) return
    cursor = at + prompt.length; step++
    setTimeout(() => terminal.write(answer), 30)
  })
  const timer = setTimeout(() => terminal.kill(), 15_000)
  const result = await new Promise<{ exitCode: number }>(resolve => terminal.onExit(resolve))
  clearTimeout(timer)
  return { ...result, output: stripVTControlCharacters(output), step }
}

test('TUI со стрелками создаёт SSH-конфиг, скрывает пароль и сохраняет аккаунт при отмене', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-terminal-'))
  try {
    await mkdir(join(directory, 'projects'))
    await writeFile(join(directory, 'gitconfig'), '[user]\n name = Test\n email = test@example.com\n')
    const secret = 'private-tui-password-123'
    const created = await runWizard(directory, 'setup', [
      ['Способ доступа', '\r'], ['Папка с Git-проектами', '\r'], ['Логин первого', '\r'],
      ['Настроить автозапуск', '\r'], ['Применить настройки', '\r'],
      ['Пароль (от', `${secret}\r`], ['Повторите пароль', `${secret}\r`],
    ])
    assert.equal(created.exitCode, 0, created.output.replaceAll(secret, '[hidden]'))
    assert.equal(created.step, 7); assert.equal(created.output.includes(secret), false)
    const configFile = join(directory, 'config/config.json'); const accountFile = join(directory, 'config/accounts.json')
    const config = await readFile(configFile, 'utf8'); const accounts = await readFile(accountFile, 'utf8')
    assert.equal(JSON.parse(config).mode, 'local'); assert.equal(accounts.includes(secret), false)
    const cancelled = await runWizard(directory, 'configure', [
      ['Способ доступа', '\u001b[B\u001b[A\r'], ['Папка с Git-проектами', '\r'],
      ['Настроить автозапуск', '\r'], ['Применить настройки', '\u001b[B\r'],
    ])
    assert.equal(cancelled.exitCode, 1, cancelled.output)
    assert.equal(cancelled.step, 4)
    assert.equal(await readFile(configFile, 'utf8'), config)
    assert.equal(await readFile(accountFile, 'utf8'), accounts)
    assert.match(cancelled.output, /отменена/)
    const interrupted = await runWizard(directory, 'configure', [['Способ доступа', '\r'], ['Папка с Git-проектами', '\u0003']])
    assert.equal(interrupted.exitCode, 1, interrupted.output)
    assert.equal(await readFile(configFile, 'utf8'), config)
    assert.equal(await readFile(accountFile, 'utf8'), accounts)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
