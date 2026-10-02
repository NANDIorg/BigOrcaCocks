import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgent, type AgentInvocation } from '@orca-board/core'
import { launchAgent } from './agent-launch'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orca-agent-launch-test-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const invocation = (agent: string, mode = 'auto'): AgentInvocation =>
  getAgent(agent)!.invoke('system', 'task', { permissionMode: mode, shell: 'sh' })

describe('launchAgent: настройки одного процесса', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    it(`${platform}: окружение адаптера доходит до запуска без shell-подстановки`, () => {
      const inv = invocation('opencode', 'bypassPermissions')
      const result = launchAgent(inv, root, (launch) => {
        assert.deepEqual(launch.env, inv.env)
        assert.deepEqual(launch.args, inv.args)
        return 'pty_1'
      }, undefined, { platform, findBin: () => undefined })
      assert.equal(result, 'pty_1')
    })
  }

  it('Amp сохраняет JSONC, MCP и прочие настройки; режим меняет только в защищённой временной копии', () => {
    const config = join(root, '.config', 'amp')
    mkdirSync(config, { recursive: true })
    const file = join(config, 'settings.jsonc')
    const source = '{\n// комментарий\n"amp.proxy":"https://proxy/", "amp.mcpServers":{"x":{"url":"https://mcp/",}}, "amp.permissions":[{"tool":"*","action":"allow"}],\n}'
    writeFileSync(file, source)
    let finished: ((id: string, code: number) => void) | undefined
    let generated = ''
    let exit: [string, number] | undefined
    launchAgent(invocation('amp', 'acceptEdits'), root, (launch, onExit) => {
      const argv = launch.args as string[]
      generated = argv[argv.lastIndexOf('--settings-file') + 1]
      const settings = JSON.parse(readFileSync(generated, 'utf8'))
      assert.equal(settings['amp.proxy'], 'https://proxy/')
      assert.deepEqual(settings['amp.mcpServers'], { x: { url: 'https://mcp/' } })
      assert.equal(settings['amp.dangerouslyAllowAll'], false)
      assert.equal(settings['amp.permissions'].find((r: {tool: string}) => r.tool === 'edit_file').action, 'allow')
      assert.deepEqual(argv.slice(-1), invocation('amp').args.slice(-1))
      if (process.platform !== 'win32') assert.equal(statSync(generated).mode & 0o777, 0o600)
      finished = onExit
      return 'pty_amp'
    }, (id, code) => { exit = [id, code] }, { home: root, tempRoot: root, env: {}, platform: 'darwin' })
    assert.equal(readFileSync(file, 'utf8'), source)
    assert.ok(existsSync(generated))
    finished!('pty_amp', 0)
    assert.equal(existsSync(generated), false)
    assert.deepEqual(exit, ['pty_amp', 0])
    assert.equal(readFileSync(file, 'utf8'), source)
  })

  for (const via of ['flag', 'inline', 'env'] as const) {
    it(`Amp: пользовательский путь через ${via} не теряет остальные настройки`, () => {
      const file = join(root, 'custom.json')
      writeFileSync(file, '{"amp.showCosts":false}')
      const inv = invocation('amp', 'bypassPermissions')
      if (via === 'flag') inv.args.unshift('--settings-file', 'custom.json')
      if (via === 'inline') inv.args.unshift('--settings-file=custom.json')
      launchAgent(inv, root, (launch, onExit) => {
        const argv = launch.args as string[]
        const settings = JSON.parse(readFileSync(argv[argv.lastIndexOf('--settings-file') + 1], 'utf8'))
        assert.equal(settings['amp.showCosts'], false)
        assert.equal(settings['amp.dangerouslyAllowAll'], true)
        onExit('pty_amp', 0)
        return 'pty_amp'
      }, undefined, { home: root, tempRoot: root, platform: 'darwin', env: via === 'env' ? { AMP_SETTINGS_FILE: file } : {} })
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'amp.showCosts': false })
    })
  }

  it('Amp: ошибка spawn удаляет временный файл', () => {
    assert.throws(() => launchAgent(invocation('amp'), root, () => { throw new Error('spawn failed') }, undefined,
      { home: root, tempRoot: root, env: {}, platform: 'darwin' }), /spawn failed/)
    assert.deepEqual(readdirSync(root), [])
  })

  it('Amp: выход main удаляет настройки, даже если PTY ещё не прислал onExit', () => {
    const moduleUrl = new URL('./agent-launch.ts', import.meta.url).href
    const loader = new URL('../../test/ts-resolve.mjs', import.meta.url).href
    const code = `import { launchAgent } from ${JSON.stringify(moduleUrl)};
      launchAgent(${JSON.stringify(invocation('amp'))}, ${JSON.stringify(root)}, (launch) => {
        process.stdout.write(launch.args[launch.args.lastIndexOf('--settings-file') + 1]);
        return 'pty';
      }, undefined, ${JSON.stringify({ home: root, tempRoot: root, env: {}, platform: 'darwin' })});`
    const generated = execFileSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', loader, '--input-type=module', '-e', code], { encoding: 'utf8' })
    assert.ok(generated.includes('orca-agent-settings-'))
    assert.equal(existsSync(generated), false)
    assert.deepEqual(readdirSync(root), [])
  })

  it('Windows npm-шим сохраняет и права агента, и ELECTRON_RUN_AS_NODE', () => {
    const cli = join(root, 'cli.js')
    writeFileSync(cli, '')
    const shim = join(root, 'opencode.cmd')
    writeFileSync(shim, '"%_prog%" "%dp0%\\cli.js" %*\r\n')
    const inv = invocation('opencode', 'acceptEdits')
    launchAgent(inv, root, (launch) => {
      assert.equal(launch.command, 'C:\\Orca\\Orca.exe')
      assert.deepEqual(launch.args, [cli, ...inv.args])
      assert.deepEqual(launch.env, { ...inv.env, ELECTRON_RUN_AS_NODE: '1' })
      return 'pty_win'
    }, undefined, { platform: 'win32', electronNode: 'C:\\Orca\\Orca.exe', findBin: () => shim })
  })

  it('Amp: JSONC-комментарии не портят строки с кавычками, слэшами и запятыми перед скобками', () => {
    const file = join(root, 'settings.jsonc')
    const expected = 'quote " // /* ,} ,] \\ path'
    writeFileSync(file, `/* before */ {"custom": ${JSON.stringify(expected)}, /* after comma */ } // end`)
    launchAgent(invocation('amp'), root, (launch, onExit) => {
      const argv = launch.args as string[]
      const generated = argv[argv.lastIndexOf('--settings-file') + 1]
      assert.equal(JSON.parse(readFileSync(generated, 'utf8')).custom, expected)
      onExit('pty', 0)
      return 'pty'
    }, undefined, { home: root, tempRoot: root, env: { AMP_SETTINGS_FILE: file }, platform: 'darwin' })
  })

  it('Amp: невалидный пользовательский конфиг не заменяется пустым и не запускает агента', () => {
    const file = join(root, 'bad.json')
    writeFileSync(file, '{broken')
    let started = false
    assert.throws(() => launchAgent(invocation('amp'), root, () => { started = true; return 'pty' }, undefined,
      { home: root, tempRoot: root, env: { AMP_SETTINGS_FILE: file }, platform: 'darwin' }), /Amp/)
    assert.equal(started, false)
    assert.deepEqual(readdirSync(root), ['bad.json'])
    assert.equal(readFileSync(file, 'utf8'), '{broken')
  })
})
