import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RUN_BRANCH_SETTINGS, type RunBranchSettings } from '@orca-board/core'
import { currentBranchProtected, GIT_FINISHES, gitFinish, gitFlow, withGitFinish } from './gitSettingsForm'
import { setLocale } from './i18n'

const s = (over: Partial<RunBranchSettings> = {}): RunBranchSettings => ({
  ...DEFAULT_RUN_BRANCH_SETTINGS, protected: [...DEFAULT_RUN_BRANCH_SETTINGS.protected], ...over
})

test('«когда готово»: три варианта из push/pr туда и обратно, pr без push — «ничего»', () => {
  for (const f of GIT_FINISHES) assert.equal(gitFinish(withGitFinish(f)), f)
  assert.deepEqual(withGitFinish('pr'), { push: true, pr: true })
  assert.deepEqual(withGitFinish('none'), { push: false, pr: false })
  assert.equal(gitFinish({ push: false, pr: true }), 'none')
})

test('схема режима «в текущую ветку»: подзадача → ветка проекта, неизвестная — словами', () => {
  assert.deepEqual(gitFlow(s(), 'main', 'current'), ['подзадача', 'main'])
  assert.deepEqual(gitFlow(s(), null, 'current'), ['подзадача', 'текущая ветка'])
})

test('схема режима «ветка на задачу»: префикс шаблона, remote при push, база PR без remote', () => {
  assert.deepEqual(gitFlow(s(), 'main', 'run'), ['подзадача', 'feature/…'])
  assert.deepEqual(gitFlow(s({ push: true }), 'main', 'run'), ['подзадача', 'feature/…', 'origin'])
  assert.deepEqual(gitFlow(s({ push: true, pr: true, base: 'origin/develop' }), 'main', 'run'), ['подзадача', 'feature/…', 'PR', 'develop'])
  // Пустая база или коммит — PR в ветку, открытую в проекте.
  assert.deepEqual(gitFlow(s({ push: true, pr: true }), 'main', 'run').at(-1), 'main')
  assert.deepEqual(gitFlow(s({ push: true, pr: true, base: 'a1b2c3d' }), 'main', 'run').at(-1), 'main')
})

test('схема по-английски', () => {
  setLocale('en')
  try {
    assert.deepEqual(gitFlow(s(), null, 'current'), ['subtask', 'current branch'])
  } finally {
    setLocale('ru')
  }
})

test('предупреждение о защищённой ветке проекта: по черновику списка, со звёздочкой, без ветки — нет', () => {
  assert.equal(currentBranchProtected('main', 'master, main'), true)
  assert.equal(currentBranchProtected('release/1.0', 'release/*'), true)
  assert.equal(currentBranchProtected('main', ''), false)
  assert.equal(currentBranchProtected('feature/x', 'main, develop'), false)
  assert.equal(currentBranchProtected(null, 'main'), false)
})
