/**
 * Транскрипты агентов для статистики проекта (docs/architecture.md → «Статистика → Транскрипты»): где лежат
 * сессии Claude Code и codex, разбор токенов и сопоставление сессий с dispatch. Чтение инкрементальное —
 * транскрипты большие и дописываются, поэтому итоги файла кэшируются по (путь, размер, mtime), а дописанный
 * хвост дочитывается с прошлого смещения.
 */
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionUsage, StatsSession, UsageRecord } from '@orca-board/core'

/** Где искать транскрипты: конфиги агентов. Тесты подставляют временные папки. */
export interface TranscriptEnv {
  /** `CLAUDE_CONFIG_DIR` или `~/.claude`. */
  claudeDir: string
  /** `CODEX_HOME` или `~/.codex`. */
  codexDir: string
}

export function transcriptEnv(env: NodeJS.ProcessEnv = process.env): TranscriptEnv {
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    codexDir: env.CODEX_HOME || join(homedir(), '.codex')
  }
}

/** Папка проекта Claude Code: cwd, в котором каждый символ не из `[A-Za-z0-9]` заменён на `-`. */
export function claudeSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// ---------- разбор ----------

/** Итоги одного файла транскрипта: записи расхода и то, что нужно для сопоставления сессии. */
interface ParsedFile {
  /** Реплики API по ключу `message.id:requestId` — одна реплика пишется несколькими строками. */
  records: Map<string, UsageRecord>
  firstAt?: number
  lastAt?: number
  cwd?: string
  /** Codex: id сессии из `session_meta`. */
  sessionId?: string
  /** Codex: текущая модель и накопительный счётчик — чтобы дочитанный хвост продолжил дельты. */
  model?: string
  total?: CodexTotals
}

interface CacheEntry {
  size: number
  mtimeMs: number
  /** Сколько байт разобрано: до конца последней полной строки. */
  offset: number
  parsed: ParsedFile
}

