import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, DEFAULT_ROLES, type RunTypeInput } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { resources } from './execution-test-host.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const context = (projectId = 'A') => ({ projectId, clientId: `client-${projectId}`, actor: { kind: 'operator' as const, id: 'local-user' } })
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8])
const attachment = () => ({ mime: 'image/jpeg', data: png.slice(), name: 'shot.png' })
const type = (id: string): RunTypeInput => ({ typeId: id, snapshot: { id, title: id, roles: [DEFAULT_ROLES[0]] } })
const code = (expected: string, field?: string) => (error: unknown) => error instanceof runtime.CommandError
  && error.code === expected && (field === undefined || error.details.field === field)

function fixture(authorize = (_context: unknown, _name: unknown) => true) {
  assert.equal(typeof runtime.createGlobalTaskCommands, 'function', 'Глобальные задачи доступны через общий executable API')
  const dir = mkdtempSync(join(tmpdir(), 'orca-global-commands-')); dirs.push(dir)
  const stores = new Map(['A', 'B'].map(id => [id, new TaskStore(runtime.jsonPersistence(join(dir, `${id}.json`)))]))
  const lookedUp: string[] = []
  const alive = new Set<string>(); const killed: string[] = []
  const service = runtime.createGlobalTaskCommands({
    authorize, dataDir: dir, resources: resources(), messages: { error: key => new Error(key) },
    sessions: { isAlive: id => alive.has(id), kill: id => { alive.delete(id); killed.push(id) } },
    selection: runtime.createAgentSelection({ error: key => new Error(key) }),
    project(id) {
      lookedUp.push(id)
      const store = stores.get(id)
      return store ? { store, root: join(dir, `repo-${id}`),
        runType: (typeId = 'standard') => { if (!['standard', 'other'].includes(typeId)) throw new Error('тип недоступен проекту'); return type(typeId) },
        roles: (runId: string) => ({ title: 'Type', roles: store.getRun(runId)?.taskType?.roles ?? [DEFAULT_ROLES[0]] }),
        agents: () => [{ id: DEFAULT_ROLES[0].agent, title: 'Agent', installed: true, enabled: true, models: [], defaults: {} }]
      } : undefined
    }
  })
  return { dir, stores, service, lookedUp, alive, killed }
}

test('CRUD двух явных проектов сохраняет тип, изменения и отделённые DTO после reload', () => {
  const f = fixture(); const a = f.service.create(context(), { title: 'Alpha', description: 'Text', priority: 'high' })
  const b = f.service.create(context('B'), { description: 'Beta', typeId: 'other' })
  f.service.update(context(), a.id, { title: 'Updated', description: 'Changed', priority: 'low' })
  f.service.changeType(context(), a.id, 'other')
  const moved = f.service.move(context(), a.id, 'in_progress')
  assert.equal(moved.status, 'in_progress'); assert.equal(moved.priority, 'low')
  moved.title = 'Mutated DTO'
  const list = f.service.list(context()); list[0].title = 'Mutated list'
  assert.equal(f.service.get(context(), a.id).title, 'Updated')
  assert.equal(f.service.get(context('B'), b.id).description, 'Beta')
  const restored = new TaskStore(runtime.jsonPersistence(join(f.dir, 'A.json')))
  assert.equal(restored.getRun(a.id)?.typeId, 'other')
  assert.equal(restored.getGlobalTask(a.id).title, 'Updated')
  f.service.remove(context(), a.id)
  assert.equal(f.service.list(context()).length, 0)
  assert.equal(f.service.list(context('B')).length, 1)
})

test('все 12 команд проверяют policy до payload и открытия проекта', () => {
  const checked: unknown[] = []; const f = fixture((ctx, name) => { checked.push([ctx, name]); return false })
  for (const action of [
    () => f.service.list(context()), () => f.service.get(context(), 'run'),
    () => f.service.create(context(), { title: 'No' }), () => f.service.update(context(), 'run', {}),
    () => f.service.changeType(context(), 'run', 'other'), () => f.service.move(context(), 'run', 'done'),
    () => f.service.remove(context(), 'run'), () => f.service.tasks(context(), 'run'),
    () => f.service.createTask(context(), 'run', { title: 'No' }), () => f.service.addImages(context(), 'run', [attachment()]),
    () => f.service.removeImage(context(), 'run', 'image'), () => f.service.image(context(), 'run', 'image')
  ]) assert.throws(action, code('command.forbidden'))
  assert.equal(checked.length, 12); assert.deepEqual(f.lookedUp, [])
  assert.equal(existsSync(join(f.dir, 'run-images')), false)
})

test('невалидный context и мутирующая policy не подменяют выбранный проект/автора', () => {
  const f = fixture(raw => { const ctx = raw as { projectId: string; actor: { kind: string } }; ctx.projectId = 'B'; ctx.actor.kind = 'system'; return true })
  assert.throws(() => f.service.list({ ...context(), actor: { kind: 'admin', id: 'x' } } as never), code('command.invalidContext'))
  assert.deepEqual(f.lookedUp, [])
  const run = f.service.create(context(), { title: 'A' })
  const task = f.service.createTask(context(), run.id, { title: 'Child' })
  assert.equal(task.statusHistory?.[0].by, 'human')
  assert.equal(f.stores.get('A')!.listTasks().length, 1); assert.equal(f.stores.get('B')!.listTasks().length, 0)
})

