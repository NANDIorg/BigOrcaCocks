// Запуск: pnpm --filter @orca-board/desktop test. Статистика задачи и глобальной задачи в main: читаются только
// транскрипты сессий этой задачи (и её проверок), чужие — нет.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { claudeSlug, TranscriptCache, parseClaudeLine, type TranscriptEnv } from './transcripts'
import { globalTaskStats, taskStats } from './stats'

let tmp: string
let repo: string
let env: TranscriptEnv

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-task-stats-')))
  repo = path.join(tmp, 'repo')
  env = { claudeDir: path.join(tmp, 'claude'), codexDir: path.join(tmp, 'codex') }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Кэш, который запоминает, какие файлы транскриптов прочитали. */
class SpyCache extends TranscriptCache {
  readonly seen: string[] = []
  override read(file: string, parse: typeof parseClaudeLine): ReturnType<TranscriptCache['read']> {
    this.seen.push(path.basename(file, '.jsonl'))
    return super.read(file, parse)
  }
}

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }

/** Транскрипт Claude Code с одной репликой; `cwd` — worktree задачи или корень репозитория (координатор). */
function transcript(cwd: string, sid: string, at: number): void {
  const dir = path.join(env.claudeDir, 'projects', claudeSlug(cwd))
  mkdirSync(dir, { recursive: true })
  const line = { type: 'assistant', timestamp: new Date(at).toISOString(), cwd, requestId: `req_${sid}`, message: { id: `m_${sid}`, model: 'claude-opus-5', usage } }
  writeFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify(line) + '\n')
}

const worktree = (taskId: string): string => path.join(tmp, '.orca-worktrees', taskId)

function deps(store: TaskStore, cache: TranscriptCache) {
  return { store, repoRoot: repo, columns: DEFAULT_COLUMNS, roleTitle: () => undefined, isAlive: () => false, env, cache }
}

/** Сессия dispatch задачи с транскриптом; `sid` — и id сессии, и имя файла. */
function session(store: TaskStore, taskId: string, sid: string): void {
  const d = store.startDispatch(taskId, `pty_${sid}`, `d_${sid}`, { roleId: 'developer', agent: 'claude', sessionId: sid })
  transcript(worktree(taskId), sid, d.startedAt + 1000)
}

describe('статистика задачи в main', () => {
  it('читает транскрипты только сессий задачи и её проверки', async () => {
    const store = new TaskStore()
    const a = store.createTask({ title: 'A' })
    const b = store.createTask({ title: 'B' })
    const gate = store.createTask({ title: 'Проверка A', gateFor: { taskId: a.id, nodeId: 'review' } })
    session(store, a.id, 'sid-a')
    session(store, gate.id, 'sid-gate')
    session(store, b.id, 'sid-b')
    const cache = new SpyCache()
    const stats = await taskStats({ ...deps(store, cache), taskId: a.id })
    assert.deepEqual(cache.seen.sort(), ['sid-a', 'sid-gate'])
    assert.equal(stats.taskId, a.id)
    assert.deepEqual(stats.usage.tokens, { input: 20, output: 40, cacheRead: 200, cacheWrite: 100 })
    assert.equal(stats.dispatches.total, 2)
  })

  it('кэш общий: повторный запрос дочитывает те же файлы через переданный кэш', async () => {
    const store = new TaskStore()
    const a = store.createTask({ title: 'A' })
    session(store, a.id, 'sid-a')
    const cache = new SpyCache()
    const first = await taskStats({ ...deps(store, cache), taskId: a.id })
    const second = await taskStats({ ...deps(store, cache), taskId: a.id })
    assert.deepEqual(second.usage.tokens, first.usage.tokens)
  })

  it('неизвестная задача — ошибка по-русски, диск не читается', async () => {
    const cache = new SpyCache()
    await assert.rejects(taskStats({ ...deps(new TaskStore(), cache), taskId: 'нет' }), /статистика: задачи нет нет в проекте/)
    assert.deepEqual(cache.seen, [])
  })
})

describe('статистика глобальной задачи в main', () => {
  it('читает координатора прогона и его подзадачи, но не чужой прогон и не задачи вне прогона', async () => {
    const store = new TaskStore()
    const run = store.createRun('цель', 'pty_c1')
    const other = store.createRun('другая', 'pty_c2')
    store.setRunPty(run.id, 'pty_c1', 'claude', { roleId: 'coordinator', agent: 'claude', sessionId: 'sid-coord' })
    store.setRunPty(other.id, 'pty_c2', 'claude', { roleId: 'coordinator', agent: 'claude', sessionId: 'sid-coord-other' })
    transcript(repo, 'sid-coord', Date.now())
    transcript(repo, 'sid-coord-other', Date.now())
    const t = store.createTask({ title: 'Подзадача', runId: run.id })
    const foreign = store.createTask({ title: 'Чужая', runId: other.id })
    const loose = store.createTask({ title: 'Вне прогона' })
    session(store, t.id, 'sid-sub')
    session(store, foreign.id, 'sid-foreign')
    session(store, loose.id, 'sid-loose')
    const cache = new SpyCache()
    const stats = await globalTaskStats({ ...deps(store, cache), runId: run.id })
    assert.deepEqual(cache.seen.sort(), ['sid-coord', 'sid-sub'])
    assert.equal(stats.runId, run.id)
    assert.equal(stats.coordinator.launches, 1)
    assert.equal(stats.subtasks.count, 1)
    assert.deepEqual(stats.usage.tokens, { input: 20, output: 40, cacheRead: 200, cacheWrite: 100 })
  })

  it('неизвестный прогон — ошибка по-русски', async () => {
    await assert.rejects(globalTaskStats({ ...deps(new TaskStore(), new SpyCache()), runId: 'нет' }), /статистика: глобальной задачи нет нет в проекте/)
  })
})
