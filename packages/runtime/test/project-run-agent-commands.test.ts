import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import { profileFixture, operator } from './profile-command-test-host.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
class HostError extends Error { readonly key: string; constructor(key: string) { super(key); this.key = key } }
const domain = (key: string) => (error: unknown) => error instanceof runtime.CommandError && error.cause instanceof HostError && error.cause.key === key
const code = (key: string) => (error: unknown) => error instanceof runtime.CommandError && error.code === key
async function fixture() {
  assert.equal(typeof runtime.createProjectGitCommands, 'function')
  assert.equal(typeof runtime.createRunCommands, 'function')
  assert.equal(typeof runtime.createAgentCommands, 'function')
  const f = (await profileFixture()); cleanup.push(f.close)
  for (const p of [f.a, f.b]) {
    git(p.root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(p.root, 'config', 'user.name', 'test'); git(p.root, 'config', 'user.email', 'test@local')
    git(p.root, 'config', 'commit.gpgsign', 'false'); git(p.root, 'config', 'core.hooksPath', join(f.dir, 'no-hooks'))
  }
  let lookups = 0; let allow = true; let live = 0; let changeLive = false
  const authorize = (ctx: typeof operator) => allow && ctx.actor.kind === 'operator'
  const operations = runtime.createGitOperations({ error: key => new HostError(key), untrackedLabel: () => 'untracked' })
  const project = (id: string) => { lookups++; return f.manager.get(id) }
  const gitCommands = runtime.createProjectGitCommands({ project, authorize, git: operations,
    isCurrent: p => f.manager.get(p.id) === p && f.manager.get(p.id)?.root === p.root,
    liveAgents: () => { const value = live; if (changeLive) { changeLive = false; queueMicrotask(() => { live = 1 }) }; return value } })
  const runs = runtime.createRunCommands({ project: id => { const p = project(id); return p ? { store: f.manager.store(id) } : undefined }, authorize })
  const bin = join(f.dir, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'codex.cmd'), '', { mode: 0o700 })
  const discovery = runtime.createAgentDiscovery({ home: f.dir, platform: 'win32', env: { Path: bin, Pathext: '.CMD' }, executeVersion: () => 'codex-test' })
  const messages = { error: (key: string) => new HostError(key) }
  const preflight = runtime.createWorkerPreflight({ messages, selection: runtime.createAgentSelection(messages), launchPolicy: runtime.createLaunchPolicy(messages) })
  const agents = runtime.createAgentCommands({ project, authorize, discovery, preflight,
    resolveRun: (id, runId) => f.manager.resolveRun(id, runId), store: id => f.manager.store(id) })
  return { ...f, project, operations, gitCommands, runs, agents, context: (id: string) => ({ ...operator, projectId: id }),
    lookups: () => lookups, deny: () => { allow = false }, setLive: (n: number) => { live = n }, changeLive: () => { changeLive = true } }
}