for (const [input, field] of [
  [null, 'input'], [[], 'input'], [{ title: '' }, 'title'], [{ title: 2 }, 'title'], [{ title: 'x', description: [] }, 'description'],
  [{ title: 'x', priority: 'other' }, 'priority'], [{ title: 'x', status: 1 }, 'status'], [{ title: 'x', typeId: [] }, 'typeId'],
  [{ title: 'x', workflow: {} }, 'workflow'], [{ title: 'x', type: {} }, 'type'], [{ title: 'x', images: [] }, 'images'],
  [{ title: 'x', runId: 'other' }, 'runId']
] as const) test(`create отклоняет ${field} до lookup/persistence`, () => {
  const f = fixture(); assert.throws(() => f.service.create(context(), input as never), code('command.invalidInput', field))
  assert.deepEqual(f.lookedUp, []); assert.equal(existsSync(join(f.dir, 'A.json')), false)
})

test('patch, status, typeId, cascade и id проверяются до lookup', () => {
  const f = fixture()
  for (const action of [() => f.service.update(context(), 'run', { status: 'done' } as never),
    () => f.service.update(context(), 'run', { description: false } as never),
    () => f.service.move(context(), 'run', ''), () => f.service.changeType(context(), 'run', 1 as never),
    () => f.service.remove(context(), 'run', { cascade: 'true' } as never), () => f.service.get(context(), [] as never)
  ]) assert.throws(action, code('command.invalidInput'))
  assert.deepEqual(f.lookedUp, [])
  assert.throws(() => f.service.list(context('removed')), code('command.projectNotFound'))
})

test('чужой run не даёт читать/менять подзадачи и вложения', () => {
  const f = fixture(); const run = f.service.create(context('B'), { title: 'B' }, [attachment()])
  const before = structuredClone(f.stores.get('B')!.snapshot())
  for (const action of [() => f.service.get(context(), run.id), () => f.service.update(context(), run.id, { title: 'No' }),
    () => f.service.changeType(context(), run.id, 'other'), () => f.service.move(context(), run.id, 'done'),
    () => f.service.remove(context(), run.id, { cascade: true }), () => f.service.tasks(context(), run.id),
    () => f.service.createTask(context(), run.id, { title: 'No' }), () => f.service.addImages(context(), run.id, [attachment()]),
    () => f.service.removeImage(context(), run.id, run.images![0].id), () => f.service.image(context(), run.id, run.images![0].id)
  ]) assert.throws(action, code('command.globalTaskNotFound'))
  assert.deepEqual(f.stores.get('B')!.snapshot(), before); assert.equal(f.stores.get('A')!.listRuns().length, 0)
  assert.equal(existsSync(join(f.dir, 'run-images', 'B', run.id)), true)
})

test('тип недоступен и блокировка смены после подзадачи не изменяют сохранённый run', () => {
  const f = fixture(); assert.throws(() => f.service.create(context(), { title: 'No', typeId: 'unknown' }), /тип недоступен/)
  assert.equal(f.stores.get('A')!.listRuns().length, 0)
  const run = f.service.create(context(), { title: 'A' })
  assert.throws(() => f.service.changeType(context(), run.id, 'unknown'), /тип недоступен/)
  f.service.createTask(context(), run.id, { title: 'Child' })
  const before = readFileSync(join(f.dir, 'A.json'), 'utf8')
  assert.throws(() => f.service.changeType(context(), run.id, 'other'), code('command.rejected'))
  assert.equal(readFileSync(join(f.dir, 'A.json'), 'utf8'), before)
})

test('подзадача использует роль и deps своей глобальной задачи; чужой dep отклоняется', () => {
  const f = fixture(); const run = f.service.create(context(), { title: 'A' }); const other = f.service.create(context(), { title: 'Other' })
  const first = f.service.createTask(context(), run.id, { title: 'First', answerFor: 'coordinator' })
  const second = f.service.createTask(context(), run.id, { title: 'Second', deps: [first.id], priority: 'high' })
  assert.equal(second.agent, DEFAULT_ROLES[0].agent); assert.equal(second.roleId, DEFAULT_ROLES[0].id)
  assert.deepEqual(second.deps, [first.id]); assert.equal(second.priority, 'high')
  assert.equal(f.service.tasks(context(), run.id).length, 2)
  const before = structuredClone(f.stores.get('A')!.snapshot())
  assert.throws(() => f.service.createTask(context(), other.id, { title: 'No', deps: [first.id] }), code('command.rejected'))
  assert.deepEqual(f.stores.get('A')!.snapshot(), before)
})

for (const [input, field] of [
  [{ title: 'x', runId: 'other' }, 'runId'], [{ title: 'x', agent: 'claude' }, 'agent'], [{ title: 'x', gateFor: {} }, 'gateFor'],
  [{ title: 'x', answerFor: 'admin' }, 'answerFor'], [{ title: 'x', deps: new Array<string>(1) }, 'deps']
] as const) test(`subtask отклоняет ${field} до lookup`, () => {
  const f = fixture(); assert.throws(() => f.service.createTask(context(), 'run', input as never), code('command.invalidInput', field))
  assert.deepEqual(f.lookedUp, [])
})

