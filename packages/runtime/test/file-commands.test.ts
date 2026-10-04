import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import { profileFixture, operator } from './profile-command-test-host.ts'
import { OrcaError, fileServices } from './fixtures/file-services.ts'

function deferred() {
  let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(paused = false) {
  assert.equal(typeof runtime.createFileCommands, 'function')
  assert.equal(typeof runtime.registeredProject, 'function')
  const f = (await profileFixture()); const services = fileServices(); const entered = deferred(); const gate = deferred()
  const files = { ...services.projectFiles, resolveProjectPath: async (...args: Parameters<typeof services.projectFiles.resolveProjectPath>) => {
    if (paused) { entered.resolve(); await gate.promise }
    return services.projectFiles.resolveProjectPath(...args)
  } }
  const view = runtime.createDocViewServices({ messages: { Error: OrcaError }, files, preview: services.preview })
  const tokens = new runtime.PreviewTokens(); const effects: Array<{ kind: string; path: string }> = []
  const ops = runtime.createGitOperations({ error: (key, params) => new OrcaError(key, params), untrackedLabel: () => 'untracked' })
  for (const project of [f.a, f.b]) {
    writeFileSync(join(project.root, 'README.md'), `# ${project.name}\n`)
    writeFileSync(join(project.root, 'index.html'), '<p>preview</p>')
    writeFileSync(join(project.root, 'image.png'), new Uint8Array([1, 2, 3]))
    writeFileSync(join(project.root, 'run.sh'), 'echo no')
    execFileSync('git', ['add', '.'], { cwd: project.root, stdio: 'pipe' })
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: project.root, stdio: 'pipe' })
  }
  let lookups = 0; let allowed = true
  const snapshots = (id: string) => ({ root: join(f.dataDir, 'showcase'), projectId: id })
  const commands = runtime.createFileCommands({
    project: id => { lookups++; return runtime.registeredProject(f.manager, id) },
    authorize: ctx => allowed && ctx.actor.kind === 'operator' && ctx.actor.id === 'person' && ['one', 'two'].includes(ctx.clientId),
    isCurrent: p => runtime.isRegisteredProjectCurrent(f.manager, p),
    files, docs: services.docs, view, showcase: services.showcase, tokens, snapshots,
    branch: p => ops.currentBranch(p.root),
    native: { open: async path => { effects.push({ kind: 'open', path }) }, reveal: path => { effects.push({ kind: 'reveal', path }) } }
  })
  const taskSource = (id = f.b.id) => {
    const store = f.manager.store(id); const task = store.createTask({ title: 'source' })
    const wt = join(f.dir, `wt-${task.id}`); mkdirSync(wt)
    writeFileSync(join(wt, 'README.md'), 'task source'); writeFileSync(join(wt, 'image.png'), new Uint8Array([7, 8]))
    writeFileSync(join(wt, 'index.html'), '<p>task</p>')
    store.updateTask(task.id, { worktree: wt, branch: `orca/${task.id}` })
    const dispatch = store.startDispatch(task.id, 'pty')
    return { store, task, dispatch, wt }
  }
  return { ...f, services, commands, tokens, effects, gate, entered, snapshots, taskSource,
    context: (id = f.b.id, clientId = 'one') => ({ ...operator, clientId, projectId: id }),
    lookups: () => lookups, deny: () => { allowed = false }, close: () => { gate.resolve(); f.close() } }
}
const code = (value: string) => (error: unknown) => error instanceof runtime.CommandError && error.code === value
const domain = (key: string) => (error: unknown) => error instanceof runtime.CommandError && error.cause instanceof OrcaError && error.cause.key === key