test('application guards reject forged context and payload before lookup/effect', async () => {
  const f = (await fixture()); const ctx = f.context(f.a.id)
  await assert.rejects(f.gitCommands.branch({ ...ctx, actor: { kind: 'agent', id: 'forged' } }), code('command.forbidden'))
  await assert.rejects(f.gitCommands.checkout(ctx, ''), code('command.invalidInput'))
  await assert.rejects(f.gitCommands.initialCommit(ctx, 'invalid' as 'empty'), code('command.invalidInput'))
  assert.throws(() => f.runs.close(ctx, ''), code('command.invalidInput'))
  assert.throws(() => f.agents.list(operator, false as unknown as string), code('command.invalidInput'))
  assert.throws(() => f.agents.list(operator, undefined, 'yes' as unknown as boolean), code('command.invalidInput'))
  assert.throws(() => f.agents.preflight(ctx, ''), code('command.invalidInput'))
  assert.equal(f.lookups(), 0); assert.equal(f.manager.loadedStores().length, 0)
})
test('read-only Git does not open boards; explicit A/B, detached DTO and selection', async () => {
  const f = (await fixture()); const a = f.context(f.a.id); const b = { ...f.context(f.b.id), clientId: 'two' }
  assert.equal((await f.gitCommands.branch(a)).unborn, true)
  assert.equal((await f.gitCommands.branch(b)).branch, 'main')
  const branches = await f.gitCommands.branches(a); assert.deepEqual(branches.local, [])
  branches.current.branch = 'changed'
  assert.equal((await f.gitCommands.branch(a)).branch, 'main')
  assert.equal(f.manager.active()?.id, f.a.id); assert.equal(f.manager.loadedStores().length, 0)
  await assert.rejects(f.gitCommands.branch(f.context('missing')), code('command.projectNotFound'))
})
test('empty init preserves actual staged/index and files; snapshot explicit; checkout real HEAD', async () => {
  const f = (await fixture()); writeFileSync(join(f.a.root, 'staged.txt'), 'keep'); git(f.a.root, 'add', 'staged.txt')
  const index = git(f.a.root, 'ls-files', '--stage')
  await f.gitCommands.initialCommit(f.context(f.a.id), 'empty')
  assert.equal(git(f.a.root, 'ls-files', '--stage'), index); assert.equal(git(f.a.root, 'ls-tree', 'HEAD'), '')
  const head = git(f.a.root, 'rev-parse', 'HEAD')
  await f.gitCommands.initialCommit(f.context(f.a.id), 'snapshot'); assert.equal(git(f.a.root, 'rev-parse', 'HEAD'), head)
  writeFileSync(join(f.b.root, 'snapshot.txt'), 'stored')
  await f.gitCommands.initialCommit(f.context(f.b.id), 'snapshot')
  assert.equal(git(f.b.root, 'show', 'HEAD:snapshot.txt'), 'stored')
  git(f.b.root, 'branch', 'next'); await f.gitCommands.checkout(f.context(f.b.id), 'next')
  assert.equal(git(f.b.root, 'branch', '--show-current'), 'next')
})
test('local bare fetch/pull goes through common API with real refs and bounded result', async () => {
  const f = (await fixture()); await f.gitCommands.initialCommit(f.context(f.a.id), 'empty')
  const remote = join(f.dir, 'remote.git'); git(f.dir, 'init', '--bare', '-q', remote)
  git(f.a.root, 'remote', 'add', 'origin', remote); git(f.a.root, 'push', '-qu', 'origin', 'main')
  git(f.b.root, 'remote', 'add', 'origin', remote)
  const fetched = await f.gitCommands.fetch(f.context(f.b.id)); assert.ok(fetched.output.length <= 4001)
  await f.gitCommands.checkout(f.context(f.b.id), 'origin/main')
  writeFileSync(join(f.a.root, 'new.txt'), 'new'); git(f.a.root, 'add', '.'); git(f.a.root, 'commit', '-qm', 'new'); git(f.a.root, 'push', '-q')
  await f.gitCommands.pull(f.context(f.b.id)); assert.equal(readFileSync(join(f.b.root, 'new.txt'), 'utf8'), 'new')
})
test('queued mutation removed/readded project is stale before any real commit', async () => {
  const f = (await fixture()); const pending = f.gitCommands.initialCommit(f.context(f.a.id), 'empty')
  const rejected = assert.rejects(pending, code('command.stale'))
  f.manager.remove(f.a.id); await f.manager.add(f.a.root, undefined, false)
  await rejected; assert.equal(await f.operations.hasCommits(f.a.root), false)
})
test('queued mutation revoked principal cannot start real commit', async () => {
  const f = (await fixture()); const pending = f.gitCommands.initialCommit(f.context(f.a.id), 'empty'); f.deny()
  await assert.rejects(pending, code('command.forbidden')); assert.equal(await f.operations.hasCommits(f.a.root), false)
})
test('live worker appears after refs await: final checkout rechecks count and HEAD stays', async () => {
  const f = (await fixture()); await f.gitCommands.initialCommit(f.context(f.a.id), 'empty'); git(f.a.root, 'branch', 'next')
  f.changeLive()
  await assert.rejects(f.gitCommands.checkout(f.context(f.a.id), 'next'), domain('git.workersActive'))
  assert.equal(git(f.a.root, 'branch', '--show-current'), 'main')
})
test('runs explicit clients, detached summary/counts, close idempotent with human status attribution', async () => {
  const f = (await fixture()); const store = f.manager.store(f.a.id)
  const run = store.createGlobalTask({ title: 'run' }); store.moveGlobalTask(run.id, 'in_progress')
  store.createTask({ title: 'one', runId: run.id }); const done = store.createTask({ title: 'two', runId: run.id }); store.moveTask(done.id, 'done')
  const b = f.manager.store(f.b.id).createRun('B')
  const summary = f.runs.listWithCounts(f.context(f.a.id)).find(r => r.id === run.id)!
  assert.equal(summary.tasks, 2); assert.equal(summary.done, 1); summary.objective = 'mutated'
  assert.notEqual(store.getRun(run.id)?.objective, 'mutated')
  assert.deepEqual(f.runs.list(f.context(f.b.id)).map(r => r.id), [b.id])
  const closed = f.runs.close(f.context(f.a.id), run.id)
  assert.equal(closed.status, 'done'); assert.equal(closed.statusHistory?.at(-1)?.by, 'human')
  assert.equal(f.runs.close(f.context(f.a.id), run.id).closedAt, closed.closedAt)
  assert.equal(f.manager.active()?.id, f.a.id)
})
test('agents enabled by explicit project; global list detached and refresh reads real config', async () => {
  const f = (await fixture()); f.manager.setEnabledAgents(f.a.id, []); f.manager.setEnabledAgents(f.b.id, ['codex'])
  assert.equal(f.agents.list(operator, f.a.id).find(a => a.id === 'codex')?.enabled, false)
  const b = f.agents.list({ ...operator, clientId: 'two' }, f.b.id); assert.equal(b.find(a => a.id === 'codex')?.enabled, true)
  b.find(a => a.id === 'codex')!.defaults.model = 'mutated'
  assert.equal(f.agents.list(operator).find(a => a.id === 'codex')?.defaults.model, undefined)
  const cfg = join(f.dir, '.codex'); mkdirSync(cfg); writeFileSync(join(cfg, 'config.toml'), 'model = "new-model"')
  assert.equal(f.agents.list(operator, f.b.id, true).find(a => a.id === 'codex')?.defaults.model, 'new-model')
  assert.equal(f.manager.active()?.id, f.a.id)
  assert.throws(() => f.agents.list(operator, 'missing'), code('command.projectNotFound'))
})
test('preflight validates real role agent/flags and explicit run before any launch/store write', async () => {
  const f = (await fixture()); const typeId = f.manager.projectDefaultTypeId(f.b.id)
  const role = { id: 'developer', title: 'dev', agent: 'codex' as const, extraArgs: '--sandbox workspace-write' }
  f.manager.patchTaskType(typeId, { roles: [role] })
  const result = f.agents.preflight(f.context(f.b.id), 'developer'); assert.equal(result.agent, 'codex')
  result.title = 'mutated'; assert.equal(f.manager.resolveRun(f.b.id).roles[0].title, 'dev')
  assert.throws(() => f.agents.preflight(f.context(f.b.id), 'developer', 'foreign-run'), code('command.globalTaskNotFound'))
  f.manager.setEnabledAgents(f.b.id, [])
  assert.throws(() => f.agents.preflight(f.context(f.b.id), 'developer'), domain('agent.disabled'))
  f.manager.setEnabledAgents(f.b.id, ['codex'])
  const legacy = f.manager.store(f.b.id).createRun('legacy', undefined, { typeId: 'deleted',
    snapshot: { id: 'deleted', title: 'Legacy', roles: [{ ...role, extraArgs: 'unsafe positional' }] } })
  assert.throws(() => f.agents.preflight(f.context(f.b.id), 'developer', legacy.id), domain('worker.cannotStart'))
})

test('queued root replacement is stale and does not commit either repository', async () => {
  const f = (await fixture()); const root = f.a.root
  const pending = f.gitCommands.initialCommit(f.context(f.a.id), 'empty'); f.a.root = f.b.root
  await assert.rejects(pending, code('command.stale'))
  assert.equal(await f.operations.hasCommits(root), false); assert.equal(await f.operations.hasCommits(f.b.root), false)
})
