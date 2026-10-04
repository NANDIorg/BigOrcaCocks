import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import type { GitProcessService } from '../src/git-process.ts'
import { gitQueueFixture, deferred } from './git-queue-fixture.ts'
import { operator, ProfileHostError } from './profile-command-test-host.ts'
import type { ProjectMessageKey } from '../src/project-messages.ts'

const messages = { Error: ProfileHostError, text: (key: ProjectMessageKey) => key }
function heldRead(t: { after(fn: () => Promise<void>): void }, match: string) {
  const real = runtime.createGitProcessService(); t.after(() => real.stop())
  const entered = deferred(); const release = deferred(); let held = true
  const processes: GitProcessService = { stop: real.stop, async run(cwd, args, options) {
    const result = await real.run(cwd, args, options)
    if (held && args.includes(match)) { held = false; entered.resolve(); await release.promise }
    return result
  } }
  return { processes, entered: entered.promise, release: release.resolve }
}
function projectServices(processes: GitProcessService) {
  const deps = { messages, settings: runtime.createRuntimeSettings(messages), processes }
  return runtime.createProjectServices(deps)
}
function docs(processes: GitProcessService) {
  const deps = { messages: { Error: Error, text: () => 'Проект' }, processes }
  return runtime.createDocServices(deps)
}

test('project root read is async; guarded save refuses authority revoked during await', async t => {
  const f = gitQueueFixture(t); const read = heldRead(t, '--show-toplevel'); t.after(read.release)
  const services = projectServices(read.processes); const manager = new services.ProjectManager(join(f.dir, 'profile'))
  manager.markRun('1.1.3')
  let allowed = true; let lookups = 0
  const commands = runtime.createProfileCommands({ manager: () => { lookups++; return manager }, authorize: () => allowed,
    workflowAssistant: runtime.createWorkflowAssistantServices({ messages }), exportMeta: () => ({ appVersion: '1.1.3', exportedAt: '2026-10-04T00:00:00Z' }) })
  const before = readFileSync(join(f.dir, 'profile', 'projects.json'), 'utf8')
  const pending = commands.addProject(operator, f.root)
  assert.ok(pending instanceof Promise, 'Root probe должен вернуть управление до сохранения')
  const rejected = assert.rejects(pending, e => e instanceof runtime.CommandError && e.code === 'command.forbidden')
  await read.entered; await new Promise<void>(resolve => setImmediate(resolve)); allowed = false
  assert.equal(manager.list().length, 0); read.release(); await rejected
  assert.equal(manager.active(), null); assert.equal(readFileSync(join(f.dir, 'profile', 'projects.json'), 'utf8'), before)
  assert.equal(lookups, 1)
})
test('project manager root subdirectory, duplicate concurrent adds and legacy selection are preserved', async t => {
  const f = gitQueueFixture(t); const process = runtime.createGitProcessService(); t.after(() => process.stop())
  const services = projectServices(process); const manager = new services.ProjectManager(join(f.dir, 'profile'))
  const sub = join(f.root, 'folder'); mkdirSync(sub)
  const pending = manager.add(sub); assert.ok(pending instanceof Promise)
  const one = await pending; assert.equal(one.root, f.root); assert.equal(manager.active()?.id, one.id)
  const [a, b] = await Promise.all([manager.add(f.unborn, undefined, false), manager.add(f.unborn, undefined, false)])
  assert.equal(a.id, b.id); assert.equal(manager.list().length, 2); assert.equal(manager.active()?.id, one.id)
  const reloaded = new services.ProjectManager(join(f.dir, 'profile')); assert.equal(reloaded.get(a.id)?.root, f.unborn)
  await assert.rejects(manager.add(f.dir), e => e instanceof ProfileHostError && e.key === 'projects.notGit')
})
test('project add preserves owned process cancellation instead of projects.notGit', async t => {
  const f = gitQueueFixture(t); const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const services = projectServices(processes); const manager = new services.ProjectManager(join(f.dir, 'profile')); await processes.stop()
  await assert.rejects(async () => manager.add(f.root), e => e instanceof runtime.GitProcessError && e.cancelled)
  assert.equal(manager.list().length, 0)
})
test('worktree documents yield during actual ls-files result and retain missing-base/unborn fallback', async t => {
  const f = gitQueueFixture(t); const read = heldRead(t, 'ls-files'); t.after(read.release)
  writeFileSync(join(f.unborn, 'note.md'), '# Note')
  const service = docs(read.processes); const pending = service.listWorktreeDocs(f.unborn, 'missing')
  assert.ok(pending instanceof Promise)
  await read.entered; let beat = false; await new Promise<void>(resolve => setImmediate(() => { beat = true; resolve() }))
  assert.equal(beat, true); read.release()
  assert.deepEqual((await pending).map(file => file.path), ['note.md'])
})
for (const method of ['worktree', 'project', 'groups'] as const) test(`docs ${method} refuses stopped owner instead of fallback or missing group`, async t => {
  const f = gitQueueFixture(t); const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  writeFileSync(join(f.root, 'note.md'), '# Note'); const service = docs(processes); await processes.stop()
  await assert.rejects(async () => {
    if (method === 'worktree') return service.listWorktreeDocs(f.root, 'main')
    if (method === 'project') return service.listProjectFiles(f.root)
    return service.listDocGroups(f.root, 'main', [{ id: 'T', title: 'Task', worktree: f.linked, branch: 'linked' }])
  }, e => e instanceof runtime.GitProcessError && e.cancelled)
})
