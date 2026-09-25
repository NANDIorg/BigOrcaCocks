import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { branchBadge, loadBranchInfo, sameBranchInfo } from './projectBranch'
import { setLocale } from './i18n'
import type { OrcaApi, ProjectBranchInfo } from '../../shared/ipc'

afterEach(() => setLocale('ru'))

test('branchBadge — обычная ветка: имя и полная подсказка', () => {
  const b = branchBadge({ isGitRepo: true, branch: 'feature/очень-длинное-имя-ветки', detached: false })
  assert.deepEqual(b, { label: 'feature/очень-длинное-имя-ветки', title: 'Ветка: feature/очень-длинное-имя-ветки', detached: false })
})

test('branchBadge — detached HEAD: короткий sha с пометкой', () => {
  const b = branchBadge({ isGitRepo: true, branch: null, detached: true, sha: 'abc1234' })
  assert.equal(b?.label, 'abc1234')
  assert.equal(b?.mark, 'detached')
  assert.equal(b?.detached, true)
  assert.match(b?.title ?? '', /abc1234/)
  assert.equal(branchBadge({ isGitRepo: true, branch: null, detached: true })?.label, 'HEAD')
})

test('branchBadge — не git, нет ответа или пустое имя: бейджа нет', () => {
  assert.equal(branchBadge({ isGitRepo: false, branch: null, detached: false }), null)
  assert.equal(branchBadge(null), null)
  assert.equal(branchBadge(undefined), null)
  assert.equal(branchBadge({ isGitRepo: true, branch: null, detached: false }), null)
})

test('branchBadge — тексты на языке интерфейса', () => {
  setLocale('en')
  assert.equal(branchBadge({ isGitRepo: true, branch: 'main', detached: false })?.title, 'Branch: main')
  assert.equal(branchBadge({ isGitRepo: true, branch: null, detached: true, sha: 'abc1234' })?.mark, 'detached')
})

test('sameBranchInfo сравнивает по полям', () => {
  const a: ProjectBranchInfo = { isGitRepo: true, branch: 'main', detached: false }
  assert.ok(sameBranchInfo(a, { ...a }))
  assert.ok(sameBranchInfo(null, null))
  assert.ok(!sameBranchInfo(a, null))
  assert.ok(!sameBranchInfo(a, { ...a, branch: 'dev' }))
  assert.ok(!sameBranchInfo(a, { ...a, detached: true, sha: 'abc' }))
})

test('loadBranchInfo — старый preload без метода и ошибка main дают null, а не падение', async () => {
  assert.equal(await loadBranchInfo(undefined, 'p1'), null)
  assert.equal(await loadBranchInfo({} as Partial<OrcaApi>, 'p1'), null)
  assert.equal(await loadBranchInfo({ projects: {} } as unknown as Partial<OrcaApi>, 'p1'), null)
  const stale = { projects: { branch: async () => { throw new Error("No handler registered for 'projects:branch'") } } }
  assert.equal(await loadBranchInfo(stale as unknown as Partial<OrcaApi>, 'p1'), null)
})

test('loadBranchInfo — передаёт id проекта и возвращает ответ', async () => {
  const info: ProjectBranchInfo = { isGitRepo: true, branch: 'main', detached: false }
  let got = ''
  const api = { projects: { branch: async (id: string) => { got = id; return info } } }
  assert.deepEqual(await loadBranchInfo(api as unknown as Partial<OrcaApi>, 'p1'), info)
  assert.equal(got, 'p1')
})
