import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getAgent, type AgentInvocation } from '@orca-board/core'
import * as runtime from '../src/index.ts'

const { createAgentLauncher, createBinaryLookup } = runtime

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orca-runtime-launch-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const amp = (): AgentInvocation => getAgent('amp')!.invoke('system', 'task', { permissionMode: 'acceptEdits', shell: 'sh' })
const host = { settingsInvalid: (path: string) => new Error(`invalid:${path}`) }
const options = (): { home: string; tempRoot: string; env: {}; platform: 'darwin' } => ({ home: root, tempRoot: root, env: {}, platform: 'darwin' })

describe('общий AgentLauncher', () => {
  it('сохраняет JSONC/MCP в защищённой копии и удаляет её при выходе', () => {
    const config = join(root, '.config', 'amp')
    mkdirSync(config, { recursive: true })
    const original = '{"amp.proxy":"https://proxy/",/* comment */"amp.mcpServers":{"m":{"url":"https://mcp/",}},}'
    const file = join(config, 'settings.jsonc')
    writeFileSync(file, original)
    const launcher = createAgentLauncher(host)
    let exit: ((id: string, code: number) => void) | undefined
    let generated = ''
    let callbackCode: number | undefined
    assert.equal(launcher.launchAgent(amp(), root, (launch, done) => {
      assert.ok(Array.isArray(launch.args))
      generated = launch.args[launch.args.lastIndexOf('--settings-file') + 1]
      const settings = JSON.parse(readFileSync(generated, 'utf8'))
      assert.equal(settings['amp.proxy'], 'https://proxy/')
      assert.equal(settings['amp.mcpServers'].m.url, 'https://mcp/')
      assert.equal(settings['amp.dangerouslyAllowAll'], false)
      if (process.platform !== 'win32') assert.equal(statSync(generated).mode & 0o777, 0o600)
      exit = done
      return 'pty_amp'
    }, (_id, code) => { callbackCode = code }, options()), 'pty_amp')
    assert.equal(readFileSync(file, 'utf8'), original)
    exit!('pty_amp', 7)
    assert.equal(callbackCode, 7)
    assert.equal(existsSync(generated), false)
    assert.equal(readFileSync(file, 'utf8'), original)
  })

  it('dispose одного владельца не удаляет файлы другого', () => {
    const one = createAgentLauncher(host)
    const two = createAgentLauncher(host)
    const launch = (launcher: ReturnType<typeof createAgentLauncher>): string => {
      let file = ''
      launcher.launchAgent(amp(), root, command => {
        assert.ok(Array.isArray(command.args))
        file = command.args[command.args.lastIndexOf('--settings-file') + 1]
        return file
      }, undefined, options())
      return file
    }
    const first = launch(one)
    const second = launch(two)
    one.dispose()
    one.dispose()
    assert.equal(existsSync(first), false)
    assert.equal(existsSync(second), true)
    two.dispose()
    assert.equal(existsSync(second), false)
    assert.deepEqual(readdirSync(root), [])
  })

  for (const failure of ['spawn', 'callback'] as const) {
    it(`освобождает копию при ошибке ${failure}`, () => {
      const launcher = createAgentLauncher(host)
      let exit: ((id: string, code: number) => void) | undefined
      const start = (): string => launcher.launchAgent(amp(), root, (_command, done) => {
        exit = done
        if (failure === 'spawn') throw new Error('spawn')
        return 'pty'
      }, () => { throw new Error('callback') }, options())
      if (failure === 'spawn') assert.throws(start, /spawn/)
      else { start(); assert.throws(() => exit!('pty', 0), /callback/) }
      assert.deepEqual(readdirSync(root), [])
    })
  }

  it('возвращает ошибку хоста до запуска при повреждённых настройках', () => {
    const file = join(root, 'bad.json')
    writeFileSync(file, '[]')
    const inv = amp()
    inv.args.unshift('--settings-file', file)
    let started = false
    assert.throws(() => createAgentLauncher(host).launchAgent(inv, root, () => { started = true; return 'pty' }, undefined, options()), { message: `invalid:${file}` })
    assert.equal(started, false)
    assert.deepEqual(readdirSync(root), ['bad.json'])
  })

  it('длинный prompt Windows сохраняет argv и освобождается owner dispose', () => {
    const prompt = 'правила\n'.repeat(5000)
    const inv = getAgent('claude')!.invoke(prompt, 'task', { permissionMode: 'bypassPermissions', shell: 'cmd.exe' })
    const file = join(root, 'system.md')
    const launcher = createAgentLauncher(host)
    launcher.launchAgent(inv, root, command => {
      assert.ok(Array.isArray(command.args))
      assert.deepEqual(command.args.slice(-3), ['--append-system-prompt-file', file, 'task'])
      assert.deepEqual(command.args.slice(0, -3), inv.args.slice(0, -3))
      assert.equal(readFileSync(file, 'utf8'), prompt)
      return 'pty'
    }, undefined, { platform: 'win32', findBin: () => undefined, systemPromptFile: () => file })
    launcher.dispose()
    assert.equal(existsSync(file), false)
  })

  it('сохраняет окружение адаптера', () => {
    const inv = getAgent('opencode')!.invoke('system', 'task', { permissionMode: 'bypassPermissions', shell: 'sh' })
    createAgentLauncher(host).launchAgent(inv, root, command => {
      assert.deepEqual(command.env, inv.env)
      assert.deepEqual(command.args, inv.args)
      return 'pty'
    }, undefined, options())
  })
})

describe('поиск бинарников runtime', () => {
  it('использует указанный PATH, проверяет executable и не зависит от другого профиля', () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    mkdirSync(first); mkdirSync(second)
    writeFileSync(join(first, 'tool'), '', { mode: 0o600 })
    writeFileSync(join(second, 'tool'), '', { mode: 0o700 })
    const lookup = createBinaryLookup({ home: root, platform: process.platform, env: { PATH: [first, second].join(delimiter), PATHEXT: '' } })
    assert.equal(lookup.findBin('tool'), join(process.platform === 'win32' ? first : second, 'tool'))
    assert.equal(createBinaryLookup({ home: root, env: { PATH: '' } }).findBin('tool'), undefined)
  })

  it('Windows ищет PATHEXT перед одноимённым shell-файлом', () => {
    writeFileSync(join(root, 'tool'), '', { mode: 0o700 })
    const shim = join(root, 'tool.cmd')
    writeFileSync(shim, '', { mode: 0o700 })
    const lookup = createBinaryLookup({ home: root, platform: 'win32', env: { PATH: root, PATHEXT: '.CMD' } })
    assert.equal(lookup.findBin('tool'), shim)
    assert.equal(lookup.isCmdScript(shim), true)
    assert.equal(lookup.isCmdScript(join(root, 'tool')), false)
    assert.ok(lookup.extraPathDirs().includes(join(root, '.local', 'bin')))
  })
})
