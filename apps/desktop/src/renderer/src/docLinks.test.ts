import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { docLinkHash, docsApi, formatSize, isRecent, isStaleDocsError, matchesQuery, resolveDocLink, RECENT_MS, staleAppMessage } from './docLinks'
import { setLocale } from './i18n'
import type { OrcaApi } from '../../shared/ipc'

test('docsApi — старый preload без docs даёт понятную ошибку, а не TypeError', () => {
  assert.throws(() => docsApi(undefined), { message: staleAppMessage() })
  assert.throws(() => docsApi({} as Partial<OrcaApi>), { message: staleAppMessage() })
  const docs = { list: async () => [] } as unknown as OrcaApi['docs']
  assert.equal(docsApi({ docs }), docs)
})

afterEach(() => setLocale('ru'))

test('docsApi и formatSize — на языке интерфейса', () => {
  assert.equal(formatSize(1536 * 1024), '1,5 МБ')
  setLocale('en')
  assert.throws(() => docsApi(undefined), { message: /old main\/preload without Docs/ })
  assert.equal(formatSize(500), '500 B')
  assert.equal(formatSize(1536 * 1024), '1.5 MB')
})

test('isStaleDocsError — старый main без хендлеров docs:*', () => {
  assert.equal(isStaleDocsError("No handler registered for 'docs:list'"), true)
  assert.equal(isStaleDocsError('файл вне проекта'), false)
})

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

test('docLinkHash — якорь из ссылки на документ', () => {
  assert.equal(docLinkHash('b.md#%D0%A0%D0%BE%D0%BB%D0%B8'), 'Роли')
  assert.equal(docLinkHash('b.md#intro'), 'intro')
  assert.equal(docLinkHash('b.md'), undefined)
  assert.equal(docLinkHash('b.md#'), undefined)
  assert.equal(docLinkHash('b.md#%E0%A4%A'), undefined)
})
