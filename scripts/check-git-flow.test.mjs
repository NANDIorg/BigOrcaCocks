import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-git-flow.mjs', import.meta.url))

// Проверяем настоящий CLI и exit code, а не совпадение текста конфигурации.
function check(t, { head, base, version = '0.0.7', desktop = version, fork = false, tag } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-flow-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'apps/desktop'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: desktop }))
  const event = head ? { pull_request: {
    head: { ref: head, repo: { full_name: fork ? 'fork/repo' : 'team/repo' } },
    base: { ref: base, repo: { full_name: 'team/repo' } }
  } } : {}
  const eventPath = join(root, 'event.json')
  writeFileSync(eventPath, JSON.stringify(event))
  return spawnSync(process.execPath, [script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: head ? 'pull_request' : 'push', GITHUB_REF: tag ? `refs/tags/${tag}` : '' }
  })
}

test('обычная фича идёт в develop, включая PR из fork', (t) => {
  assert.equal(check(t, { head: 'feature/42-search', base: 'develop' }).status, 0)
  assert.equal(check(t, { head: 'feature/docs', base: 'develop', fork: true }).status, 0)
})

test('фича, develop и служебная orca не могут попасть напрямую в master', (t) => {
  for (const head of ['feature/search', 'develop', 'orca/task_123', 'sync/release']) {
    const result = check(t, { head, base: 'master' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /направление PR/)
  }
})

test('релиз и hotfix в master требуют версию из имени ветки и свой репозиторий', (t) => {
  for (const head of ['release/0.0.7', 'hotfix/0.0.7']) {
    assert.equal(check(t, { head, base: 'master' }).status, 0)
    assert.equal(check(t, { head, base: 'master', version: '0.0.6' }).status, 1)
    assert.equal(check(t, { head, base: 'master', fork: true }).status, 1)
  }
})

test('стабилизация и обратная синхронизация не открывают путь фичам в релиз', (t) => {
  for (const [head, base] of [
    ['fix/crash', 'release/0.0.7'], ['fix/crash', 'hotfix/0.0.7'],
    ['sync/0.0.7-develop', 'develop']
  ]) assert.equal(check(t, { head, base }).status, 0, `${head} → ${base}`)
  for (const [head, base] of [
    ['feature/new', 'release/0.0.7'], ['develop', 'release/0.0.7'],
    ['orca/task_123', 'develop'], ['release/0.0.7', 'develop'],
    ['fix/crash', 'develop'], ['feature/new', 'unknown'], ['feature/', 'develop']
  ]) assert.equal(check(t, { head, base }).status, 1, `${head} → ${base}`)
})

test('перенос hotfix в активный релиз сохраняет версию релиза', (t) => {
  assert.equal(check(t, { head: 'sync/hotfix-0.0.7', base: 'release/0.1.0', version: '0.1.0' }).status, 0)
  assert.equal(check(t, { head: 'sync/hotfix-0.0.7', base: 'release/0.1.0', version: '0.0.7' }).status, 1)
  assert.equal(check(t, { head: 'fix/crash', base: 'hotfix/0.0.7', version: '0.0.6' }).status, 1)
})

test('расхождение версий и некорректный SemVer отклоняются даже вне PR', (t) => {
  for (const options of [{ desktop: '0.0.8' }, { version: 'v0.0.7' }, { version: '01.0.0' }]) {
    assert.equal(check(t, options).status, 1)
  }
  assert.equal(check(t).status, 0)
})

test('релизный тег точно совпадает с версиями пакетов', (t) => {
  assert.equal(check(t, { tag: 'v0.0.7' }).status, 0)
  for (const tag of ['v0.0.8', 'v01.0.7', 'v0.0.7-rc.1']) {
    assert.equal(check(t, { tag }).status, 1)
  }
})
