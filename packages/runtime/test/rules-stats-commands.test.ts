import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_COLUMNS, DEFAULT_ROLES } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { profileFixture, operator } from './profile-command-test-host.ts'

function deferred() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, resolve: release }
}

class ResourceError extends Error {
  readonly key: string
  constructor(key: string) { super(key); this.key = key }
}
function fixture(cache?: runtime.TranscriptCache) {
  assert.equal(typeof runtime.createRuleCommands, 'function')
  assert.equal(typeof runtime.createStatsCommands, 'function')
  assert.equal(typeof runtime.statsProject, 'function')
  assert.equal(typeof runtime.isStatsProjectCurrent, 'function')
  const f = profileFixture(); let lookups = 0; let depsReads = 0; let allow = true
  const env = { claudeDir: join(f.dir, 'claude'), codexDir: join(f.dir, 'codex') }
  const messages = { Error: ResourceError }; const rules = runtime.createRuleServices({ messages })
  const stats = runtime.createStatsServices({ messages })
  const host = { project: (id: string) => {
    lookups++; return runtime.statsProject(f.manager, id)
  }, authorize: () => allow }
  const ruleCommands = runtime.createRuleCommands({ ...host, rules })
  const statsCommands = runtime.createStatsCommands({ ...host, stats, messages,
    isCurrent: (p) => runtime.isStatsProjectCurrent(f.manager, p),
    deps: (p) => { depsReads++; return { store: p.store, repoRoot: p.root, columns: DEFAULT_COLUMNS,
      roleTitle: () => undefined, isAlive: () => false, env, ...(cache ? { cache } : {}) } }, workflow: () => undefined })
  return { ...f, env, rules, stats, ruleCommands, statsCommands, lookups: () => lookups, depsReads: () => depsReads,
    deny: () => { allow = false }, context: (id: string) => ({ ...operator, projectId: id }) }
}

