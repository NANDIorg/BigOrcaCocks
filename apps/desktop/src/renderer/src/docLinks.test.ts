import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRecent, matchesQuery, resolveDocLink, RECENT_MS } from './docLinks'

test('resolveDocLink — относительные ссылки от папки текущего документа', () => {
  assert.equal(resolveDocLink('docs/a.md', 'b.md'), 'docs/b.md')
  assert.equal(resolveDocLink('docs/a.md', './sub/c.md#раздел'), 'docs/sub/c.md')
  assert.equal(resolveDocLink('docs/a.md', '../README.md'), 'README.md')
  assert.equal(resolveDocLink('README.md', 'docs/%D0%BF%D0%BB%D0%B0%D0%BD.md'), 'docs/план.md')
})

test('resolveDocLink — внешние, якоря, абсолютные, не-.md и выход за корень не открываются', () => {
  assert.equal(resolveDocLink('a.md', 'https://x.dev/a.md'), null)
  assert.equal(resolveDocLink('a.md', 'file:///etc/a.md'), null)
  assert.equal(resolveDocLink('a.md', '#section'), null)
  assert.equal(resolveDocLink('a.md', '/etc/a.md'), null)
  assert.equal(resolveDocLink('a.md', 'src/index.ts'), null)
  assert.equal(resolveDocLink('docs/a.md', '../../secret.md'), null)
  assert.equal(resolveDocLink('a.md', '%E0%A4%A.md'), null)
})

test('isRecent — новый файл или изменён за сутки', () => {
  const now = 10 * RECENT_MS
  assert.equal(isRecent({ path: 'a.md', size: 1, mtime: now - 1000, untracked: false }, now), true)
  assert.equal(isRecent({ path: 'a.md', size: 1, mtime: now - 2 * RECENT_MS, untracked: false }, now), false)
  assert.equal(isRecent({ path: 'a.md', size: 1, mtime: 0, untracked: true }, now), true)
})

test('matchesQuery — все слова, без учёта регистра', () => {
  const f = { path: 'docs/Nested-Kanban.md', size: 1, mtime: 0, untracked: false }
  assert.equal(matchesQuery(f, ''), true)
  assert.equal(matchesQuery(f, 'kanban docs'), true)
  assert.equal(matchesQuery(f, 'kanban readme'), false)
})
