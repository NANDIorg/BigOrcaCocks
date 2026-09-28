import { test } from 'node:test'
import assert from 'node:assert/strict'
import { branchChip } from './runBranch'
import { setLocale } from './i18n'

const base = { branch: 'feature/run_a1-x', base: 'origin/develop', worktree: '/w/run_a1' }

test('чип ветки: подпись — имя, про push ничего (ветку ведёт человек)', () => {
  const chip = branchChip(base)
  assert.equal(chip.label, 'feature/run_a1-x')
  assert.doesNotMatch(chip.title, /remote|push/i)
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
