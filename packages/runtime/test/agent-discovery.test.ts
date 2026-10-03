import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orca discovery-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function config(home: string, text: string, cache?: string): void {
  const dir = join(home, '.codex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), text)
  if (cache !== undefined) writeFileSync(join(dir, 'models_cache.json'), cache)
}
function binary(dir = root, name = 'codex.cmd'): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '', { mode: 0o700 })
  return file
}
const codex = (service: ReturnType<typeof runtime.createAgentDiscovery>, refresh = false) => service.agentInfos(undefined, refresh).find(a => a.id === 'codex')!

describe('общий discovery: реестр и версии', () => {
  it('настоящий PATH определяет installed/enabled, порядок и возможности списка', () => {
    binary()
    const service = runtime.createAgentDiscovery({ home: root, platform: 'win32', env: { Path: root, Pathext: '.CMD' }, executeVersion: () => 'codex fixture' })
    const infos = service.agentInfos(undefined)
    assert.deepEqual(infos.map(a => a.id), ['claude', 'codex', 'opencode', 'gemini', 'cursor', 'amp', 'copilot', 'goose', 'shell'])
    assert.equal(codex(service).installed, true)
    assert.equal(codex(service).enabled, true)
    assert.equal(codex(service).version, 'codex fixture')
    assert.equal(service.agentInfos([]).find(a => a.id === 'codex')!.enabled, false)
    assert.ok(infos.every(a => a.supportsExtraArgs === true))
    assert.equal(infos.find(a => a.id === 'claude')!.installed, false)
    assert.equal(infos.find(a => a.id === 'claude')!.enabled, false)
  })

  it('кэш установки живёт до refresh, перечитывает изменённый PATH и изолирован между services', () => {
    const first = join(root, 'first'), second = join(root, 'second')
    mkdirSync(first); binary(second)
    const env = { Path: first, Pathext: '.CMD' }
    const one = runtime.createAgentDiscovery({ home: first, platform: 'win32', env, executeVersion: () => 'one' })
    const two = runtime.createAgentDiscovery({ home: second, platform: 'win32', env: { Path: second, Pathext: '.CMD' }, executeVersion: () => 'two' })
    assert.equal(codex(one).installed, false)
    assert.equal(codex(two).version, 'two')
    env.Path = second
    assert.equal(codex(one).installed, false)
    assert.equal(codex(one, true).version, 'one')
    rmSync(join(second, 'codex.cmd'))
    assert.equal(codex(one, true).installed, false)
    assert.equal(codex(two).version, 'two')
  })

  it('Windows cmd сохраняет quoting, аргументы версии, shell, timeout и env', () => {
    const file = binary()
    const env = { Path: root, Pathext: '.CMD', DISCOVERY_FIXTURE: 'explicit' }
    const service = runtime.createAgentDiscovery({ home: root, platform: 'win32', env, executeVersion: command => {
      assert.deepEqual(command, { file: `"${file}"`, args: ['--version'], shell: true, timeout: 3000, env })
      return '\r\n  fixture version  \r\nsecond line'
    } })
    assert.equal(codex(service).version, 'fixture version')
  })

  it('прямой binary использует argv без shell и обрезает первую непустую строку', () => {
    const file = binary(root, 'codex.exe')
    const env = { PATH: root, PATHEXT: '.EXE' }
    const service = runtime.createAgentDiscovery({ home: root, platform: 'win32', env, executeVersion: command => {
      assert.deepEqual(command, { file, args: ['--version'], timeout: 3000, env })
      return '\n' + 'v'.repeat(100) + '\nignored'
    } })
    assert.equal(codex(service).version, 'v'.repeat(60))
  })

  for (const result of ['empty', 'error', 'timeout'] as const) {
    it(`${result} версии сохраняет installed и enabled`, () => {
      binary()
      const service = runtime.createAgentDiscovery({ home: root, platform: 'win32', env: { PATH: root, PATHEXT: '.CMD' }, executeVersion: () => {
        if (result === 'empty') return '  \n\r\n'
        throw Object.assign(new Error(result), result === 'timeout' ? { code: 'ETIMEDOUT' } : {})
      } })
      const info = codex(service)
      assert.equal(info.installed, true)
      assert.equal(info.enabled, true)
      assert.equal(info.version, undefined)
    })
  }

  for (const scenario of ['env', 'timeout'] as const) {
    it(`реальный fixture CLI: ${scenario}, без провайдера LLM`, () => {
      const script = join(root, 'version.cjs')
      // На Windows timeout shell не гарантирует kill дочернего Node; fixture сам завершится.
      writeFileSync(script, scenario === 'env' ? "process.stdout.write('\\n' + process.env.DISCOVERY_FIXTURE + '\\nignored')" : 'setTimeout(() => {}, 4000)')
      const file = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
      writeFileSync(file, process.platform === 'win32'
        ? `@"${process.execPath}" "${script}"\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o700 })
      const service = runtime.createAgentDiscovery({ home: root, env: { ...process.env, PATH: root, PATHEXT: '.CMD', DISCOVERY_FIXTURE: 'fixture from env' } })
      const info = codex(service)
      assert.equal(info.installed, true)
      assert.equal(info.version, scenario === 'env' ? 'fixture from env' : undefined)
    })
  }
})

describe('общий discovery: конфигурация моделей', () => {
  const service = (home = root, now?: () => number) => runtime.createAgentDiscovery({ home, now, platform: 'win32', env: { PATH: '', PATHEXT: '.CMD' } })

  it('читает home/config и cache, скрывает чужую модель и сохраняет скрытый default', () => {
    config(root, 'model = "private"\nmodel_reasoning_effort = \'high\'\n[profile]\nmodel = "wrong"', JSON.stringify({ models: [
      { slug: 'public', display_name: 'Public', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'hidden', visibility: 'hide' }, { slug: 'private', visibility: 'hide' }
    ] }))
    const info = codex(service())
    assert.deepEqual(info.defaults, { model: 'private', effort: 'high' })
    assert.deepEqual(info.models.map(m => [m.id, m.efforts]), [['public', ['low', 'high']], ['private', undefined]])
    assert.match(info.models[1].label, /по умолчанию/)
  })

  it('60 секунд TTL и refresh читают реальный изменённый config/cache', () => {
    let now = 0
    config(root, 'model = "one"', '{"models":[{"slug":"one"}]}')
    const one = service(root, () => now), two = service(root, () => now)
    assert.equal(codex(one).defaults.model, 'one')
    assert.equal(codex(two).defaults.model, 'one')
    config(root, 'model = "two"', '{"models":[{"slug":"two"}]}')
    now = 59_999
    assert.equal(codex(one).defaults.model, 'one')
    assert.equal(codex(two, true).models[0].id, 'two')
    assert.equal(codex(one).defaults.model, 'one')
    now = 60_000
    assert.equal(codex(one).models[0].id, 'two')
  })

  it('разные home и явный codexDir не читают друг друга', () => {
    const first = join(root, 'first'), second = join(root, 'second')
    config(first, 'model = "one"')
    config(second, 'model = "two"')
    const one = service(first), two = service(second)
    assert.equal(codex(one).defaults.model, 'one')
    assert.equal(codex(two).defaults.model, 'two')
    const explicit = runtime.createAgentDiscovery({ home: first, codexDir: join(second, '.codex'), platform: 'win32', env: { PATH: '' } })
    assert.equal(codex(explicit).defaults.model, 'two')
    config(first, 'model = "new"')
    assert.equal(codex(one, true).defaults.model, 'new')
    assert.equal(codex(two).defaults.model, 'two')
  })

  it('нет файлов — пустые codex defaults/models; другие агенты используют registry', () => {
    const infos = service().agentInfos(undefined)
    const info = infos.find(a => a.id === 'codex')!
    assert.deepEqual(info.defaults, {})
    assert.deepEqual(info.models, [])
    const claude = infos.find(a => a.id === 'claude')!
    assert.equal(claude.models[0].id, 'opus')
    assert.deepEqual(claude.defaults, {})
  })

  it('битый cache сохраняет модель config, ошибка чтения config не роняет весь список', () => {
    config(root, 'model = "custom"', '{broken')
    const one = service()
    assert.equal(codex(one).models[0].id, 'custom')
    rmSync(join(root, '.codex', 'config.toml'))
    mkdirSync(join(root, '.codex', 'config.toml'))
    assert.deepEqual(codex(one, true).defaults, {})
    assert.deepEqual(codex(one).models, [])
  })

  it('top-level TOML сохраняет строки/комментарии, игнорирует числа и секции', () => {
    assert.deepEqual(runtime.parseTopLevelToml('model = "custom" # note\r\nmodel_reasoning_effort = \'high\'\nnumber = 5\n[profiles.other]\nmodel = "wrong"'), { model: 'custom', model_reasoning_effort: 'high' })
    assert.deepEqual(runtime.parseTopLevelToml('model = "a\\\"b"\ninvalid = "unterminated\n'), { model: 'a\\"b' })
  })
})
