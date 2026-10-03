import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientCommandContext, DocBytes, DocGroup, DocView, ProjectFilesListing } from '@orca-board/contracts'
import { createDocServices, createDocViewServices, createFileCommands, createPreviewServices, createProjectFileServices,
  createSchemePreviewAddress, createShowcaseServices, isRegisteredProjectCurrent, PreviewTokens, registeredProject } from '@orca-board/runtime'
import { ProjectManager } from './projects'
import { OrcaError, ipcError, mt, setMainLocale } from './i18n'
import { currentBranch, gitCheckIgnore } from './git'
import * as adapter from './file-commands'

type Event = { client: string | null }
const channels = ['docs:list', 'docs:read', 'docs:view', 'docs:bytes', 'docs:previewUrl', 'docs:open', 'docs:reveal',
  'showcase:read', 'showcase:open', 'showcase:reveal', 'showcase:previewUrl', 'showcase:previewBase', 'files:list', 'files:reveal']
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); setMainLocale('ru') })
function deferred() { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture(paused = false) {
  assert.equal(typeof adapter.registerDesktopFileCommands, 'function')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-desktop-file-api-')))
  const manager = new ProjectManager(join(dir, 'profile'))
  const repo = (name: string) => {
    const root = join(dir, name); mkdirSync(root)
    execFileSync('git', ['init', '-q', root], { stdio: 'pipe' })
    writeFileSync(join(root, 'README.md'), `${name}\r\n`); writeFileSync(join(root, 'index.html'), `<p>${name}</p>`)
    writeFileSync(join(root, 'image.png'), new Uint8Array([1, 2, 3]))
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root, stdio: 'pipe' })
    return root
  }
  const a = manager.add(repo('A')); const b = manager.add(repo('B')); manager.setActive(a.id)
  let lookups = 0; let selections = 0; let selected: string | undefined = a.id
  const messages = { Error: OrcaError, text: mt }; const entered = deferred(); const gate = deferred()
  cleanup.push(() => { gate.resolve(); rmSync(dir, { recursive: true, force: true }) })
  const baseFiles = createProjectFileServices({ messages, gitCheckIgnore })
  const files = { ...baseFiles, resolveProjectPath: async (...args: Parameters<typeof baseFiles.resolveProjectPath>) => {
    if (paused) { entered.resolve(); await gate.promise }
    return baseFiles.resolveProjectPath(...args)
  } }
  const preview = createPreviewServices(createSchemePreviewAddress('orca-preview')); const tokens = new PreviewTokens()
  const native: string[] = []
  const authorize = (ctx: ClientCommandContext) => ctx.clientId === 'desktop:1' && ctx.actor.kind === 'operator' && ctx.actor.id === 'local-user'
  const commands = createFileCommands({ project: id => { lookups++; return registeredProject(manager, id) }, authorize,
    isCurrent: p => isRegisteredProjectCurrent(manager, p), files, docs: createDocServices({ messages }),
    view: createDocViewServices({ messages, files, preview }), showcase: createShowcaseServices({ messages, preview }),
    tokens, branch: p => currentBranch(p.root), snapshots: id => ({ root: join(dir, 'showcase'), projectId: id }),
    native: { open: async path => { native.push(path) }, reveal: path => { native.push(path) } } })
  const handlers = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopFileCommands<Event>((channel, fn) => handlers.set(channel, fn as (event: Event, ...args: unknown[]) => unknown), {
    commands, clientId: e => e.client, activeProjectId: () => { selections++; return selected }
  })
  assert.deepEqual([...handlers.keys()].sort(), [...channels].sort())
  return { dir, a, b, manager, tokens, native, gate, entered, lookups: () => lookups, selections: () => selections,
    select: (id?: string) => { selected = id }, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string) => handlers.get(channel)!({ client: null }) }
}

