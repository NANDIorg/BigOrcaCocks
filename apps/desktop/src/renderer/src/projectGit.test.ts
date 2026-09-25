// Логика меню веток: фильтр и порядок, тексты ошибок по коду OrcaError, доступность git-методов в старом preload.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_GIT_ERROR_CODES, type OrcaApi, type ProjectBranchList } from '../../shared/ipc'
import { setLocale } from './i18n'
import {
  aheadBehindLabel,
  filterBranches,
  firstPickable,
  gitErrorMessage,
  gitOutputText,
  isStaleGitError,
  projectGitApi,
  remoteLocalName,
  staleGitMessage,
  upstreamLine
} from './projectGit'

afterEach(() => setLocale('ru'))

/** Ошибка invoke так, как её видит renderer: обёртка ipcRenderer + OrcaError[код]. */
function orcaError(code: string, text: string): Error {
  return new Error(`Error invoking remote method 'projects:gitPull': OrcaError[${code}]: ${text}`)
}

const LIST: Pick<ProjectBranchList, 'local' | 'remote'> = {
  local: [
    { name: 'develop', current: false, busy: false },
    { name: 'feature/login', current: false, busy: true },
    { name: 'main', current: true, busy: false }
  ],
  remote: ['origin/develop', 'origin/feature/search', 'origin/main', 'upstream/release/1.0']
}

test('filterBranches — текущая первой, удалённые без дублей локальных', () => {
  const v = filterBranches(LIST, '')
  assert.deepEqual(v.local.map((b) => b.name), ['main', 'develop', 'feature/login'])
  assert.deepEqual(v.remote, ['origin/feature/search', 'upstream/release/1.0'])
})

test('filterBranches — подстрока без учёта регистра и пробелов по краям, в обоих списках', () => {
  const v = filterBranches(LIST, '  FEAT ')
  assert.deepEqual(v.local.map((b) => b.name), ['feature/login'])
  assert.deepEqual(v.remote, ['origin/feature/search'])
  assert.deepEqual(filterBranches(LIST, 'нет такой'), { local: [], remote: [] })
})

test('filterBranches — не меняет исходный список', () => {
  const before = JSON.stringify(LIST)
  filterBranches(LIST, '')
  assert.equal(JSON.stringify(LIST), before)
})

test('remoteLocalName — первый сегмент это remote, остальное имя ветки', () => {
  assert.equal(remoteLocalName('origin/feature/x'), 'feature/x')
  assert.equal(remoteLocalName('origin/main'), 'main')
})

test('firstPickable — пропускает текущую и занятую, локальные раньше удалённых', () => {
  assert.equal(firstPickable(filterBranches(LIST, '')), 'develop')
  assert.equal(firstPickable(filterBranches(LIST, 'feature')), 'origin/feature/search')
  assert.equal(firstPickable(filterBranches(LIST, 'main')), null)
})

test('aheadBehindLabel / upstreamLine — расхождение, синхронность, upstream пропал, upstream нет', () => {
  assert.equal(aheadBehindLabel({ ahead: 2, behind: 1, gone: false }), '↑2 ↓1')
  assert.equal(aheadBehindLabel({ ahead: 0, behind: 3, gone: false }), '↓3')
  assert.equal(aheadBehindLabel({ ahead: 0, behind: 0, gone: false }), '')
  assert.equal(aheadBehindLabel({ ahead: 5, behind: 0, gone: true }), '')
  assert.equal(aheadBehindLabel(undefined), '')
  assert.equal(upstreamLine({ name: 'origin/main', ahead: 1, behind: 0, gone: false }), 'origin/main · ↑1')
  assert.equal(upstreamLine({ name: 'origin/main', ahead: 0, behind: 0, gone: false }), 'origin/main · синхронизирована')
  assert.match(upstreamLine({ name: 'origin/x', ahead: 0, behind: 0, gone: true }), /origin\/x.*удалён/)
  assert.equal(upstreamLine(undefined), 'Нет upstream')
  setLocale('en')
  assert.equal(upstreamLine(undefined), 'No upstream')
})

