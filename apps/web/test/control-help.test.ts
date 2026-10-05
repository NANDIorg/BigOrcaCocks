import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const command = fileURLToPath(new URL('../src/server/control.ts', import.meta.url))
const run = (args: string[]) => spawnSync(process.execPath, [command, ...args], {
  encoding: 'utf8', timeout: 10_000, env: { ...process.env, ORCA_WEB_CONFIG: '/missing-orca-test/config.json', NO_COLOR: '1' },
})

test('help, --help, -h и пустой вызов дают вертикальную справку без конфигурации', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /orca-web configure[^\n]*\n/)
    assert.match(result.stdout, /orca-web agents login <codex\|claude>/)
    assert.match(result.stdout, /Настройка/); assert.match(result.stdout, /--help/)
    assert.equal(result.stdout.includes('setup | configure'), false)
  }
})

test('справка подкоманд и --version не запускают сервер, пароль или установку', () => {
  for (const args of [['help', 'agents'], ['agents', '--help'], ['agents', 'login', '-h'], ['user', 'add', '--help'], ['start', '--help']]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /orca-web/)
    if (args.includes('agents')) assert.match(result.stdout, /codex\|claude/)
  }
  for (const flag of ['--version', '-v']) {
    const result = run([flag]); assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^Orca Web \d+\.\d+\.\d+\n$/)
  }
})

test('неизвестные команды, лишние аргументы и отсутствующий агент отклоняются до действий', () => {
  for (const args of [['unknown'], ['start', '--unknown'], ['start', 'extra'], ['agents', 'login'], ['agents', 'login', '--prefix=/etc'], ['user', 'add', 'extra'], ['--help', '--unknown']]) {
    const result = run(args)
    assert.equal(result.status, 1, JSON.stringify({ args, stdout: result.stdout, stderr: result.stderr }))
    assert.match(result.stderr, /orca-web|codex|claude/)
    assert.doesNotMatch(result.stderr, /ENOENT|интерактивн|запускается/)
  }
})