test('вложения проверяются до создания; sparse bytes не создают run', () => {
  const f = fixture()
  for (const images of [new Array(1), 'base64', [{ data: 'AAAA' }], [null]]) {
    assert.throws(() => f.service.create(context(), { title: 'No' }, images as never), code('command.invalidInput', 'images'))
  }
  assert.deepEqual(f.lookedUp, []); assert.equal(f.stores.get('A')!.listRuns().length, 0)
})

test('MIME из байтов, добавление/чтение/удаление и запрет чужого imageId', () => {
  const f = fixture(); const run = f.service.create(context(), { title: 'A' }, [attachment()])
  const loaded = f.service.image(context(), run.id, run.images![0].id)
  assert.equal(loaded.mime, 'image/png'); assert.deepEqual(loaded.data, png)
  loaded.data[0] = 0
  assert.deepEqual(f.service.image(context(), run.id, run.images![0].id).data, png)
  const added = f.service.addImages(context(), run.id, [{ name: 'notes.md', mime: 'text/plain', data: new Uint8Array([65]) }])
  assert.equal(added.images?.length, 2)
  assert.throws(() => f.service.image(context(), run.id, 'unknown'), code('command.rejected'))
  assert.throws(() => f.service.image(context(), run.id, added.images![1].id), /global.notAnImage/)
  const removed = f.service.removeImage(context(), run.id, run.images![0].id)
  assert.equal(removed.images?.length, 1)
  assert.equal(existsSync(join(f.dir, 'run-images', 'A', run.id, `${run.images![0].id}.png`)), false)
})

test('сбой файловой системы откатывает новый run и metadata', () => {
  const f = fixture(); writeFileSync(join(f.dir, 'run-images'), 'blocking file')
  assert.throws(() => f.service.create(context(), { title: 'No' }, [attachment()]), code('command.rejected'))
  assert.equal(f.stores.get('A')!.listRuns().length, 0)
  const restored = new TaskStore(runtime.jsonPersistence(join(f.dir, 'A.json')))
  assert.equal(restored.listRuns().length, 0)
})

test('cascade/live coordinator/live dispatch guards сохраняют run, файлы и PTY', () => {
  const f = fixture(); const run = f.service.create(context(), { title: 'A' }, [attachment()]); const store = f.stores.get('A')!
  const child = f.service.createTask(context(), run.id, { title: 'Child' })
  assert.throws(() => f.service.remove(context(), run.id), /cascade/)
  store.setRunPty(run.id, 'coordinator'); f.alive.add('coordinator')
  assert.throws(() => f.service.remove(context(), run.id, { cascade: true }), e => e instanceof runtime.CommandError && e.cause instanceof Error && e.cause.message === 'global.coordinatorAlive')
  f.alive.delete('coordinator'); store.startDispatch(child.id, 'worker'); f.alive.add('worker')
  const before = structuredClone(store.snapshot())
  assert.throws(() => f.service.remove(context(), run.id, { cascade: true }), /сначала останови/)
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(f.killed, [])
  assert.equal(existsSync(join(f.dir, 'run-images', 'A', run.id)), true)
})

test('разрешённое удаление убирает свои files, закрытый живой PTY и чистый worktree, сохраняя ветку', () => {
  const f = fixture(); const run = f.service.create(context(), { title: 'A' }, [attachment()]); const other = f.service.create(context('B'), { title: 'B' }, [attachment()])
  const store = f.stores.get('A')!; const child = f.service.createTask(context(), run.id, { title: 'Child' })
  const dispatch = store.startDispatch(child.id, 'worker'); store.finishDispatch(dispatch.id, 'done'); f.alive.add('worker')
  const showcase = join(f.dir, 'showcase', 'A', run.id); mkdirSync(showcase, { recursive: true }); writeFileSync(join(showcase, 'result.md'), 'showcase')
  const repo = join(f.dir, 'repo-A'); mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test', ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'master'); writeFileSync(join(repo, 'README'), 'base'); git('add', 'README'); git('commit', '-qm', 'base')
  const worktree = join(f.dir, 'global-worktree'); git('worktree', 'add', '-q', '-b', 'feature/global-test', worktree)
  store.setRunGit(run.id, { branch: 'feature/global-test', base: 'master', worktree })
  assert.deepEqual(f.service.remove(context(), run.id, { cascade: true }), { deleted: run.id, tasks: [child.id] })
  assert.equal(existsSync(showcase), false); assert.equal(existsSync(worktree), false)
  assert.equal(existsSync(join(f.dir, 'run-images', 'A', run.id)), false)
  assert.equal(existsSync(join(f.dir, 'run-images', 'B', other.id)), true)
  assert.deepEqual(f.killed, ['worker']); assert.equal(store.getTask(child.id), undefined)
  assert.equal(git('branch', '--list', 'feature/global-test'), 'feature/global-test')
})
