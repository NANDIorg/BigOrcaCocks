// Запуск: pnpm --filter @orca-board/desktop test. Транскрипты агентов для статистики — на временных папках.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, statsSessions, type StatsSession } from '@orca-board/core'
import { claudeSlug, collectSessionUsage, TranscriptCache, parseClaudeLine, type TranscriptEnv, type UsageContext } from './transcripts'
import { projectStats } from './stats'

let tmp: string
let env: TranscriptEnv

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-stats-')))
  env = { claudeDir: path.join(tmp, 'claude'), codexDir: path.join(tmp, 'codex') }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const iso = (ms: number): string => new Date(ms).toISOString()

/** Строка ответа ассистента Claude Code (одна на блок контента — с одинаковыми id). */
function assistant(at: number, id: string, model: string, usage: Record<string, unknown>, cwd = '/w'): string {
  return JSON.stringify({ type: 'assistant', timestamp: iso(at), cwd, requestId: `req_${id}`, message: { id, model, usage } }) + '\n'
}

function claudeFile(cwd: string, sid: string, lines: string[]): string {
  const dir = path.join(env.claudeDir, 'projects', claudeSlug(cwd))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sid}.jsonl`)
  writeFileSync(file, lines.join(''))
  return file
}

function ctx(repoRoot: string, worktrees: Record<string, string> = {}, now = Date.now()): UsageContext {
  return { env, cache: new TranscriptCache(), repoRoot, worktree: (id) => worktrees[id] ?? path.join(repoRoot, '..', '.orca-worktrees', id), now }
}

const T0 = Date.UTC(2026, 8, 24, 10)
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } }

describe('транскрипты Claude Code', () => {
  it('slug — все символы не из [A-Za-z0-9] заменены на -', () => {
    assert.equal(claudeSlug('/Users/me/.orca-worktrees/task_x'), '-Users-me--orca-worktrees-task-x')
  })

  it('дубли реплики считаются один раз, битая строка и <synthetic> пропускаются, неизвестная модель остаётся', async () => {
    const file = claudeFile('/repo', 's1', [
      JSON.stringify({ type: 'user', timestamp: iso(T0), cwd: '/repo' }) + '\n',
      assistant(T0 + 1000, 'm1', 'claude-opus-5', usage),
      assistant(T0 + 2000, 'm1', 'claude-opus-5', usage),
      '{"type":"assistant", битая строка\n',
      assistant(T0 + 3000, 'm2', '<synthetic>', usage),
      assistant(T0 + 4000, 'm3', 'mystery-1', { input_tokens: 1, output_tokens: 2 })
    ])
    const f = await new TranscriptCache().read(file, parseClaudeLine)
    const recs = [...(f?.records.values() ?? [])]
    assert.equal(recs.length, 2)
    assert.deepEqual(recs[0], { at: T0 + 2000, model: 'claude-opus-5', input: 10, output: 20, cacheRead: 100, cacheWrite5m: 20, cacheWrite1h: 30 })
    assert.equal(recs[1].model, 'mystery-1')
    assert.equal(recs[1].cacheWrite5m, 0)
    assert.equal(f?.firstAt, T0)
    assert.equal(f?.lastAt, T0 + 4000)
    assert.equal(f?.cwd, '/repo')
  })

  it('кэш: файл не менялся — не перечитывается; дописан — дочитывается хвост, недописанная строка ждёт', async () => {
    const file = claudeFile('/repo', 's1', [assistant(T0, 'm1', 'claude-opus-5', usage)])
    const cache = new TranscriptCache()
    const first = await cache.read(file, parseClaudeLine)
    assert.equal(first?.records.size, 1)
    assert.equal(await cache.read(file, parseClaudeLine), first)
    const next = assistant(T0 + 1000, 'm2', 'claude-opus-5', usage)
    appendFileSync(file, next.slice(0, 40))
    assert.equal((await cache.read(file, parseClaudeLine))?.records.size, 1)
    appendFileSync(file, next.slice(40))
    const grown = await cache.read(file, parseClaudeLine)
    assert.equal(grown?.records.size, 2)
    assert.equal(grown?.lastAt, T0 + 1000)
    // Файл переписан короче — разбор заново.
    writeFileSync(file, assistant(T0 + 5000, 'm9', 'claude-sonnet-5', usage))
    const rewritten = await cache.read(file, parseClaudeLine)
    assert.deepEqual([...(rewritten?.records.keys() ?? [])], ['m9:req_m9'])
  })

  it('сессия по sessionId: основной файл и сабагенты; вне папки slug — поиск по всем проектам', async () => {
    const wt = path.join(tmp, 'wt', 'task_a')
    claudeFile(wt, 'sid-1', [assistant(T0, 'm1', 'claude-opus-5', usage, wt)])
    const sub = path.join(env.claudeDir, 'projects', claudeSlug(wt), 'sid-1', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, 'agent-1.jsonl'), assistant(T0 + 10, 'x1', 'claude-haiku-4-5', usage, wt))
    // Координатор: файл лежит не в папке slug корня (длинный путь укорочен).
    claudeFile('/somewhere/else', 'sid-c', [assistant(T0, 'c1', 'claude-opus-5', usage)])
    const sessions: StatsSession[] = [
      { key: 'd1', kind: 'dispatch', ptyId: 'p', roleId: 'developer', agent: 'claude', sessionId: 'sid-1', taskId: 'task_a', startedAt: T0 },
      { key: 'c', kind: 'coordinator', ptyId: 'pc', roleId: 'coordinator', agent: 'claude', sessionId: 'sid-c', runId: 'r', startedAt: T0 },
      { key: 'none', kind: 'dispatch', ptyId: 'p2', roleId: 'developer', agent: 'claude', sessionId: 'missing', taskId: 'task_a', startedAt: T0 },
      { key: 'gem', kind: 'dispatch', ptyId: 'p3', roleId: 'developer', agent: 'gemini', taskId: 'task_a', startedAt: T0 }
    ]
    const got = await collectSessionUsage(sessions, ctx(path.join(tmp, 'repo'), { task_a: wt }))
    assert.deepEqual(got.usage.get('d1')?.records.map((r) => r.model).sort(), ['claude-haiku-4-5', 'claude-opus-5'])
    assert.equal(got.usage.get('c')?.records.length, 1)
    assert.ok(!got.usage.has('none'))
    assert.ok(!got.usage.has('gem'))
  })

  it('dispatch без sessionId: сессии worktree делятся по окнам dispatch по первому сообщению', async () => {
    const wt = path.join(tmp, 'wt', 'task_b')
    claudeFile(wt, 'early', [assistant(T0 + 5_000, 'e1', 'claude-opus-5', usage, wt)])
    claudeFile(wt, 'late', [assistant(T0 + 2 * 3_600_000 + 5_000, 'l1', 'claude-sonnet-5', usage, wt)])
    claudeFile(wt, 'before', [assistant(T0 - 3_600_000, 'b1', 'claude-sonnet-5', usage, wt)])
    const sessions: StatsSession[] = [
      { key: 'd1', kind: 'dispatch', ptyId: 'p1', roleId: 'developer', agent: 'claude', taskId: 'task_b', startedAt: T0, endedAt: T0 + 3_600_000 },
      { key: 'd2', kind: 'dispatch', ptyId: 'p2', roleId: 'developer', agent: 'claude', taskId: 'task_b', startedAt: T0 + 2 * 3_600_000 }
    ]
    const got = await collectSessionUsage(sessions, ctx(path.join(tmp, 'repo'), { task_b: wt }))
    assert.deepEqual(got.usage.get('d1')?.records.map((r) => r.model), ['claude-opus-5'])
    assert.deepEqual(got.usage.get('d2')?.records.map((r) => r.model), ['claude-sonnet-5'])
  })
})

describe('транскрипты codex', () => {
  /** rollout-файл в папке локальной даты старта. */
  function rollout(start: number, id: string, cwd: string, lines: object[]): void {
    const d = new Date(start)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const dir = path.join(env.codexDir, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
    mkdirSync(dir, { recursive: true })
    const meta = { timestamp: iso(start), type: 'session_meta', payload: { id, cwd, timestamp: iso(start) } }
    writeFileSync(path.join(dir, `rollout-x-${id}.jsonl`), [meta, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  const tokens = (at: number, input: number, cached: number, output: number): object => ({
    timestamp: iso(at), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } }
  })

  it('накопительный счётчик — приросты, input без кэша; сессия найдена по cwd и окну, id запоминается', async () => {
    const wt = path.join(tmp, 'wt', 'task_c')
    mkdirSync(wt, { recursive: true })
    rollout(T0 + 1000, 'cx-1', wt, [
      { timestamp: iso(T0 + 1500), type: 'turn_context', payload: { model: 'gpt-6' } },
      tokens(T0 + 2000, 100, 60, 10),
      tokens(T0 + 2500, 100, 60, 10),
      tokens(T0 + 3000, 250, 160, 30)
    ])
    rollout(T0 + 1000, 'cx-other', path.join(tmp, 'elsewhere'), [tokens(T0 + 2000, 5, 0, 5)])
    const s: StatsSession = { key: 'd1', kind: 'dispatch', ptyId: 'p', roleId: 'developer', agent: 'codex', taskId: 'task_c', startedAt: T0, endedAt: T0 + 60_000 }
    const got = await collectSessionUsage([s], ctx(path.join(tmp, 'repo'), { task_c: wt }, T0 + 120_000))
    assert.equal(got.found.get('d1'), 'cx-1')
    const recs = got.usage.get('d1')?.records ?? []
    assert.deepEqual(recs.map((r) => [r.model, r.input, r.cacheRead, r.output]), [['gpt-6', 40, 60, 10], ['gpt-6', 50, 100, 20]])
    // С известным id — тот же файл без сверки cwd.
    const again = await collectSessionUsage([{ ...s, sessionId: 'cx-1' }], ctx(path.join(tmp, 'repo'), {}, T0 + 120_000))
    assert.equal(again.usage.get('d1')?.records.length, 2)
  })
})

describe('статистика проекта в main', () => {
  it('задача, выполненная Claude Code, — ненулевые токены и стоимость', async () => {
    const repo = path.join(tmp, 'repo')
    const store = new TaskStore()
    const t = store.createTask({ title: 'Фича' })
    const d = store.startDispatch(t.id, 'p1', 'd1', { roleId: 'developer', agent: 'claude', sessionId: 'sid-9' })
    const wt = path.join(tmp, '.orca-worktrees', t.id)
    claudeFile(wt, 'sid-9', [assistant(d.startedAt + 1000, 'm1', 'claude-opus-5', usage, wt)])
    const stats = await projectStats({
      projectId: 'p', range: '7d', store, repoRoot: repo, columns: DEFAULT_COLUMNS,
      roleTitle: () => 'Разработчик', isAlive: () => true, env, cache: new TranscriptCache(), now: d.startedAt + 60_000
    })
    assert.deepEqual(stats.totals.tokens, { input: 10, output: 20, cacheRead: 100, cacheWrite: 50 })
    assert.ok((stats.totals.costUsd ?? 0) > 0)
    assert.equal(stats.byTask[0].key, t.id)
    assert.equal(stats.byRole[0].title, 'Разработчик')
    assert.equal(statsSessions(store.snapshot()).length, 1)
  })
})
