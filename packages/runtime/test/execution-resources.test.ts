import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, validateAttachments } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { resources, HostError } from './execution-test-host.ts'

let dir: string
let repo: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const store = () => new TaskStore(undefined, () => DEFAULT_COLUMNS)
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-execution-')))
  repo = join(dir, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'master')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('параллельные прогоны получают разные ветки и не переключают корень', async () => {
  const services = resources(); const board = store()
  const a = board.createGlobalTask({ title: 'First' }); const b = board.createGlobalTask({ title: 'Second' })
  const ga = (await services.ensureRunBranch(board, repo, a.id))!
  const gb = (await services.ensureRunBranch(board, repo, b.id))!
  assert.equal(ga.branch, `feature/${a.id}-first`)
  assert.equal(gb.branch, `feature/${b.id}-second`)
  assert.equal(git(repo, 'branch', '--show-current'), 'master')
  writeFileSync(join(ga.worktree!, 'first.txt'), 'first')
  assert.equal(existsSync(join(gb.worktree!, 'first.txt')), false)
  assert.deepEqual(await services.mergeTarget(board, repo, { runId: a.id }), { cwd: ga.worktree, branch: ga.branch })
  assert.throws(() => git(ga.worktree!, 'rev-parse', '--abbrev-ref', '@{u}'))
})

it('исчезнувший worktree восстанавливается на прежней ветке с сохранённым коммитом', async () => {
  const services = resources(); const board = store()
  const run = board.createGlobalTask({ title: 'Restore' })
  const first = (await services.ensureRunBranch(board, repo, run.id))!
  writeFileSync(join(first.worktree!, 'result.md'), 'result')
  git(first.worktree!, 'add', 'result.md'); git(first.worktree!, 'commit', '-qm', 'result')
  rmSync(first.worktree!, { recursive: true, force: true })
  const restored = (await services.ensureRunBranch(board, repo, run.id))!
  assert.equal(restored.branch, first.branch)
  assert.equal(readFileSync(join(restored.worktree!, 'result.md'), 'utf8'), 'result')
})

it('старый прогон с dispatch без своей ветки продолжает работать в корне', async () => {
  const services = resources(); const board = store()
  const run = board.createGlobalTask({ title: 'Legacy' })
  const task = board.createTask({ title: 'Started', runId: run.id, roleId: 'developer' })
  board.startDispatch(task.id, 'pty_old')
  assert.equal(await services.ensureRunBranch(board, repo, run.id), undefined)
  assert.deepEqual(await services.mergeTarget(board, repo, task), { cwd: repo, branch: 'master' })
})

it('негодные флаги роли возвращают вложенные codes ошибки хоста', () => {
  const services = resources()
  assert.throws(() => services.roleLaunchExtraArgs({ id: 'developer', extraArgs: '--name "unfinished' }, 'worker.cannotStart'), e =>
    e instanceof HostError && e.key === 'worker.cannotStart' && e.params?.reason !== undefined &&
    JSON.stringify(e.params.reason).includes('extraArgs.quote'))
  assert.deepEqual(services.roleLaunchExtraArgs({ id: 'developer', extraArgs: '--name "two words"' }, 'worker.cannotStart'), ['--name', 'two words'])
  assert.throws(() => services.assistantLaunch({ agent: 'claude', extraArgs: 'claude --verbose' }, 'builtin', 'en'), e =>
    e instanceof HostError && e.key === 'assistant.extraArgsInvalid')
  assert.equal(runtime.missingRoleText('developer', { title: 'Custom', roles: [] }).params?.type, 'Custom')
  assert.equal(DEFAULT_ROLES.some(role => role.id === 'developer'), true)
})

it('возврат сначала проверяет store, затем останавливает старого координатора', () => {
  const services = resources(); const board = store()
  const run = board.createGlobalTask({ title: 'Review' })
  board.setRunPty(run.id, 'pty_old'); board.moveGlobalTask(run.id, 'review')
  let stopped = false
  assert.throws(() => services.returnGlobalTaskToWork(board, run.id, ' ', () => true, () => { stopped = true }))
  assert.equal(stopped, false)
  assert.equal(board.getRun(run.id)?.status, 'review')
  services.returnGlobalTaskToWork(board, run.id, 'fix this', () => !stopped, id => { assert.equal(id, 'pty_old'); stopped = true })
  assert.equal(stopped, true)
  assert.match(services.resumeObjective(board, run.id, () => false).objective, /fix this/)
})

it('частичная запись вложений откатывает только созданные файлы', () => {
  const services = resources()
  const root = services.attachmentsRoot(repo)
  const runDir = join(root, 'run_test'); mkdirSync(runDir)
  writeFileSync(join(runDir, 'file-2-second.txt'), 'existing')
  const valid = validateAttachments([{ name: 'first.txt', data: new TextEncoder().encode('first') }, { name: 'second.txt', data: new TextEncoder().encode('second') }])
  assert.throws(() => services.writeAttachments(root, 'run_test', valid), e => e instanceof HostError && e.key === 'attachments.saveFailed')
  assert.equal(existsSync(join(runDir, 'file-1-first.txt')), false)
  assert.equal(readFileSync(join(runDir, 'file-2-second.txt'), 'utf8'), 'existing')
})

it('отказ после сохранённого возврата не удаляет файлы, на которые ссылается store', async () => {
  const services = resources(); const board = store()
  const run = board.createGlobalTask({ title: 'Return' }); board.moveGlobalTask(run.id, 'review')
  let saved: string[] = []
  await assert.rejects(async () => await services.returnRunWithImages(board, repo, run.id, [{ name: 'fix.txt', data: new TextEncoder().encode('fix') }], 'fix', paths => {
    saved = paths; board.returnGlobalTask(run.id, 'fix', paths); throw new Error('spawn failed')
  }), /spawn failed/)
  assert.equal(saved.length, 1)
  assert.equal(readFileSync(saved[0], 'utf8'), 'fix')
  assert.deepEqual(board.getRun(run.id)?.returns?.at(-1)?.images, saved)
})
