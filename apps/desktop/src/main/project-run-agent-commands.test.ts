import assert from 'node:assert/strict'
import type { AgentInfo } from '@orca-board/core'
import { afterEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentCommands, createAgentDiscovery, createAgentSelection, createGitOperations, createLaunchPolicy,
  createProjectGitCommands, createRunCommands, createWorkerPreflight } from '@orca-board/runtime'
import { ProjectManager } from './projects'
import { OrcaError, ipcError, mt, setMainLocale, type MKey, type MParams } from './i18n'
import * as adapter from './project-run-agent-commands'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); setMainLocale('ru') })
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
const channels = ['projects:branch', 'projects:branches', 'projects:gitFetch', 'projects:gitPull', 'projects:checkoutBranch',
  'projects:createInitialCommit', 'runs:list', 'runs:close', 'agents:list']
type Event = { client: string | null }
function fixture() {
  assert.equal(typeof adapter.registerDesktopProjectRunAgentCommands, 'function')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-desktop-project-api-'))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const manager = new ProjectManager(join(dir, 'profile'))
  const repo = (name: string) => {
    const root = join(dir, name); git(dir, 'init', '-q', '-b', 'main', root)
    git(root, 'config', 'user.name', 'test'); git(root, 'config', 'user.email', 'test@local')
    git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'config', 'core.hooksPath', join(dir, 'no-hooks')); return root
  }
  const a = manager.add(repo('A')); const b = manager.add(repo('B')); manager.setActive(a.id)
  let lookups = 0; let selections = 0; let selected: string | undefined = a.id
  const project = (id: string) => { lookups++; return manager.get(id) }
  const authorize = (ctx: { clientId: string }) => ctx.clientId === 'desktop:1'
  const ops = createGitOperations({ error: (key, params) => new OrcaError(key, params), untrackedLabel: () => mt('review.untracked') })
  const projects = createProjectGitCommands({ project, authorize, git: ops, isCurrent: p => manager.get(p.id) === p, liveAgents: () => 0 })
  const runs = createRunCommands({ project: id => { const p = project(id); return p ? { store: manager.store(id) } : undefined }, authorize })
  const bin = join(dir, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'codex.cmd'), '', { mode: 0o700 })
  const discovery = createAgentDiscovery({ home: dir, platform: 'win32', env: { Path: bin, Pathext: '.CMD' }, executeVersion: () => 'test-version' })
  const messages = { error: (key: MKey, params?: MParams) => new OrcaError(key, params) }
  const preflight = createWorkerPreflight({ messages, selection: createAgentSelection(messages), launchPolicy: createLaunchPolicy(messages) })
  const agents = createAgentCommands({ project, authorize, discovery, preflight, resolveRun: (id, runId) => manager.resolveRun(id, runId), store: id => manager.store(id) })
  const handlers = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopProjectRunAgentCommands<Event>((channel, fn) => handlers.set(channel, fn as (event: Event, ...args: unknown[]) => unknown), {
    projects, runs, agents, activeProjectId: () => { selections++; return selected }, clientId: event => event.client
  })
  assert.deepEqual([...handlers.keys()].sort(), [...channels].sort())
  return { dir, a, b, manager, ops, select: (id?: string) => { selected = id }, lookups: () => lookups, selections: () => selections,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string) => handlers.get(channel)!({ client: null }) }
}
test('nine verified callers precede project lookup/selection/Git side effects', async () => {
  const f = fixture()
  for (const channel of channels) await assert.rejects(async () => f.foreign(channel), error => error instanceof OrcaError && error.key === 'command.forbidden')
  assert.equal(f.lookups(), 0); assert.equal(f.selections(), 0); assert.equal(f.ops.hasCommits(f.a.root), false)
})
test('unknown project badge remains non-repo; no-project runs and global agents preserved', async () => {
  const f = fixture(); f.select()
  assert.deepEqual(await f.call('projects:branch', 'unknown'), { isGitRepo: false, branch: null, detached: false })
  assert.deepEqual(await f.call('runs:list'), [])
  const agents = await f.call('agents:list') as AgentInfo[]
  assert.equal(agents.find(a => a.id === 'codex')?.enabled, true)
  await assert.rejects(async () => f.call('runs:close', 'missing'), error => error instanceof OrcaError && error.key === 'projects.none')
})
test('explicit Git B and legacy invalid init mode empty preserve staged files', async () => {
  const f = fixture(); f.select(f.a.id); writeFileSync(join(f.b.root, 'keep.txt'), 'staged'); git(f.b.root, 'add', 'keep.txt')
  const before = git(f.b.root, 'ls-files', '--stage')
  await f.call('projects:createInitialCommit', f.b.id, 'unknown')
  assert.equal(git(f.b.root, 'ls-tree', 'HEAD'), ''); assert.equal(git(f.b.root, 'ls-files', '--stage'), before)
  assert.equal(f.ops.hasCommits(f.a.root), false); assert.equal(f.selections(), 0)
  assert.equal(readFileSync(join(f.b.root, 'keep.txt'), 'utf8'), 'staged')
  const branch = await f.call('projects:branch', f.b.id) as { branch: string }; assert.equal(branch.branch, 'main')
})
test('runs/agents legacy active selection uses common detached data', async () => {
  const f = fixture(); const a = f.manager.store(f.a.id).createRun('A'); const b = f.manager.store(f.b.id).createRun('B')
  assert.deepEqual((await f.call('runs:list') as { id: string }[]).map(r => r.id), [a.id])
  f.select(f.b.id); assert.deepEqual((await f.call('runs:list') as { id: string }[]).map(r => r.id), [b.id])
  await f.call('runs:close', b.id); assert.equal(f.manager.store(f.a.id).getRun(a.id)?.closedAt, undefined)
  f.manager.setEnabledAgents(f.b.id, []); const agents = await f.call('agents:list', 'refresh') as { id: string; enabled: boolean }[]
  assert.equal(agents.find(a => a.id === 'codex')?.enabled, false); assert.equal(f.manager.active()?.id, f.a.id)
})
test('Git Promise rejection keeps ru/en domain IPC code', async () => {
  const f = fixture(); await f.call('projects:createInitialCommit', f.a.id, 'empty')
  for (const locale of ['ru', 'en'] as const) {
    setMainLocale(locale)
    await assert.rejects(async () => f.call('projects:gitPull', f.a.id), error => {
      assert.ok(error instanceof OrcaError); assert.equal(error.key, 'git.noUpstream')
      const translated = ipcError(error); assert.ok(translated instanceof Error)
      assert.match(translated.message, locale === 'ru' ? /upstream|удалён/ : /upstream/); return true
    })
  }
})
test('queued stale Desktop initial commit does not write a removed repository', async () => {
  const f = fixture(); const pending = f.call('projects:createInitialCommit', f.a.id, 'snapshot') as Promise<unknown>
  f.manager.remove(f.a.id)
  await assert.rejects(pending, error => error instanceof OrcaError && error.key === 'command.stale')
  assert.equal(f.ops.hasCommits(f.a.root), false)
})