type LineParser = (line: string, file: ParsedFile, lineOffset: number) => void

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function timeOf(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

function touch(file: ParsedFile, at: number | undefined, cwd: unknown): void {
  if (at !== undefined) {
    if (file.firstAt === undefined || at < file.firstAt) file.firstAt = at
    if (file.lastAt === undefined || at > file.lastAt) file.lastAt = at
  }
  if (file.cwd === undefined && typeof cwd === 'string' && cwd) file.cwd = cwd
}

/**
 * Строка транскрипта Claude Code. Расход — у записей `type: "assistant"` в `message.usage`; `<synthetic>` —
 * локальные сообщения без обращения к API. Повтор реплики (тот же `message.id`/`requestId`) перезаписывает
 * прежнюю: у последней строки usage полный.
 */
export const parseClaudeLine: LineParser = (line, file, lineOffset) => {
  const o = obj(JSON.parse(line))
  if (!o) return
  const at = timeOf(o.timestamp)
  touch(file, at, o.cwd)
  if (o.type !== 'assistant' || at === undefined) return
  const msg = obj(o.message)
  const usage = obj(msg?.usage)
  if (!msg || !usage) return
  const model = typeof msg.model === 'string' ? msg.model : ''
  if (model === '<synthetic>') return
  const write = num(usage.cache_creation_input_tokens)
  const split = obj(usage.cache_creation)
  const write1h = split ? num(split.ephemeral_1h_input_tokens) : 0
  const write5m = split ? num(split.ephemeral_5m_input_tokens) : write
  // Деления нет или оно не сходится с общим числом — остаток считается записью на 5 минут.
  const rest = Math.max(0, write - write1h - write5m)
  const id = typeof msg.id === 'string' ? `${msg.id}:${typeof o.requestId === 'string' ? o.requestId : ''}` : `@${lineOffset}`
  file.records.set(id, {
    at,
    model,
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: write5m + rest,
    cacheWrite1h: write1h
  })
}

interface CodexTotals {
  input: number
  cached: number
  write: number
  output: number
}

/**
 * Строка rollout-файла codex. Токены — накопительные (`token_count` → `info.total_token_usage`), запись расхода —
 * прирост с прошлого события; `input_tokens` включает кэш, поэтому `input` = input − cached. Модель —
 * последний `turn_context`.
 */
export const parseCodexLine: LineParser = (line, file, lineOffset) => {
  const o = obj(JSON.parse(line))
  if (!o) return
  const at = timeOf(o.timestamp)
  const payload = obj(o.payload)
  if (o.type === 'session_meta' && payload) {
    if (typeof payload.id === 'string') file.sessionId ??= payload.id
    touch(file, timeOf(payload.timestamp), payload.cwd)
  }
  touch(file, at, undefined)
  if (o.type === 'turn_context' && typeof payload?.model === 'string') file.model = payload.model
  if (o.type !== 'event_msg' || payload?.type !== 'token_count' || at === undefined) return
  const total = obj(obj(payload.info)?.total_token_usage)
  if (!total) return
  const cur: CodexTotals = {
    input: num(total.input_tokens),
    cached: num(total.cached_input_tokens),
    write: num(total.cache_write_input_tokens),
    output: num(total.output_tokens)
  }
  const prev = file.total
  // Счётчик уменьшился — новая сессия внутри файла (или сброс): прирост считается от нуля.
  const base = prev && cur.input >= prev.input && cur.output >= prev.output ? prev : { input: 0, cached: 0, write: 0, output: 0 }
  file.total = cur
  const cached = Math.max(0, cur.cached - base.cached)
  const d = {
    input: Math.max(0, cur.input - base.input - cached),
    output: Math.max(0, cur.output - base.output),
    cacheRead: cached,
    cacheWrite5m: Math.max(0, cur.write - base.write),
    cacheWrite1h: 0
  }
  if (d.input + d.output + d.cacheRead + d.cacheWrite5m === 0) return
  file.records.set(`@${lineOffset}`, { at, model: file.model ?? '', ...d })
}

const CHUNK = 1 << 20

/**
 * Кэш разобранных транскриптов на процесс main. Файл не менялся (размер и mtime те же) — итоги из кэша;
 * вырос — дочитывается хвост с прошлого смещения; уменьшился или переписан — разбирается заново. Незаконченная
 * последняя строка (агент пишет прямо сейчас) не разбирается, пока не допишется. Битые строки пропускаются.
 */
export class TranscriptCache {
  private files = new Map<string, CacheEntry>()

  async read(path: string, parse: LineParser): Promise<ParsedFile | undefined> {
    let st
    try {
      st = await stat(path)
    } catch {
      this.files.delete(path)
      return undefined
    }
    let entry = this.files.get(path)
    if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) return entry.parsed
    if (!entry || st.size < entry.offset) entry = { size: 0, mtimeMs: 0, offset: 0, parsed: { records: new Map() } }
    try {
      entry.offset = await readLines(path, entry.offset, st.size, (line, at) => {
        try {
          parse(line, entry.parsed, at)
        } catch {
          // Битая строка (обрыв записи, чужой формат) — пропускаем, остальное считаем.
        }
      })
    } catch {
      return this.files.get(path)?.parsed
    }
    entry.size = st.size
    entry.mtimeMs = st.mtimeMs
    this.files.set(path, entry)
    return entry.parsed
  }
}

/** Читает полные строки файла с байта `from` до `to` кусками; возвращает смещение после последней полной строки. */
async function readLines(path: string, from: number, to: number, onLine: (line: string, offset: number) => void): Promise<number> {
  const fh = await open(path, 'r')
  try {
    let pos = from
    let carry = Buffer.alloc(0)
    let carryStart = from
    while (pos < to) {
      const buf = Buffer.alloc(Math.min(CHUNK, to - pos))
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      let start = 0
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = data.toString('utf8', start, nl).trim()
        if (line) onLine(line, carryStart + start)
        start = nl + 1
      }
      carry = Buffer.from(data.subarray(start))
      carryStart += start
    }
    return carryStart
  } finally {
    await fh.close()
  }
}

// ---------- поиск и сопоставление ----------

/** Контекст сбора: окружение, кэш и где работала каждая задача. */
export interface UsageContext {
  env: TranscriptEnv
  cache: TranscriptCache
  /** Корень репозитория проекта — cwd координатора. */
  repoRoot: string
  /** cwd воркера задачи (worktree); нет — `<repo>/../.orca-worktrees/<taskId>`. */
  worktree(taskId: string): string
  now: number
  /** Читать ли транскрипт сессии (сессии вне периода не читаются); нет — все. Окна dispatch считаются по всем. */
  include?: (s: StatsSession) => boolean
}