/** Пауза только перед чтением настоящего файла: проверяем гонку, а не результат заглушки. */
class PausedCache extends runtime.TranscriptCache {
  entered = deferred()
  gate = deferred()
  override async read(...args: Parameters<runtime.TranscriptCache['read']>) {
    this.entered.resolve(); await this.gate.promise; return super.read(...args)
  }
}
function codex(f: ReturnType<typeof fixture>, projectId: string) {
  const store = f.manager.store(projectId); const task = store.createTask({ title: 'codex', agent: 'codex' })
  const d = store.startDispatch(task.id, 'pty', 'dispatch', { agent: 'codex' })
  const date = new Date(d.startedAt); const pad = (n: number) => String(n).padStart(2, '0')
  const dir = join(f.env.codexDir, 'sessions', String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()))
  mkdirSync(dir, { recursive: true })
  const cwd = join(f.manager.get(projectId)!.root, '..', '.orca-worktrees', task.id)
  const at = new Date(d.startedAt).toISOString()
  writeFileSync(join(dir, 'rollout-x-found.jsonl'), JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 'found', cwd, timestamp: at } }) + '\n')
  return { store, task, d }
}
it('правила: public context/policy и malformed input раньше lookup', () => {
  const f = fixture()
  try {
    assert.throws(() => f.ruleCommands.list({} as never), { code: 'command.invalidContext' })
    assert.throws(() => f.ruleCommands.save(f.context(f.a.id), '../AGENTS.md' as never, 'x'), { code: 'command.rejected' })
    assert.throws(() => f.ruleCommands.save(f.context(f.a.id), 'AGENTS.md', 42 as never), { code: 'command.rejected' })
    assert.throws(() => f.ruleCommands.save(f.context(f.a.id), 'AGENTS.md', 'я'.repeat(600_000)), { code: 'command.rejected' })
    f.deny(); assert.throws(() => f.ruleCommands.list(f.context(f.a.id)), { code: 'command.forbidden' })
    assert.equal(f.lookups(), 0)
  } finally { f.close() }
})
it('правила: явно B, detached DTO и прежний формат файлов без смены active A', () => {
  const f = fixture()
  try {
    const ctx = f.context(f.b.id)
    const saved = f.ruleCommands.save(ctx, 'AGENTS.md', 'B\n'); saved.text = 'подмена'
    assert.equal(f.ruleCommands.read(ctx, 'AGENTS.md').text, 'B\n')
    assert.equal(f.ruleCommands.list(f.context(f.a.id))[1].exists, false)
    assert.equal(f.manager.active()?.id, f.a.id)
    assert.equal(readFileSync(join(f.b.root, 'AGENTS.md'), 'utf8'), 'B\n')
    assert.throws(() => f.ruleCommands.list(f.context('missing')), { code: 'command.projectNotFound' })
  } finally { f.close() }
})
it('статистика: payload/policy раньше lookup и deps, неизвестные ids до диска', async () => {
  const f = fixture()
  try {
    await assert.rejects(f.statsCommands.project({} as never, 'all'), { code: 'command.invalidContext' })
    await assert.rejects(f.statsCommands.project(f.context(f.a.id), 'bad' as never), { code: 'command.rejected' })
    await assert.rejects(f.statsCommands.task(f.context(f.a.id), ''), { code: 'command.invalidInput' })
    await assert.rejects(f.statsCommands.global(f.context(f.a.id), 42 as never), { code: 'command.invalidInput' })
    assert.equal(f.lookups(), 0); assert.equal(f.depsReads(), 0)
    await assert.rejects(f.statsCommands.task(f.context(f.a.id), 'missing'), (e: unknown) => e instanceof runtime.CommandError && e.cause instanceof ResourceError && e.cause.key === 'stats.noTask')
    await assert.rejects(f.statsCommands.global(f.context(f.a.id), 'missing'), (e: unknown) => e instanceof runtime.CommandError && e.cause instanceof ResourceError && e.cause.key === 'stats.noGlobal')
    f.deny(); const lookups = f.lookups()
    await assert.rejects(f.statsCommands.project(f.context(f.a.id), 'all'), { code: 'command.forbidden' }); assert.equal(f.lookups(), lookups)
  } finally { f.close() }
})
it('статистика: project B не выбирает A, найденный Codex session id сохраняется и загружается', async () => {
  const f = fixture()
  try {
    const { store, d } = codex(f, f.b.id)
    const result = await f.statsCommands.project(f.context(f.b.id), 'all')
    assert.equal(result.projectId, f.b.id); assert.equal(result.totals.sessions, 1)
    assert.equal(store.getDispatch(d.id)?.sessionId, 'found')
    assert.equal(f.reload().store(f.b.id).getDispatch(d.id)?.sessionId, 'found')
    assert.equal(f.manager.active()?.id, f.a.id)
  } finally { f.close() }
})
it('статистика: удаление проекта во время чтения не меняет поздно board JSON', async () => {
  const cache = new PausedCache(); const f = fixture(cache)
  try {
    const { store, d } = codex(f, f.b.id)
    const pending = f.statsCommands.project(f.context(f.b.id), 'all')
    await cache.entered.promise; f.manager.remove(f.b.id)
    const board = join(f.dataDir, 'boards', `${f.b.id}.json`); const before = readFileSync(board, 'utf8')
    cache.gate.resolve(); await assert.rejects(pending, { code: 'command.stale' })
    assert.equal(store.getDispatch(d.id)?.sessionId, undefined); assert.equal(readFileSync(board, 'utf8'), before)
  } finally { cache.gate.resolve(); f.close() }
})
it('статистика: повторное добавление того же пути не оживляет старый запрос', async () => {
  const cache = new PausedCache(); const f = fixture(cache)
  try {
    const { store, d } = codex(f, f.b.id)
    const pending = f.statsCommands.project(f.context(f.b.id), 'all')
    await cache.entered.promise; f.manager.remove(f.b.id)
    assert.equal(f.manager.add(f.b.root, undefined, false).id, f.b.id)
    cache.gate.resolve(); await assert.rejects(pending, { code: 'command.stale' })
    assert.equal(store.getDispatch(d.id)?.sessionId, undefined)
  } finally { cache.gate.resolve(); f.close() }
})
it('статистика: замена identity dispatch во время чтения не получает чужой session id', async () => {
  const cache = new PausedCache(); const f = fixture(cache)
  try {
    const { store, d } = codex(f, f.b.id)
    const pending = f.statsCommands.project(f.context(f.b.id), 'all')
    await cache.entered.promise
    const second = store.createTask({ title: 'новая' })
    store.startDispatch(second.id, 'new-pty', d.id, { agent: 'codex' })
    cache.gate.resolve(); const result = await pending
    assert.equal(store.getDispatch(d.id)?.sessionId, undefined)
    assert.equal(result.totals.sessions, 1)
  } finally { cache.gate.resolve(); f.close() }
})
it('статистика: изменение соседней задачи не отменяет чтение', async () => {
  const cache = new PausedCache(); const f = fixture(cache)
  try {
    const { store, d } = codex(f, f.b.id)
    const pending = f.statsCommands.project(f.context(f.b.id), 'all')
    await cache.entered.promise; store.createTask({ title: 'сосед' })
    cache.gate.resolve(); await pending
    assert.equal(store.getDispatch(d.id)?.sessionId, 'found')
  } finally { cache.gate.resolve(); f.close() }
})
it('общие stats deps захватывают названия ролей default и снимка удалённого типа', () => {
  assert.equal(typeof runtime.statsProjectDeps, 'function')
  const f = fixture()
  try {
    const roles = structuredClone(DEFAULT_ROLES); roles.find(r => r.id === 'developer')!.title = 'Default developer'
    f.manager.patchTaskType('general', { roles })
    const historic = f.manager.saveTaskType({ title: 'Historic', settings: { roles: [{ id: 'old-role', title: 'Historic role', agent: 'claude' }] } })
    f.manager.store(f.b.id).createGlobalTask({ title: 'История', type: f.manager.runType(f.b.id, historic.id) })
    f.manager.deleteTaskType(historic.id)
    const deps = runtime.statsProjectDeps(f.manager, runtime.statsProject(f.manager, f.b.id)!, { isAlive: () => false })
    assert.equal(deps.repoRoot, f.b.root); assert.equal(deps.store, f.manager.store(f.b.id))
    assert.equal(deps.roleTitle('developer'), 'Default developer')
    assert.equal(deps.roleTitle('old-role'), 'Historic role')
    roles.find(r => r.id === 'developer')!.title = 'Later'; f.manager.patchTaskType('general', { roles })
    assert.equal(deps.roleTitle('developer'), 'Default developer')
  } finally { f.close() }
})
