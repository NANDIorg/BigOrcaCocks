import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git, deferred } from './git-queue-fixture.ts'
import { profileFixture, operator } from './profile-command-test-host.ts'
import { until } from './conversation-fixture.ts'

async function fixture(t: TestContext) {
  const service = runtime.createGitProcessService(); t.after(() => service.stop())
  const f = gitQueueFixture(t); const profile = (await profileFixture()); t.after(profile.close)
  const project = (await profile.manager.add(f.unborn)); const other = (await profile.manager.add(f.other))
  let hold: ((cwd: string, args: readonly string[]) => Promise<void>) | undefined
  const calls: Array<{ cwd: string; args: readonly string[] }> = []
  const processes: runtime.GitProcessService = { stop: service.stop, run: async (cwd, args, opts) => {
    calls.push({ cwd, args: [...args] }); const result = await service.run(cwd, args, opts)
    if (hold) await hold(cwd, args)
    return result
  } }
  const ops = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, processes)
  assert.equal(typeof ops.projectBranchInfoAsync, 'function', 'Отсутствует async проверка HEAD')
  assert.equal(typeof ops.hasCommitsAsync, 'function', 'Отсутствует async проверка коммитов')
  let allowed = true; let lookups = 0
  const commands = runtime.createProjectGitCommands({ git: ops, authorize: context => allowed && context.actor.kind === 'operator' && context.actor.id === 'person',
    project: id => { lookups++; return profile.manager.get(id) }, isCurrent: p => profile.manager.get(p.id) === p, liveAgents: () => 0 })
  const context = { ...operator, projectId: project.id }
  const pause = () => {
    const release = deferred(); let held = false
    hold = async (cwd, args) => { if (!held && cwd === f.unborn && args[0] === 'symbolic-ref') {
      held = true; await release.promise
    } }
    t.after(release.resolve)
    return { entered: until(() => held), release: release.resolve }
  }
  return { ...f, ops, commands, context, project, other, profile, calls, pause, selected: profile.manager.active()?.id,
    deny: () => { allowed = false }, lookups: () => lookups }
}
const code = (value: string) => (e: unknown) => e instanceof runtime.CommandError && e.code === value

test('async branch and commit checks preserve actual unborn/branch/detached/missing repo DTO', async t => {
  const f = (await fixture(t))
  assert.equal(await f.ops.hasCommitsAsync(f.unborn), false); assert.equal(await f.ops.hasCommitsAsync(f.root), true)
  assert.deepEqual(await f.ops.projectBranchInfoAsync(f.unborn), { isGitRepo: true, branch: 'main', detached: false, unborn: true })
  assert.deepEqual(await f.ops.projectBranchInfoAsync(f.root), { isGitRepo: true, branch: 'main', detached: false })
  git(f.root, 'checkout', '-q', '--detach')
  const sha = git(f.root, 'rev-parse', '--short', 'HEAD')
  assert.deepEqual(await f.ops.projectBranchInfoAsync(f.root), { isGitRepo: true, branch: null, detached: true, sha })
  const plain = join(f.dir, 'plain'); mkdirSync(plain)
  for (const root of [plain, join(f.dir, 'missing')]) {
    assert.deepEqual(await f.ops.projectBranchInfoAsync(root), { isGitRepo: false, branch: null, detached: false })
    await assert.rejects(f.ops.hasCommitsAsync(root))
  }
})
test('branch command awaits real async process port while heartbeat and another project proceed', async t => {
  const f = (await fixture(t)); const gate = f.pause(); const pending = f.commands.branch(f.context)
  try {
    await gate.entered
    const beat = await new Promise<string>(resolve => setTimeout(() => resolve('alive'), 10)); assert.equal(beat, 'alive')
    assert.equal((await f.commands.branch({ ...operator, clientId: 'two', projectId: f.other.id })).unborn, undefined)
    assert.equal(f.profile.manager.loadedStores().length, 0)
  } finally { gate.release() }
  assert.equal((await pending).unborn, true); assert.equal(f.profile.manager.active()?.id, f.selected)
})
test('forged principal and malformed payload cannot reach async Git process or project lookup', async t => {
  const f = (await fixture(t))
  await assert.rejects(f.commands.branch({ ...f.context, actor: { kind: 'operator', id: 'forged' } }), code('command.forbidden'))
  await assert.rejects(f.commands.checkout(f.context, ''), code('command.invalidInput'))
  await assert.rejects(f.commands.initialCommit(f.context, 'bad' as 'empty'), code('command.invalidInput'))
  assert.equal(f.calls.length, 0); assert.equal(f.lookups(), 0); assert.equal(git(f.unborn, 'ls-files', '--stage'), '')
})
test('revoked principal during async repo check prevents subsequent initial commit mutation', async t => {
  const f = (await fixture(t)); const gate = f.pause(); const pending = f.commands.initialCommit(f.context, 'empty')
  const failed = assert.rejects(pending, code('command.forbidden'))
  try { await gate.entered; f.deny() } finally { gate.release() }
  await failed; assert.throws(() => git(f.unborn, 'rev-parse', '--verify', 'HEAD'))
  assert.equal(git(f.unborn, 'ls-files', '--stage'), '')
  assert.equal(f.calls.some(call => ['hash-object', 'commit-tree', 'update-ref', 'add', 'commit'].includes(call.args[0])), false)
})
test('removed project during awaited branch result is stale and does not affect other repo', async t => {
  const f = (await fixture(t)); const gate = f.pause(); const pending = f.commands.branch(f.context)
  const failed = assert.rejects(pending, code('command.stale')); const otherHead = git(f.other.root, 'rev-parse', 'HEAD')
  try { await gate.entered; f.profile.manager.remove(f.project.id) } finally { gate.release() }
  await failed; assert.equal(git(f.other.root, 'rev-parse', 'HEAD'), otherHead)
})
test('project initial commit/branch listing/checkout use async checks and preserve actual files/HEAD', async t => {
  const f = (await fixture(t)); writeFileSync(join(f.unborn, 'saved.txt'), 'snapshot')
  const created = await f.commands.initialCommit(f.context, 'snapshot'); assert.equal(created.unborn, undefined)
  assert.equal(git(f.unborn, 'show', 'HEAD:saved.txt'), 'snapshot'); git(f.unborn, 'branch', 'next')
  f.calls.length = 0
  const branches = await f.commands.branches(f.context); assert.deepEqual(branches.local.map(branch => branch.name), ['main', 'next'])
  assert.ok(f.calls.some(call => call.args[0] === 'symbolic-ref'), 'branch listing должен использовать общий async process port')
  f.calls.length = 0
  await f.commands.checkout(f.context, 'next'); assert.equal(git(f.unborn, 'branch', '--show-current'), 'next')
  assert.ok(f.calls.filter(call => call.args[0] === 'symbolic-ref').length >= 2, 'проверки до и после checkout проходят async port')
  assert.equal(readFileSync(join(f.unborn, 'saved.txt'), 'utf8'), 'snapshot'); assert.equal(git(f.other.root, 'branch', '--show-current'), 'main')
})