/** Итог сбора: расход по ключу сессии и id сессий, найденные по cwd и времени (их стоит запомнить в store). */
export interface CollectedUsage {
  usage: Map<string, SessionUsage>
  found: Map<string, string>
}

/** Запас до старта dispatch: первое сообщение агента может быть записано чуть раньше отметки store. */
const START_SLACK_MS = 60_000

function toUsage(files: ParsedFile[]): SessionUsage {
  const records: UsageRecord[] = []
  let lastAt: number | undefined
  for (const f of files) {
    records.push(...f.records.values())
    if (f.lastAt !== undefined && (lastAt === undefined || f.lastAt > lastAt)) lastAt = f.lastAt
  }
  return { records, ...(lastAt !== undefined ? { lastAt } : {}) }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Варианты папки проекта Claude Code для cwd: как есть и после разрешения симлинков (`/tmp` → `/private/tmp`). */
async function claudeDirsFor(env: TranscriptEnv, cwd: string): Promise<string[]> {
  const projects = join(env.claudeDir, 'projects')
  const paths = [resolve(cwd)]
  try {
    const real = await realpath(cwd)
    if (!paths.includes(real)) paths.push(real)
  } catch {
    // worktree уже удалён — остаётся путь как есть
  }
  return paths.map((p) => join(projects, claudeSlug(p)))
}

/** Файлы сессии Claude Code: основной `<sid>.jsonl` и сабагенты `<sid>/subagents/*.jsonl` рядом с ним. */
async function claudeSessionFiles(dir: string, sid: string): Promise<string[]> {
  const main = join(dir, `${sid}.jsonl`)
  if (!(await exists(main))) return []
  const sub = join(dir, sid, 'subagents')
  const subs = (await listDir(sub)).filter((f) => f.endsWith('.jsonl')).map((f) => join(sub, f))
  return [main, ...subs]
}

/**
 * Файлы сессии `sid`: сначала папка по slug cwd, иначе — все папки `projects/` (очень длинные пути Claude Code
 * укорачивает, и slug не совпадёт).
 */
async function findClaudeSession(env: TranscriptEnv, cwd: string, sid: string): Promise<string[]> {
  for (const dir of await claudeDirsFor(env, cwd)) {
    const files = await claudeSessionFiles(dir, sid)
    if (files.length) return files
  }
  const projects = join(env.claudeDir, 'projects')
  for (const name of await listDir(projects)) {
    const files = await claudeSessionFiles(join(projects, name), sid)
    if (files.length) return files
  }
  return []
}

async function readAll(cache: TranscriptCache, paths: string[], parse: LineParser): Promise<ParsedFile[]> {
  const out: ParsedFile[] = []
  for (const p of paths) {
    const f = await cache.read(p, parse)
    if (f) out.push(f)
  }
  return out
}

/** Окно dispatch для сопоставления по времени: от старта до старта следующего dispatch той же задачи. */
function windows(sessions: StatsSession[]): Map<string, { from: number; to: number }> {
  const byTask = new Map<string, StatsSession[]>()
  for (const s of sessions) if (s.kind === 'dispatch' && s.taskId) byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s])
  const out = new Map<string, { from: number; to: number }>()
  for (const list of byTask.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt)
    list.forEach((s, i) => out.set(s.key, { from: s.startedAt - START_SLACK_MS, to: list[i + 1]?.startedAt ?? Infinity }))
  }
  return out
}

/**
 * Claude Code без `sessionId` (dispatch от кода до статистики): все сессии папки worktree — сессии задачи;
 * сессия относится к dispatch, в окно которого попало её первое сообщение.
 */