test('gitErrorMessage — известные коды дают свой текст по коду, а не по тексту main', () => {
  const dirty = gitErrorMessage(orcaError('git.dirtyTree', 'какой-то текст main'))
  assert.match(dirty, /незакоммиченные/)
  assert.doesNotMatch(dirty, /какой-то текст main/)
  assert.match(gitErrorMessage(orcaError('git.notFastForward', 'x'), { branch: 'main' }), /«main».*fast-forward/)
  assert.match(gitErrorMessage(orcaError('git.noUpstream', 'x'), { branch: 'dev' }), /«dev».*upstream/)
  assert.match(gitErrorMessage(orcaError('git.branchBusy', 'x'), { branch: 'feat' }), /«feat».*worktree/)
  assert.match(gitErrorMessage(orcaError('git.workersActive', 'x')), /агенты Orca/)
  assert.match(gitErrorMessage(orcaError('git.branchNotFound', 'x'), { branch: 'zzz' }), /«zzz»/)
  assert.match(gitErrorMessage(orcaError('git.notRepo', 'x')), /не git-репозиторий/)
})

test('gitErrorMessage — каждый код контракта, кроме opFailed, имеет свой текст на обоих языках', () => {
  for (const locale of ['ru', 'en'] as const) {
    setLocale(locale)
    for (const code of PROJECT_GIT_ERROR_CODES) {
      if (code === 'git.opFailed') continue
      const text = gitErrorMessage(orcaError(code, 'MAIN-TEXT'), { branch: 'b' })
      assert.ok(text && !text.includes('MAIN-TEXT'), `${locale}: ${code}`)
      assert.ok(!/\{\w+\}/.test(text), `${locale}: ${code} — не подставлен параметр`)
    }
  }
})

test('gitErrorMessage — opFailed, неизвестный код и обычная ошибка: сообщение main без обёртки', () => {
  assert.equal(gitErrorMessage(orcaError('git.opFailed', 'git fetch: Could not resolve host')), 'git fetch: Could not resolve host')
  assert.equal(gitErrorMessage(new Error("Error invoking remote method 'projects:gitFetch': Error: не реализовано: projects:gitFetch")), 'не реализовано: projects:gitFetch')
  assert.equal(gitErrorMessage(new Error('')), 'Git-команда не выполнена.')
})

test('старый main: нет обработчика канала — «перезапустите приложение»', () => {
  const e = new Error("Error invoking remote method 'projects:branches': Error: No handler registered for 'projects:branches'")
  assert.equal(isStaleGitError(e), true)
  assert.equal(gitErrorMessage(e), staleGitMessage())
  assert.equal(isStaleGitError(new Error('другая ошибка')), false)
  assert.match(staleGitMessage(), /Перезапустите приложение/)
})

test('projectGitApi — старый preload (нет методов) даёт null, новый — все четыре метода', () => {
  assert.equal(projectGitApi(undefined), null)
  assert.equal(projectGitApi({}), null)
  assert.equal(projectGitApi({ projects: {} as OrcaApi['projects'] }), null)
  const partial = { projects: { branches: async () => ({}), gitFetch: async () => ({}) } } as unknown as Partial<OrcaApi>
  assert.equal(projectGitApi(partial), null)
  const full = {
    projects: {
      branches: async () => ({}),
      gitFetch: async () => ({}),
      gitPull: async () => ({}),
      checkoutBranch: async () => ({})
    }
  } as unknown as Partial<OrcaApi>
  const api = projectGitApi(full)
  assert.ok(api)
  assert.equal(typeof api.checkoutBranch, 'function')
})

test('gitOutputText — пустой вывод это «Готово», длинный — хвост с многоточием', () => {
  assert.equal(gitOutputText(''), 'Готово')
  assert.equal(gitOutputText('  \n'), 'Готово')
  assert.equal(gitOutputText('Already up to date.\n'), 'Already up to date.')
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const out = gitOutputText(long, 5).split('\n')
  assert.deepEqual(out, ['…', 'line 25', 'line 26', 'line 27', 'line 28', 'line 29'])
})
