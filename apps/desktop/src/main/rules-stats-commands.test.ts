import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectStats, TaskStats, GlobalTaskStats } from '@orca-board/core'
import type { ClientCommandContext, RuleFile } from '@orca-board/contracts'
import { claudeSlug, createRuleCommands, createRuleServices, createStatsCommands, createStatsServices,
  isStatsProjectCurrent, statsProject, TranscriptCache } from '@orca-board/runtime'
import { ProjectManager } from './projects'
import { OrcaError, ipcError, setMainLocale } from './i18n'
import * as adapter from './rules-stats-commands'

type Event = { client: string | null }
const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); setMainLocale('ru') })
const channels = ['rules:list', 'rules:save', 'stats:project', 'stats:task', 'stats:global']
function deferred() {
  let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, resolve: release }
}
class PausedCache extends TranscriptCache {
  entered = deferred(); gate = deferred()
  override async read(...args: Parameters<TranscriptCache['read']>) {
    this.entered.resolve(); await this.gate.promise; return super.read(...args)
  }
}
async function fixture(cache?: TranscriptCache) {
  assert.equal(typeof adapter.registerDesktopRulesStatsCommands, 'function')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-desktop-rules-stats-')))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const dataDir = join(dir, 'profile'); const manager = new ProjectManager(dataDir)
  const repo = (name: string) => { const root = join(dir, name); mkdirSync(root); execFileSync('git', ['init', '-q', root], { stdio: 'pipe' }); return root }
  const a = (await manager.add(repo('A'))); const b = (await manager.add(repo('B'))); manager.setActive(a.id)
  let lookups = 0; let selections = 0; let selected: string | undefined = a.id
  const env = { claudeDir: join(dir, 'claude'), codexDir: join(dir, 'codex') }
  const authorize = (ctx: ClientCommandContext) => ctx.clientId === 'desktop:1' && ctx.actor.kind === 'operator' && ctx.actor.id === 'local-user'
  const project = (id: string) => { lookups++; return statsProject(manager, id) }
  const messages = { Error: OrcaError }
  const rules = createRuleCommands({ project, authorize, rules: createRuleServices({ messages }) })
  const stats = createStatsCommands({ project, authorize, messages, stats: createStatsServices({ messages }),
    isCurrent: p => isStatsProjectCurrent(manager, p), workflow: () => undefined,
    deps: p => ({ store: p.store, repoRoot: p.root, columns: manager.columns(p.id), roleTitle: () => undefined,
      isAlive: () => false, env, ...(cache ? { cache } : {}) }) })
  const handlers = new Map<string, (event: Event, ...args: unknown[]) => unknown>()
  adapter.registerDesktopRulesStatsCommands<Event>((channel, fn) => handlers.set(channel, fn as (event: Event, ...args: unknown[]) => unknown), {
    rules, stats, clientId: e => e.client, activeProjectId: () => { selections++; return selected }
  })
  assert.deepEqual([...handlers.keys()].sort(), [...channels].sort())
  return { dir, dataDir, manager, a, b, lookups: () => lookups, selections: () => selections,
    select: (id?: string) => { selected = id; if (id) manager.setActive(id) },
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({ client: 'desktop:1' }, ...args),
    foreign: (channel: string) => handlers.get(channel)!({ client: null }),
    session: (projectId: string, runId?: string) => {
      const store = manager.store(projectId); const task = store.createTask({ title: 'транскрипт', ...(runId ? { runId } : {}) })
      const sessionId = `session-${task.id}`
      store.startDispatch(task.id, 'pty', `dispatch-${task.id}`, { agent: 'claude', sessionId })
      const cwd = join(manager.get(projectId)!.root, '..', '.orca-worktrees', task.id)
      const folder = join(env.claudeDir, 'projects', claudeSlug(cwd)); mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `${sessionId}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), cwd,
        requestId: task.id, message: { id: task.id, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 20 } } }) + '\n')
      return task
    }
  }
}
test('все пять caller проверены до selection/project lookup', async () => {
  const f = (await fixture())
  for (const channel of channels) await assert.rejects(async () => f.foreign(channel), e => e instanceof OrcaError && e.key === 'command.forbidden')
  assert.equal(f.lookups(), 0); assert.equal(f.selections(), 0)
})
test('rules IPC сохраняет legacy selection, DTO и CRLF', async () => {
  const f = (await fixture()); writeFileSync(join(f.a.root, 'AGENTS.md'), 'old\r\n')
  const saved = f.call('rules:save', 'AGENTS.md', 'A\n') as RuleFile
  assert.deepEqual(saved, { name: 'AGENTS.md', exists: true, text: 'A\n', eol: 'crlf' })
  f.select(f.b.id); f.call('rules:save', 'AGENTS.md', 'B\n')
  assert.equal((f.call('rules:list') as RuleFile[])[1].text, 'B\n')
  assert.equal(readFileSync(join(f.a.root, 'AGENTS.md'), 'utf8'), 'A\r\n')
  assert.equal(readFileSync(join(f.b.root, 'AGENTS.md'), 'utf8'), 'B\n')
})
test('rules без проекта сохраняет projects.none; malformed имя отклонено до lookup', async () => {
  const f = (await fixture()); f.select()
  assert.throws(() => f.call('rules:list'), e => e instanceof OrcaError && e.key === 'projects.none')
  assert.equal(f.lookups(), 0)
  f.select(f.a.id)
  assert.throws(() => f.call('rules:save', '../evil', 'bad'), e => e instanceof OrcaError && e.key === 'rules.onlyKnown')
  assert.equal(f.lookups(), 0)
})
test('stats explicit B игнорирует active A и работает без selection', async () => {
  const f = (await fixture()); f.session(f.a.id); const task = f.session(f.b.id)
  const stats = await f.call('stats:project', f.b.id, 'all') as ProjectStats
  assert.equal(stats.projectId, f.b.id); assert.equal(stats.totals.sessions, 1)
  assert.deepEqual(stats.totals.tokens, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 })
  assert.equal(f.manager.active()?.id, f.a.id); assert.equal(f.selections(), 0)
  f.select()
  const single = await f.call('stats:task', f.b.id, task.id) as TaskStats
  assert.equal(single.taskId, task.id); assert.equal(single.dispatches.total, 1)
  assert.equal(f.selections(), 0)
})
test('stats global использует явный проект и только сессии прогона', async () => {
  const f = (await fixture()); const store = f.manager.store(f.b.id); const run = store.createRun('цель', 'coordinator')
  f.session(f.b.id, run.id); f.session(f.b.id)
  const stats = await f.call('stats:global', f.b.id, run.id) as GlobalTaskStats
  assert.equal(stats.runId, run.id); assert.equal(stats.subtasks.count, 1)
  assert.equal(stats.usage.tokens?.input, 10)
  assert.equal(f.selections(), 0); assert.equal(f.manager.active()?.id, f.a.id)
})
test('stats invalid range/id/context и missing project не используют active', async () => {
  const f = (await fixture())
  await assert.rejects(async () => f.call('stats:project', f.b.id, 'bad'), e => e instanceof OrcaError && e.key === 'stats.badRange')
  await assert.rejects(async () => f.call('stats:task', f.b.id, ''), e => e instanceof OrcaError && e.key === 'command.invalidInput')
  await assert.rejects(async () => f.call('stats:global', null, 'run'), e => e instanceof OrcaError && e.key === 'command.invalidContext')
  assert.equal(f.lookups(), 0); assert.equal(f.selections(), 0)
  await assert.rejects(async () => f.call('stats:project', 'missing', 'all'), e => e instanceof OrcaError && e.key === 'command.projectNotFound')
})
test('sync rules и async stats ошибки сохраняют ru/en IPC codes', async () => {
  const f = (await fixture())
  for (const locale of ['ru', 'en'] as const) {
    setMainLocale(locale)
    assert.throws(() => f.call('rules:save', 'AGENTS.md', 42), e => {
      assert.ok(e instanceof OrcaError); assert.equal(e.key, 'rules.notString')
      const translated = ipcError(e); assert.ok(translated instanceof Error)
      assert.match(translated.message, locale === 'ru' ? /текст должен быть строкой/ : /text must be a string/); return true
    })
    await assert.rejects(async () => f.call('stats:task', f.b.id, 'missing'), e => {
      assert.ok(e instanceof OrcaError); assert.equal(e.key, 'stats.noTask')
      const translated = ipcError(e); assert.ok(translated instanceof Error)
      assert.equal(translated.name, 'OrcaError[stats.noTask]')
      assert.match(translated.message, locale === 'ru' ? /нет в проекте/ : /not in the project/); return true
    })
  }
})
test('удаление проекта при async IPC возвращает локализуемый stale и не пишет board', async () => {
  const cache = new PausedCache(); const f = (await fixture(cache)); f.session(f.b.id)
  const pending = f.call('stats:project', f.b.id, 'all') as Promise<ProjectStats>
  await cache.entered.promise; f.manager.remove(f.b.id)
  const board = join(f.dataDir, 'boards', `${f.b.id}.json`); const before = readFileSync(board, 'utf8')
  cache.gate.resolve()
  await assert.rejects(pending, e => e instanceof OrcaError && e.key === 'command.stale')
  assert.equal(readFileSync(board, 'utf8'), before)
})