async function claudeByWorktree(ctx: UsageContext, list: StatsSession[], win: Map<string, { from: number; to: number }>, out: CollectedUsage): Promise<void> {
  const byTask = new Map<string, StatsSession[]>()
  for (const s of list) if (s.taskId) byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s])
  for (const [taskId, tasks] of byTask) {
    const matched = new Map<string, ParsedFile[]>()
    for (const dir of await claudeDirsFor(ctx.env, ctx.worktree(taskId))) {
      for (const name of await listDir(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const sid = name.slice(0, -'.jsonl'.length)
        const files = await readAll(ctx.cache, await claudeSessionFiles(dir, sid), parseClaudeLine)
        const first = files[0]?.firstAt
        if (first === undefined) continue
        const s = tasks.find((t) => {
          const w = win.get(t.key)
          return w !== undefined && first >= w.from && first < w.to
        })
        if (s) matched.set(s.key, [...(matched.get(s.key) ?? []), ...files])
      }
    }
    for (const [key, files] of matched) out.usage.set(key, toUsage(files))
  }
}

/** Папки дат codex (`sessions/YYYY/MM/DD`, локальная дата) от дня до старта до дня после конца окна. */
function codexDayDirs(env: TranscriptEnv, from: number, to: number): string[] {
  const dirs: string[] = []
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = new Date(from - 24 * 3600_000)
  day.setHours(0, 0, 0, 0)
  const end = to + 24 * 3600_000
  for (let i = 0; day.getTime() <= end && i < 400; i++) {
    dirs.push(join(env.codexDir, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())))
    day.setDate(day.getDate() + 1)
  }
  return dirs
}

async function sameDir(a: string | undefined, b: string): Promise<boolean> {
  if (!a) return false
  if (resolve(a) === resolve(b)) return true
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return false
  }
}

/**
 * Codex: id сессии заранее не задать. Известный id — файл `rollout-*-<id>.jsonl` в папках дат окна; неизвестный —
 * rollout, чей `session_meta` начат в worktree задачи в окне dispatch (найденный id уходит в `found`).
 */
async function codexSession(ctx: UsageContext, s: StatsSession, win: { from: number; to: number } | undefined, out: CollectedUsage): Promise<void> {
  if (!s.taskId) return
  const from = win?.from ?? s.startedAt - START_SLACK_MS
  const to = Math.min(win?.to ?? Infinity, s.endedAt ?? ctx.now, ctx.now)
  const cwd = ctx.worktree(s.taskId)
  for (const dir of codexDayDirs(ctx.env, from, to)) {
    for (const name of await listDir(dir)) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      if (s.sessionId && !name.endsWith(`${s.sessionId}.jsonl`)) continue
      const f = await ctx.cache.read(join(dir, name), parseCodexLine)
      if (!f) continue
      if (!s.sessionId) {
        const start = f.firstAt
        if (start === undefined || start < from || start >= (win?.to ?? Infinity) || !(await sameDir(f.cwd, cwd))) continue
        if (f.sessionId) out.found.set(s.key, f.sessionId)
      }
      out.usage.set(s.key, toUsage([f]))
      return
    }
  }
}

/**
 * Расход сессий проекта по транскриптам. Claude Code — по `sessionId` (координатор и воркер) или, у старых
 * dispatch, по папке worktree и времени; codex — по id или cwd и времени; остальные агенты — нет данных.
 * Координатор без `sessionId` не сопоставляется: его cwd — корень репозитория, там же сессии человека.
 */
export async function collectSessionUsage(sessions: StatsSession[], ctx: UsageContext): Promise<CollectedUsage> {
  const out: CollectedUsage = { usage: new Map(), found: new Map() }
  const win = windows(sessions)
  const legacyClaude: StatsSession[] = []
  for (const s of sessions) {
    if (ctx.include && !ctx.include(s)) continue
    if (s.agent === 'claude') {
      if (s.sessionId) {
        const cwd = s.kind === 'coordinator' || !s.taskId ? ctx.repoRoot : ctx.worktree(s.taskId)
        const files = await readAll(ctx.cache, await findClaudeSession(ctx.env, cwd, s.sessionId), parseClaudeLine)
        if (files.length) out.usage.set(s.key, toUsage(files))
      } else if (s.kind === 'dispatch') legacyClaude.push(s)
    } else if (s.agent === 'codex' && s.kind === 'dispatch') {
      await codexSession(ctx, s, win.get(s.key), out)
    }
  }
  if (legacyClaude.length) await claudeByWorktree(ctx, legacyClaude, win, out)
  return out
}

