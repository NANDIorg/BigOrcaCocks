import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-release-codenames.mjs', import.meta.url))
const registryPath = 'packages/core/src/release-codenames.json'
const old = [{ series: '1.0', name: 'Orca' }]
function fixture(t, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'orca-codenames-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['apps/desktop', 'packages/core/src']) mkdirSync(join(root, dir), { recursive: true })
  const write = (path, value) => writeFileSync(join(root, path), JSON.stringify(value))
  for (const path of ['package.json', 'apps/desktop/package.json']) write(path, { version: '1.0.1' })
  if (!legacy) write(registryPath, old)
  const git = (args) => execFileSync('git', ['-c', 'user.name=Orca test', '-c', 'user.email=test@orca.invalid', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-b', 'main'])
  const commit = () => { git(['add', '.']); git(['commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']) }
  const base = commit()
  return { root, write, git, commit, base, run(event, output = false) {
    const eventPath = join(root, 'event.json')
    writeFileSync(eventPath, JSON.stringify(event ?? {}))
    return spawnSync(process.execPath, [script, ...(output ? ['--github-output'] : [])], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: event?.pull_request ? 'pull_request' : event ? 'push' : '', GITHUB_REF: '', GITHUB_OUTPUT: join(root, 'outputs') } })
  } }
}

test('настоящий guard разрешает новую пару и отдаёт общий заголовок GitHub', (t) => {
  const f = fixture(t)
  f.write(registryPath, [...old, { series: '1.1', name: 'Sea Lion' }])
  for (const path of ['package.json', 'apps/desktop/package.json']) f.write(path, { version: '1.1.3' })
  const result = f.run(undefined, true)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.root, 'outputs'), 'utf8'), 'version=1.1.3\ntitle=Orca 1.1.3 · Sea Lion\n')
})
test('серия текущей версии обязана иметь имя', (t) => {
  const f = fixture(t)
  for (const path of ['package.json', 'apps/desktop/package.json']) f.write(path, { version: '2.0.0' })
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /имя/)
})
test('повтор имени, удаление и переназначение относительно HEAD запрещены', (t) => {
  for (const entries of [[], [{ series: '1.0', name: 'Dolphin' }], [...old, { series: '1.1', name: 'orca' }]]) {
    const f = fixture(t)
    f.write(registryPath, entries)
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /удал|менять|повтор/)
  }
})
test('исторический релиз защищает имя даже после коммита переназначения', (t) => {
  const f = fixture(t)
  f.git(['tag', 'v1.0.0'])
  f.write(registryPath, [{ series: '1.0', name: 'Dolphin' }])
  f.commit()
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /менять/)
})
test('база PR и предыдущий push защищают имя после изменения HEAD', (t) => {
  for (const event of ['pr', 'push']) {
    const f = fixture(t)
    f.write(registryPath, [{ series: '1.0', name: 'Dolphin' }])
    f.commit()
    const result = f.run(event === 'pr' ? { pull_request: { base: { sha: f.base } } } : { before: f.base })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /менять/)
  }
})
test('недоступная база не считается историей без реестра', (t) => {
  const f = fixture(t)
  const missing = f.run({ pull_request: { base: { sha: 'f'.repeat(40) } } })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /git/)
  const invalid = f.run({ pull_request: { base: { sha: '--invalid' } } })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /SHA базы/)
})
test('старые теги без реестра допускают первое назначение имени', (t) => {
  const f = fixture(t, true)
  f.git(['tag', 'v1.0.0'])
  f.write(registryPath, old)
  const result = f.run({ before: f.base })
  assert.equal(result.status, 0, result.stderr)
})