test('file API: context/policy/input проверены до project lookup и native/grant effects', async () => {
  const f = (await fixture())
  try {
    await assert.rejects(f.commands.listDocs(null as never), code('command.invalidContext'))
    await assert.rejects(f.commands.viewDoc({ ...f.context(), actor: { kind: 'agent', id: 'agent' } }, '', '../x'), code('command.forbidden'))
    await assert.rejects(f.commands.listDir(f.context(), '../x'), domain('files.badPath'))
    await assert.rejects(f.commands.viewDoc(f.context(), 'project', 'README.md', { source: 'yes' } as never), code('command.invalidInput'))
    await assert.rejects(f.commands.showcasePreview(f.context(), '', 'index.html'), code('command.invalidInput'))
    await assert.rejects(f.commands.showcasePreview(f.context(), 'dispatch', 'index.html', { network: true, root: '/other' } as never), code('command.invalidInput'))
    await assert.rejects(f.commands.readDoc(f.context(), '', 'README.md'), code('command.invalidInput'))
    assert.equal(f.lookups(), 0); assert.deepEqual(f.effects, []); assert.equal(f.tokens.size, 0)
    await assert.rejects(f.commands.listDir(f.context('missing'), ''), code('command.projectNotFound'))
  } finally { f.close() }
})
test('file API: явный проект двух клиентов, DTO и байты отделены, active selection прежняя', async () => {
  const f = (await fixture())
  try {
    const a = await f.commands.readDoc(f.context(f.a.id, 'one'), 'project', 'README.md')
    const b = await f.commands.readDoc(f.context(f.b.id, 'two'), 'project', 'README.md')
    assert.notEqual(a, b); assert.equal(f.manager.active()?.id, f.a.id)
    const listing = await f.commands.listDir(f.context(), '')
    assert.ok(listing.entries.some(entry => entry.name === 'README.md'))
    const groups = await f.commands.listDocs(f.context())
    assert.equal(groups[0].source, 'project'); assert.ok(!JSON.stringify(groups).includes(f.b.root))
    const view = await f.commands.viewDoc(f.context(), 'project', 'README.md')
    assert.equal(view.text, b)
    const image = await f.commands.docBytes(f.context(), 'project', 'image.png')
    image.bytes[0] = 99
    assert.deepEqual([...readFileSync(join(f.b.root, 'image.png'))], [1, 2, 3])
  } finally { f.close() }
})
test('native commands отдают void, private path только trusted host, executable не открывается', async () => {
  const f = (await fixture())
  try {
    assert.equal(await f.commands.openDoc(f.context(), 'project', 'README.md'), undefined)
    assert.equal(await f.commands.revealDoc(f.context(), 'project', 'run.sh'), undefined)
    assert.equal(await f.commands.revealFile(f.context(), 'image.png'), undefined)
    assert.deepEqual(f.effects, [
      { kind: 'open', path: join(f.b.root, 'README.md') }, { kind: 'reveal', path: join(f.b.root, 'run.sh') }, { kind: 'reveal', path: join(f.b.root, 'image.png') }
    ])
    await assert.rejects(f.commands.openDoc(f.context(), 'project', 'run.sh'), domain('docs.notOpenable'))
    assert.equal(f.effects.length, 3)
  } finally { f.close() }
})
test('doc sources принадлежат указанному store; preview project всегда без сети', async () => {
  const f = (await fixture())
  try {
    const { task, wt } = f.taskSource()
    assert.equal(await f.commands.readDoc(f.context(), task.id, 'README.md'), 'task source')
    await assert.rejects(f.commands.viewDoc(f.context(f.a.id), task.id, 'README.md'), domain('docs.noTaskSource'))
    const preview = await f.commands.docPreview(f.context(), 'project', 'index.html')
    assert.deepEqual(f.tokens.get(new URL(preview.base).host), { root: f.b.root, network: false })
    assert.ok(!JSON.stringify(preview).includes(f.b.root))
    const next = await f.commands.docPreview(f.context(), task.id, 'index.html')
    assert.deepEqual(f.tokens.get(new URL(next.base).host), { root: wt, network: false })
  } finally { f.close() }
})
test('showcase: task/dispatch принадлежность, snapshot network, old/null dispatch и native paths', async () => {
  const f = (await fixture())
  try {
    const { task, store, dispatch, wt } = f.taskSource()
    const bytes = await f.commands.readShowcase(f.context(), task.id, 'image.png', null)
    assert.deepEqual([...bytes.bytes], [7, 8])
    await assert.rejects(f.commands.showcasePreview(f.context(), dispatch.id, 'index.html', { network: true }), domain('showcase.networkNoSnapshot'))
    const other = f.taskSource(); await assert.rejects(f.commands.readShowcase(f.context(), task.id, 'image.png', other.dispatch.id), domain('showcase.dispatchNotFound'))
    const prepared = f.services.snapshot.snapshotDispatchShowcase(store, f.snapshots(f.b.id), dispatch.id, ['index.html', 'image.png'])!
    prepared.commit()
    store.finishDispatch(dispatch.id, 'done', [], undefined, { showcase: { files: prepared.files }, snapshot: prepared.snapshot })
    store.updateTask(task.id, { worktree: undefined })
    const preview = await f.commands.showcasePreview(f.context(), dispatch.id, 'index.html', { network: true })
    const root = runtime.showcaseSnapshotDir(f.snapshots(f.b.id).root, f.b.id, task.runId, dispatch.id)
    assert.deepEqual(f.tokens.get(new URL(preview.base).host), { root, network: true })
    const base = await f.commands.showcaseBase(f.context(), dispatch.id)
    assert.ok(base); assert.deepEqual(f.tokens.get(new URL(base).host), { root, network: false })
    await f.commands.openShowcase(f.context(), task.id, 'index.html', dispatch.id)
    await f.commands.revealShowcase(f.context(), task.id, 'image.png', dispatch.id)
    assert.deepEqual(f.effects, [{ kind: 'open', path: realpathSync(join(root, 'index.html')) }, { kind: 'reveal', path: realpathSync(join(root, 'image.png')) }])
    assert.ok(!JSON.stringify(preview).includes(wt))
  } finally { f.close() }
})
for (const kind of ['remove', 'readd', 'policy'] as const) test(`late file ${kind}: no grant/native effect`, async () => {
  const f = (await fixture(true))
  try {
    const pending = f.commands.docPreview(f.context(), 'project', 'index.html')
    await f.entered.promise
    if (kind === 'policy') f.deny()
    else { f.manager.remove(f.b.id); if (kind === 'readd') assert.equal((await f.manager.add(f.b.root)).id, f.b.id) }
    f.gate.resolve()
    await assert.rejects(pending, code(kind === 'policy' ? 'command.forbidden' : 'command.stale'))
    assert.equal(f.tokens.size, 0); assert.deepEqual(f.effects, [])
  } finally { f.close() }
})
test('task source changes during real async read: late native open rejected', async () => {
  const f = (await fixture(true))
  try {
    const { task, store } = f.taskSource()
    const pending = f.commands.openDoc(f.context(), task.id, 'README.md')
    await f.entered.promise
    store.updateTask(task.id, { worktree: f.b.root })
    f.gate.resolve(); await assert.rejects(pending, code('command.stale'))
    assert.deepEqual(f.effects, [])
  } finally { f.close() }
})
test('dispatch replaced before native async result: old snapshot result rejected', async () => {
  const f = (await fixture()); const { task, store, dispatch } = f.taskSource()
  try {
    const entered = deferred(); const gate = deferred()
    // native port выполняет настоящее событие после проверки пути; меняем dispatch до результата.
    const host = { project: (id: string) => runtime.registeredProject(f.manager, id), authorize: () => true,
      isCurrent: (p: runtime.RegisteredProject) => runtime.isRegisteredProjectCurrent(f.manager, p),
      files: f.services.projectFiles, docs: f.services.docs, view: f.services.view, showcase: f.services.showcase, tokens: f.tokens,
      snapshots: f.snapshots, branch: () => 'master', native: {
        open: async (path: string) => { assert.ok(readFileSync(path).length); entered.resolve(); await gate.promise }, reveal: () => {}
      } }
    const commands = runtime.createFileCommands(host)
    const pending = commands.openShowcase(f.context(), task.id, 'index.html', dispatch.id)
    await entered.promise; store.startDispatch(task.id, 'next', dispatch.id); gate.resolve()
    await assert.rejects(pending, code('command.stale'))
  } finally { f.close() }
})


test('showcaseBase: замена dispatch до выдачи результата отклоняет поздний URL', async () => {
  const f = (await fixture())
  try {
    const { store, task, dispatch } = f.taskSource()
    const pending = f.commands.showcaseBase(f.context(), dispatch.id)
    store.startDispatch(task.id, 'next', dispatch.id)
    await assert.rejects(pending, code('command.stale'))
  } finally { f.close() }
})

test('single doc source проверяет только указанную задачу/store и её доступный worktree', async () => {
  const f = (await fixture())
  try {
    assert.equal(typeof f.services.docs.docTask, 'function')
    const { task, store, wt } = f.taskSource()
    assert.equal(f.services.docs.docTask(store, task.id)?.worktree, wt)
    assert.equal(f.services.docs.docTask(f.manager.store(f.a.id), task.id), undefined)
    store.updateTask(task.id, { status: store.columnId('done') })
    assert.equal(f.services.docs.docTask(store, task.id), undefined)
    assert.equal(f.services.docs.docTask(store, 'missing'), undefined)
  } finally { f.close() }
})
