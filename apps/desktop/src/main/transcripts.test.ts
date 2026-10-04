// Запуск: pnpm --filter @orca-board/desktop test. Транскрипты агентов для статистики — на временных папках.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, statsSessions, type StatsSession } from '@orca-board/core'
import { claudeSlug, TranscriptCache, type TranscriptEnv } from './transcripts'
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

const T0 = Date.UTC(2026, 8, 24, 10)
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } }

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
