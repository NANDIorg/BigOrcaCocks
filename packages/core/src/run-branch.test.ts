import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RUN_BRANCH_SETTINGS, branchNameProblem, branchSlug, isProtectedBranch, normalizeRunBranchSettings,
  runBranchName, runBranchSettingsProblems
} from './run-branch.ts'
import { TaskStore } from './store.ts'

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
  it('подставляет runId и slug', () => {
    assert.equal(runBranchName('feature/{runId}-{slug}', { id: 'run_a1', title: 'Бейдж ветки' }), 'feature/run_a1-beydzh-vetki')
  })

  it('неизвестная подстановка остаётся — её ловит проверка имени', () => {
    const name = runBranchName('feature/{issue}-{runId}', { id: 'run_a1', title: 'x' })
    assert.equal(name, 'feature/{issue}-run_a1')
    assert.match(branchNameProblem(name) ?? '', /неизвестная подстановка \{issue\}/)
  })
})

describe('branchNameProblem', () => {
  it('допустимые имена', () => {
    for (const name of ['feature/run_a1-x', 'orca/task_1', 'fix/1.0.1-a']) assert.equal(branchNameProblem(name), undefined, name)
  })

  it('недопустимые имена', () => {
    for (const name of ['', 'a b', 'a..b', 'a/', '/a', '-a', 'a.lock', 'a~1', 'a:b', 'feature/.x', 'a@{1}', 'a//b']) {
      assert.ok(branchNameProblem(name), name)
    }
  })
})

describe('isProtectedBranch', () => {
  it('точное имя и шаблон со звёздочкой', () => {
    const p = DEFAULT_RUN_BRANCH_SETTINGS.protected
    for (const b of ['master', 'main', 'develop', 'release/1.0.1', 'hotfix/2.0.0']) assert.ok(isProtectedBranch(b, p), b)
    for (const b of ['feature/x', 'masterpiece', 'my-develop', 'orca/task_1']) assert.ok(!isProtectedBranch(b, p), b)
  })

  it('пустой список — защиты нет; точка в шаблоне — буквально', () => {
    assert.ok(!isProtectedBranch('master', []))
    assert.ok(isProtectedBranch('v1.0', ['v1.0']))
    assert.ok(!isProtectedBranch('v1x0', ['v1.0']))
  })
})

describe('normalizeRunBranchSettings', () => {
  it('нет настроек — по умолчанию (копия, не общий массив)', () => {
    const s = normalizeRunBranchSettings(undefined)
    assert.deepEqual(s, { ...DEFAULT_RUN_BRANCH_SETTINGS, protected: [...DEFAULT_RUN_BRANCH_SETTINGS.protected] })
    s.protected.push('x')
    assert.ok(!DEFAULT_RUN_BRANCH_SETTINGS.protected.includes('x'))
  })

  it('чужие типы отбрасываются, строки обрезаются, пустой шаблон — по умолчанию', () => {
    const s = normalizeRunBranchSettings({ enabled: 'yes', base: ' origin/develop ', template: '  ', push: true, remote: 1, protected: ['main', ' ', 3, 'main'] })
    assert.equal(s.enabled, true)
    assert.equal(s.base, 'origin/develop')
    assert.equal(s.template, DEFAULT_RUN_BRANCH_SETTINGS.template)
    assert.equal(s.push, true)
    assert.equal(s.remote, 'origin')
    assert.deepEqual(s.protected, ['main'])
  })
})

describe('runBranchSettingsProblems', () => {
  it('по умолчанию — без ошибок', () => {
    assert.deepEqual(runBranchSettingsProblems(normalizeRunBranchSettings(undefined)), [])
  })

  it('шаблон без {runId}, битые шаблон, база и remote', () => {
    const d = normalizeRunBranchSettings(undefined)
    const codes = (patch: Partial<typeof d>): string[] => runBranchSettingsProblems({ ...d, ...patch }).map((x) => x.code)
    assert.deepEqual(codes({ template: 'feature/{slug}' }), ['templateRunId'])
    assert.deepEqual(codes({ template: 'feature/{runId}..x' }), ['templateName'])
    assert.deepEqual(codes({ base: 'origin/dev elop' }), ['base'])
    assert.deepEqual(codes({ remote: 'a/b' }), ['remote'])
    assert.match(runBranchSettingsProblems({ ...d, template: 'feature/{slug}' })[0].text, /\{runId\}/)
  })
})

describe('TaskStore.setRunGit', () => {
  it('заводит, дополняет и снимает поля; копия уходит в карточку', () => {
    const store = new TaskStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    store.setRunGit(run.id, { branch: 'feature/x', base: 'origin/develop', worktree: '/tmp/wt' })
    store.setRunGit(run.id, { pushedAt: 5 })
    assert.deepEqual(store.getRun(run.id)!.git, { branch: 'feature/x', base: 'origin/develop', worktree: '/tmp/wt', pushedAt: 5 })
    store.setRunGit(run.id, { worktree: undefined })
    assert.deepEqual(store.getGlobalTask(run.id).git, { branch: 'feature/x', base: 'origin/develop', pushedAt: 5 })
  })

  it('без ветки и базы — ошибка; у «Входящих» ветки нет', () => {
    const store = new TaskStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    assert.throws(() => store.setRunGit(run.id, { pushedAt: 1 }), /нужны branch и base/)
    const task = store.createTask({ title: 'без прогона', spec: '' })
    assert.throws(() => store.setRunGit(task.runId!, { branch: 'b', base: 'main' }), /«Входящих»/)
  })
})