test('14 файловых caller проверены до selection, lookup, native и grant', async () => {
  const f = fixture()
  for (const channel of channels) await assert.rejects(async () => f.foreign(channel), e => e instanceof OrcaError && e.key === 'command.forbidden')
  assert.equal(f.lookups(), 0); assert.equal(f.selections(), 0); assert.deepEqual(f.native, []); assert.equal(f.tokens.size, 0)
})
test('docs legacy active source/DTO, no-project list [] и остальные projects.none', async () => {
  const f = fixture()
  assert.equal(await f.call('docs:read', 'project', 'README.md'), 'A\r\n')
  f.select(f.b.id)
  const view = await f.call('docs:view', 'project', 'README.md') as DocView
  assert.equal(view.text, 'B\r\n')
  const groups = await f.call('docs:list') as DocGroup[]
  assert.equal(groups[0].source, 'project')
  const bytes = await f.call('docs:bytes', 'project', 'image.png') as DocBytes
  assert.deepEqual([...bytes.bytes], [1, 2, 3])
  f.select()
  assert.deepEqual(await f.call('docs:list'), [])
  await assert.rejects(async () => f.call('docs:read', 'project', 'README.md'), e => e instanceof OrcaError && e.key === 'projects.none')
})
test('files explicit B без selection, native пути через common guard и DTO прежний', async () => {
  const f = fixture(); f.select()
  const listing = await f.call('files:list', f.b.id, null) as ProjectFilesListing
  assert.equal(listing.dir, ''); assert.ok(listing.entries.some(entry => entry.name === 'README.md'))
  assert.equal(f.selections(), 0)
  await f.call('files:reveal', f.b.id, 'README.md')
  assert.deepEqual(f.native, [join(f.b.root, 'README.md')]); assert.equal(f.selections(), 0)
  f.select(f.a.id)
  await f.call('docs:open', 'project', 'README.md'); await f.call('docs:reveal', 'project', 'image.png')
  assert.deepEqual(f.native.slice(1), [join(f.a.root, 'README.md'), join(f.a.root, 'image.png')])
})
test('showcase read/open/reveal/preview/base сохраняют legacy параметры', async () => {
  const f = fixture(); const store = f.manager.store(f.a.id); const task = store.createTask({ title: 'showcase' })
  store.updateTask(task.id, { worktree: f.a.root }); const dispatch = store.startDispatch(task.id, 'pty')
  const read = await f.call('showcase:read', task.id, 'image.png', dispatch.id) as DocBytes
  assert.deepEqual([...read.bytes], [1, 2, 3])
  await f.call('showcase:open', task.id, 'index.html', dispatch.id)
  await f.call('showcase:reveal', task.id, 'image.png', dispatch.id)
  const preview = await f.call('showcase:previewUrl', dispatch.id, 'index.html', null) as { url: string; base: string }
  assert.ok(preview.url.startsWith('orca-preview://'))
  assert.equal(await f.call('showcase:previewBase', dispatch.id), preview.base)
  assert.deepEqual(f.native, [join(f.a.root, 'index.html'), join(f.a.root, 'image.png')])
})
test('malformed explicit id/source/options переводится в прежние command codes', async () => {
  const f = fixture()
  await assert.rejects(async () => f.call('files:list', null, ''), e => e instanceof OrcaError && e.key === 'command.invalidContext')
  await assert.rejects(async () => f.call('docs:view', 'project', 'README.md', { source: 'yes' }), e => e instanceof OrcaError && e.key === 'command.invalidInput')
  assert.equal(f.lookups(), 0)
})
test('common domain rejection локализуется ru/en без утраты error code', async () => {
  const f = fixture()
  for (const locale of ['ru', 'en'] as const) {
    setMainLocale(locale)
    await assert.rejects(async () => f.call('docs:view', 'project', 'missing.txt'), e => {
      assert.ok(e instanceof OrcaError); assert.equal(e.key, 'files.notFound')
      const error = ipcError(e); assert.ok(error instanceof Error)
      assert.match(error.message, locale === 'ru' ? /не найден/ : /not found/); return true
    })
  }
})
test('late project removal: Desktop shell не вызывается и board JSON прежний', async () => {
  const f = fixture(true)
  f.manager.store(f.a.id).createTask({ title: 'persisted' })
  const board = join(f.dir, 'profile', 'boards', `${f.a.id}.json`); const before = readFileSync(board, 'utf8')
  const pending = f.call('docs:open', 'project', 'README.md') as Promise<void>
  await f.entered.promise
  f.manager.remove(f.a.id)
  f.gate.resolve()
  await assert.rejects(pending, e => e instanceof OrcaError && e.key === 'command.stale')
  assert.deepEqual(f.native, []); assert.equal(readFileSync(board, 'utf8'), before)
})
