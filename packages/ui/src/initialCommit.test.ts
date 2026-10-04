// Окно начального коммита: код git.noCommits, старый preload, подсказки по файлам корня и режим по умолчанию.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaApi, ProjectBranchList, ProjectFilesListing } from '../shared/ipc'
import { setLocale } from './i18n'
import {
  defaultInitialCommitMode,
  initialCommitApi,
  initialCommitErrorMessage,
  isNoCommitsError,
  loadInitialCommitInfo,
  retryHint,
  staleInitialCommitMessage,
  warnNoGitignore,
  type InitialCommitApi
} from './initialCommit'

afterEach(() => setLocale('ru'))

function orcaError(channel: string, code: string, text: string): Error {
  return new Error(`Error invoking remote method '${channel}': OrcaError[${code}]: ${text}`)
}

const UNBORN: ProjectBranchList = {
  isGitRepo: true,
  current: { isGitRepo: true, branch: 'main', detached: false, unborn: true },
  local: [],
  remote: [],
  dirty: true
}

function listing(names: string[], truncated = false): ProjectFilesListing {
  return { dir: '', entries: names.map((name) => ({ name, kind: 'file' as const })), truncated }
}

function fakeApi(opts: { list?: ProjectBranchList | Error; files?: ProjectFilesListing | Error } = {}): InitialCommitApi {
  const answer = async <T>(v: T | Error | undefined): Promise<T> => (v instanceof Error ? (await Promise.reject(v)) : (await Promise.resolve(v as T)))
  return {
    createInitialCommit: async () => UNBORN.current,
    branches: 'list' in opts ? async () => (await answer(opts.list)) : undefined,
    listFiles: 'files' in opts ? async () => (await answer(opts.files)) : undefined
  }
}

test('isNoCommitsError — по коду OrcaError, не по тексту', () => {
  assert.equal(isNoCommitsError(orcaError('worker:start', 'git.noCommits', 'No commits in the repository')), true)
  assert.equal(isNoCommitsError(orcaError('coordinator:start', 'git.notRepo', 'нет коммитов')), false)
  assert.equal(isNoCommitsError(new Error("fatal: ambiguous argument 'HEAD': unknown revision")), false)
  assert.equal(isNoCommitsError('git.noCommits'), false)
})

test('initialCommitApi — старый preload без createInitialCommit: null, вызывающий показывает «перезапустите»', () => {
  assert.equal(initialCommitApi(undefined), null)
  assert.equal(initialCommitApi({} as Partial<OrcaApi>), null)
  assert.equal(initialCommitApi({ projects: { branches: async () => UNBORN } } as unknown as Partial<OrcaApi>), null)
  assert.match(staleInitialCommitMessage(), /Перезапустите приложение/)
})

test('initialCommitApi — новый preload: методы привязаны к своим объектам, files необязателен', async () => {
  const projects = {
    tag: 'p',
    async createInitialCommit(this: { tag: string }, id: string, mode: string) {
      return { isGitRepo: true, branch: `${this.tag}:${id}:${mode}`, detached: false }
    }
  }
  const api = initialCommitApi({ projects } as unknown as Partial<OrcaApi>)
  assert.ok(api)
  assert.equal(api.branches, undefined)
  assert.equal(api.listFiles, undefined)
  assert.equal((await api.createInitialCommit('x', 'empty')).branch, 'p:x:empty')
})

test('initialCommitErrorMessage — старый main и прочие отказы', () => {
  const stale = new Error("Error invoking remote method 'projects:createInitialCommit': Error: No handler registered for 'projects:createInitialCommit'")
  assert.equal(initialCommitErrorMessage(stale), staleInitialCommitMessage())
  assert.equal(initialCommitErrorMessage(orcaError('projects:createInitialCommit', 'git.opFailed', 'git commit: author identity unknown')), 'git commit: author identity unknown')
  assert.equal(initialCommitErrorMessage(new Error('')), 'Не удалось создать коммит.')
  setLocale('en')
  assert.equal(initialCommitErrorMessage(new Error('')), 'Couldn’t create the commit.')
})

test('loadInitialCommitInfo — ветка, файлы и .gitignore из существующих каналов', async () => {
  assert.deepEqual(await loadInitialCommitInfo(fakeApi({ list: UNBORN, files: listing(['.gitignore', 'a.ts']) }), 'p'), {
    branch: 'main',
    dirty: true,
    gitignore: true
  })
  assert.deepEqual(await loadInitialCommitInfo(fakeApi({ list: { ...UNBORN, dirty: false }, files: listing([]) }), 'p'), {
    branch: 'main',
    dirty: false,
    gitignore: false
  })
})

test('loadInitialCommitInfo — отказ или нет метода: неизвестно, а не ошибка', async () => {
  assert.deepEqual(await loadInitialCommitInfo(fakeApi(), 'p'), { branch: null, dirty: null, gitignore: null })
  assert.deepEqual(
    await loadInitialCommitInfo(fakeApi({ list: new Error('boom'), files: new Error('files.rootMissing') }), 'p'),
    { branch: null, dirty: null, gitignore: null }
  )
  // Папка обрезана до лимита: .gitignore мог не попасть в первые записи.
  assert.equal((await loadInitialCommitInfo(fakeApi({ files: listing(['a.ts'], true) }), 'p')).gitignore, null)
  assert.equal((await loadInitialCommitInfo(fakeApi({ files: listing(['.gitignore'], true) }), 'p')).gitignore, true)
  // Папка с именем .gitignore — не файл правил.
  const dir: ProjectFilesListing = { dir: '', entries: [{ name: '.gitignore', kind: 'dir' }], truncated: false }
  assert.equal((await loadInitialCommitInfo(fakeApi({ files: dir }), 'p')).gitignore, false)
})

test('defaultInitialCommitMode — есть файлы или неизвестно: snapshot; пусто: empty', () => {
  assert.equal(defaultInitialCommitMode({ dirty: true }), 'snapshot')
  assert.equal(defaultInitialCommitMode({ dirty: null }), 'snapshot')
  assert.equal(defaultInitialCommitMode({ dirty: false }), 'empty')
})

test('retryHint — обещаем повтор запуска только когда есть что повторять (из меню веток — нет)', () => {
  assert.equal(retryHint(true), 'После коммита запуск повторится автоматически.')
  assert.equal(retryHint(false), null)
  setLocale('en')
  assert.equal(retryHint(true), 'The launch will be retried automatically after the commit.')
  assert.equal(retryHint(false), null)
})

test('warnNoGitignore — только когда .gitignore точно нет, а файлы есть или неизвестно', () => {
  assert.equal(warnNoGitignore({ dirty: true, gitignore: false }), true)
  assert.equal(warnNoGitignore({ dirty: null, gitignore: false }), true)
  assert.equal(warnNoGitignore({ dirty: false, gitignore: false }), false)
  assert.equal(warnNoGitignore({ dirty: true, gitignore: true }), false)
  assert.equal(warnNoGitignore({ dirty: true, gitignore: null }), false)
})
