import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchChip, prLink } from './runBranch'
import { setLocale } from './i18n'

const base = { branch: 'feature/run_a1-x', base: 'origin/develop', worktree: '/w/run_a1' }

test('чип ветки: без push — обычный, с push — ok, ошибка push важнее прошлого успеха', () => {
  assert.equal(branchChip(base).tone, 'plain')
  assert.equal(branchChip({ ...base, pushedAt: 1 }).tone, 'ok')
  const failed = branchChip({ ...base, pushedAt: 1, pushError: 'rejected' })
  assert.equal(failed.tone, 'warn')
  assert.match(failed.title, /rejected/)
  assert.equal(failed.label, 'feature/run_a1-x')
})

test('подсказка: база, папка или что она убрана, на английском — по-английски', () => {
  assert.match(branchChip(base).title, /origin\/develop[\s\S]*\/w\/run_a1/)
  assert.match(branchChip({ branch: 'b', base: 'main' }).title, /Папка убрана/)
  setLocale('en')
  try {
    assert.match(branchChip({ branch: 'b', base: 'main' }).title, /Branched off main[\s\S]*Folder removed/)
  } finally {
    setLocale('ru')
  }
})

test('PR: ссылка в подсказке, ошибка PR — warn, ссылка только https', () => {
  const ok = branchChip({ ...base, pushedAt: 1, prUrl: 'https://github.com/o/r/pull/7' })
  assert.equal(ok.tone, 'ok')
  assert.match(ok.title, /PR: https:\/\/github\.com\/o\/r\/pull\/7/)
  const failed = branchChip({ ...base, pushedAt: 1, prError: 'gh: not logged in' })
  assert.equal(failed.tone, 'warn')
  assert.match(failed.title, /PR не создан: gh: not logged in/)
  assert.doesNotMatch(branchChip(base).title, /PR/)
  assert.equal(prLink({ ...base, prUrl: 'https://github.com/o/r/pull/7' }), 'https://github.com/o/r/pull/7')
  assert.equal(prLink({ ...base, prUrl: 'javascript:alert(1)' }), undefined)
  assert.equal(prLink({ ...base, prUrl: 'http://x/y' }), undefined)
  assert.equal(prLink(base), undefined)
})
