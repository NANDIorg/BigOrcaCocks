import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { branchSlug, runBranchName } from './run-branch.ts'
import { DEFAULT_COLUMNS } from './types.ts'
import { TaskStore, type Persistence } from './store.ts'

describe('branchSlug', () => {
  it('кириллица транслитерируется, остальное — дефисы', () => {
    assert.equal(branchSlug('Группы проектов в меню'), 'gruppy-proektov-v-menyu')
    assert.equal(branchSlug('Fix: CLI --help (v2)'), 'fix-cli-help-v2')
    assert.equal(branchSlug('Щука и ёж'), 'schuka-i-ezh')
  })

  it('пустой слаг — task, длина не больше 40 и без дефиса в конце', () => {
    assert.equal(branchSlug('!!!'), 'task')
    const long = branchSlug('очень длинное название задачи которое никак не помещается в ветку')
    assert.ok(long.length <= 40, long)
    assert.ok(!long.endsWith('-'), long)
  })
})

describe('runBranchName', () => {
  it('feature/<runId>-<slug>', () => {
    assert.equal(runBranchName({ id: 'run_a1', title: 'Бейдж ветки' }), 'feature/run_a1-beydzh-vetki')
    assert.equal(runBranchName({ id: 'run_a1', title: '!!!' }), 'feature/run_a1-task')
  })
})

describe('TaskStore.setRunGit', () => {
  it('заводит, дополняет и снимает поля; копия уходит в карточку', () => {
    const store = new TaskStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    store.setRunGit(run.id, { branch: 'feature/x', base: 'develop', worktree: '/tmp/wt' })
    assert.deepEqual(store.getRun(run.id)!.git, { branch: 'feature/x', base: 'develop', worktree: '/tmp/wt' })
    store.setRunGit(run.id, { worktree: undefined })
    assert.deepEqual(store.getGlobalTask(run.id).git, { branch: 'feature/x', base: 'develop' })
  })

  it('без ветки и базы — ошибка; у «Входящих» ветки нет', () => {
    const store = new TaskStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    assert.throws(() => store.setRunGit(run.id, { worktree: '/tmp/wt' }), /нужны branch и base/)
    const task = store.createTask({ title: 'без прогона', spec: '' })
    assert.throws(() => store.setRunGit(task.runId!, { branch: 'b', base: 'main' }), /«Входящих»/)
  })
})

describe('миграция Run.git', () => {
  it('поля автоматического push убираются при загрузке, ветка и worktree остаются', () => {
    const src = new TaskStore()
    const run = src.createGlobalTask({ title: 'Фича' })
    src.setRunGit(run.id, { branch: 'feature/x', base: 'develop', worktree: '/tmp/wt' })
    const snap = src.snapshot()
    const stored = snap.runs.find((r) => r.id === run.id)!
    stored.git = { ...stored.git!, ...{ pushedAt: 5, pushError: 'rejected' } }
    let saved = 0
    const p: Persistence = { load: () => snap, save: () => { saved++ } }
    const store = new TaskStore(p, () => DEFAULT_COLUMNS)
    assert.deepEqual(store.getRun(run.id)!.git, { branch: 'feature/x', base: 'develop', worktree: '/tmp/wt' })
    assert.ok(saved > 0, 'файл пересохранён')
  })
})
