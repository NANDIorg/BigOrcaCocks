/**
 * Снимок показа человеку (`Dispatch.showcase.snapshot`, docs/workflow.md → «Показ человеку»).
 *
 * При `orca-board done` main копирует файлы показа из worktree задачи в `<userData>/showcase/<projectId>/<runId>/<dispatchId>/`:
 * worktree убирается при мерже подзадачи, а человек смотрит показ позже — на ноде `human` прогона. Снимок не в
 * репозитории пользователя (не попадает в `git status`) и живёт до удаления глобальной задачи или проекта.
 *
 * Пути приходят от агента (не доверенного): каждый файл проверяется по реальному пути внутри worktree, по белому
 * списку расширений (`shared/showcase.ts`) и по лимитам. Ошибка — текстом для агента: он увидит её в ответе `done`
 * и исправит сдачу, а не человек потом «файл не найден». Функции принимают корни явно (без electron), чтобы
 * тестироваться во временной папке.
 */
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, posix, resolve } from 'node:path'
import {
  MAX_SHOWCASE_SNAPSHOT_BYTES, MAX_SHOWCASE_SNAPSHOT_FILES, MAX_SHOWCASE_SNAPSHOT_FILE_BYTES, type ShowcaseSnapshot, type TaskStore
} from '@orca-board/core'
import { SHOWCASE_FILE_TYPES, isAssetType, isEntryType, showcaseFileType } from '../shared/showcase'
import { isInside } from './docs'
import { showcaseSnapshotDir, safeArtifactId as safe } from '@orca-board/runtime'
export { showcaseSnapshotsRoot, showcaseSnapshotDir, removeShowcaseDir } from '@orca-board/runtime'

/** Каталоги, которые при раскрытии папки не обходятся: зависимости и служебное. Скрытые (с точки) — тоже. */
const SKIP_DIRS = new Set(['node_modules'])
/** Ссылки страницы на ассеты: атрибуты src/href, `url(...)` и `@import "..."` в css — разбор best-effort. */
const REF_PATTERNS = [/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi, /url\(\s*["']?([^"')]+?)["']?\s*\)/gi, /@import\s+["']([^"']+)["']/gi]
/**
 * Картинки markdown: `![alt](path)`, `![alt](<path с пробелами>)`, с заголовком `"..."`, и ссылки-определения
 * `[id]: path` для `![alt][id]`. Плюс `src=`/`href=` из HTML внутри markdown (REF_PATTERNS). Разбор best-effort.
 */
const MD_REF_PATTERNS = [/!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g, /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gm]
/** Путь «файла» описания показа (`--show-file`) для разрешения его ссылок: описание лежит как бы в корне репозитория. */
const TEXT_REL = 'showcase.md'

const mb = (bytes: number): number => bytes / 1024 / 1024

/** Где лежат снимки показа: корень `<userData>/showcase` и проект, чей это store. */
export interface ShowcaseSnapshots {
  root: string
  projectId: string
}

/** Файл снимка: `rel` — путь в снимке (как в репозитории, через `/`), `src` — реальный путь в worktree. */
export interface SnapshotFile {
  rel: string
  src: string
  size: number
}

/** Что снять: точки входа для человека (`DispatchShowcase.files`) и все файлы снимка вместе с ассетами. */
export interface SnapshotPlan {
  entries: string[]
  files: SnapshotFile[]
  bytes: number
}

const ALLOWED_HINT = `разрешены ${Object.keys(SHOWCASE_FILE_TYPES).join(' ')}; стили, скрипты и шрифты страниц HTML попадают в показ сами`

/**
 * Собирает список файлов снимка из путей `--show` (уже нормализованных `normalizeShowcase`: относительные, без `..`).
 *
 * - Файл — точка входа из белого списка; ассет (`.css`, `.js`…) принимается, но списком человеку не показывается.
 * - Папка раскрывается в файлы белого списка по порядку имён, без скрытых, `node_modules` и симлинков; точки входа
 *   идут в список, ассеты — только в снимок.
 * - Для каждой страницы HTML в снимок best-effort добавляются её ссылки (`src`/`href`/`url()`/`@import`, в том числе
 *   `../`) внутри worktree, затем её каталог со всеми подкаталогами — пока хватает лимитов: страница не должна
 *   остаться без стилей, даже если агент их не перечислил. Ассеты сверх лимитов молча пропускаются.
 * - У markdown-файлов и описания показа `text` (`--show-file`, его пути — от корня репозитория) — так же best-effort
 *   только их ссылки (`![alt](path)`, `src=`/`href=`): без картинок md в просмотрщике показывается с битыми рамками.
 *   Каталог md целиком не тянется. Найденное — ассеты снимка, не точки входа.
 *
 * Ошибка (текст для агента) — файла нет, путь или симлинк выходит из worktree, тип не из белого списка, файл или
 * заявленное целиком больше лимитов, в папке нечего показать.
 */
export function planShowcaseSnapshot(worktree: string, declared: readonly string[], text?: string): SnapshotPlan {
  const root = realpathSync(worktree)
  const entries: string[] = []
  const files = new Map<string, SnapshotFile>()
  let bytes = 0

  /** Добавить файл; `strict` — заявлен агентом: лимит — ошибка; иначе ассет best-effort: не влез — false. */
  const add = (rel: string, src: string, size: number, strict: boolean): boolean => {
    if (files.has(rel)) return true
    const problem = size > MAX_SHOWCASE_SNAPSHOT_FILE_BYTES
      ? `файл показа «${rel}» больше ${mb(MAX_SHOWCASE_SNAPSHOT_FILE_BYTES)} МБ — сожми его или покажи уменьшенную копию`
      : files.size + 1 > MAX_SHOWCASE_SNAPSHOT_FILES
        ? `в показе больше ${MAX_SHOWCASE_SNAPSHOT_FILES} файлов — сдай папку поменьше или главные файлы по одному`
        : bytes + size > MAX_SHOWCASE_SNAPSHOT_BYTES
          ? `показ больше ${mb(MAX_SHOWCASE_SNAPSHOT_BYTES)} МБ — оставь главные файлы`
          : undefined
    if (problem) {
      if (strict) throw new Error(problem)
      return false
    }
    files.set(rel, { rel, src, size })
    bytes += size
    return true
  }
  const entry = (rel: string): void => {
    if (!entries.includes(rel)) entries.push(rel)
  }

  for (const raw of declared) {
    // `./design/` и `design` — одно и то же; в снимке и в списке пути без `./` и `/` на конце.
    const rel = posix.normalize(raw).replace(/\/+$/, '') || '.'
    if (rel !== '.' && rel.split('/').some((s) => s.startsWith('.'))) {
      throw new Error(`файл показа «${raw}»: скрытые файлы и папки (с точки) не показываются`)
    }
    const abs = resolve(root, rel)
    if (!isInside(root, abs)) throw new Error(`файл показа «${rel}»: путь вне репозитория задачи`)
    let real: string
    try {
      real = realpathSync(abs)
    } catch {
      throw new Error(`файл показа «${rel}» не найден в worktree задачи — проверь путь от корня репозитория или убери --show`)
    }
    if (!isInside(root, real)) throw new Error(`файл показа «${rel}»: симлинк ведёт за пределы репозитория задачи — сдай сам файл`)
    const st = statSync(real)
    if (st.isDirectory()) {
      const before = entries.length
      for (const f of walk(real, rel)) {
        if (!isEntryType(f.rel) && !isAssetType(f.rel)) continue
        add(f.rel, f.src, f.size, true)
        if (isEntryType(f.rel)) entry(f.rel)
      }
      if (entries.length === before) throw new Error(`в папке показа «${rel}» нет файлов для показа: ${ALLOWED_HINT}`)
      continue
    }
    if (!st.isFile()) throw new Error(`файл показа «${rel}»: не файл и не папка`)
    // Тип — по заявленному пути и по реальному: симлинк `a.png → run.sh` не проходит.
    const isEntry = isEntryType(rel) && isEntryType(real)
    const isAsset = isAssetType(rel) && isAssetType(real)
    if (!isEntry && !isAsset) throw new Error(`файл показа «${rel}»: такой тип приложение не показывает — ${ALLOWED_HINT}`)
    add(rel, real, st.size, true)
    if (isEntry) entry(rel)
  }

  collectPageAssets(root, [...files.values()], add)
  if (text) for (const ref of markdownRefs(text)) addRef(root, TEXT_REL, ref, add)
  return { entries, files: [...files.values()], bytes }
}

/** Файлы папки `dir` (реальный путь) рекурсивно по порядку имён: без скрытых, `node_modules` и симлинков. */
function walk(dir: string, relDir: string): SnapshotFile[] {
  const out: SnapshotFile[] = []
  const names = readdirSync(dir).sort()
  for (const name of names) {
    if (name.startsWith('.')) continue
    const src = join(dir, name)
    const rel = relDir === '' || relDir === '.' ? name : posix.join(relDir, name)
    const st = lstatSync(src)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(src, rel))
    } else if (st.isFile()) out.push({ rel, src, size: st.size })
  }
  return out
}

type AddFile = (rel: string, src: string, size: number, strict: boolean) => boolean

/** Ссылка `ref` из `fromRel` → ассет снимка best-effort; добавленный файл возвращается (css разбирается дальше). */
function addRef(root: string, fromRel: string, ref: string, add: AddFile): SnapshotFile | undefined {
  const target = resolveRef(root, fromRel, ref)
  return target && add(target.rel, target.src, target.size, false) ? target : undefined
}

const isMarkdown = (rel: string): boolean => showcaseFileType(rel)?.preview === 'markdown'

/**
 * Ассеты страниц HTML и markdown: сначала то, на что страницы, их css и md ссылаются явно (ссылки css тоже
 * разбираются), потом соседи по каталогу страницы HTML. Страница в корне репозитория весь репозиторий не тянет —
 * только свои ссылки; markdown соседей не тянет вовсе. Ссылки md на другие md не разбираются: показ — то, что сдано.
 */
function collectPageAssets(root: string, initial: SnapshotFile[], add: AddFile): void {
  const pages = initial.filter((f) => showcaseFileType(f.rel)?.preview === 'html')
  const queue = initial.filter((f) => showcaseFileType(f.rel)?.preview === 'html' || isMarkdown(f.rel) || /\.css$/i.test(f.rel))
  const parsed = new Set<string>()
  while (queue.length > 0) {
    const f = queue.shift()!
    if (parsed.has(f.rel)) continue
    parsed.add(f.rel)
    const text = fileText(f.src)
    if (text === undefined) continue
    for (const ref of isMarkdown(f.rel) ? markdownRefs(text) : pageRefs(text)) {
      const target = addRef(root, f.rel, ref, add)
      if (target && /\.css$/i.test(target.rel)) queue.push(target)
    }
  }
  for (const page of pages) {
    const relDir = posix.dirname(page.rel)
    if (relDir === '.') continue
    for (const f of walk(join(root, ...relDir.split('/')), relDir)) {
      if ((isEntryType(f.rel) || isAssetType(f.rel)) && isInside(root, realpathSync(f.src))) add(f.rel, f.src, f.size, false)
    }
  }
}

/** Текст файла для разбора ссылок; не читается или слишком большой — undefined (разбор best-effort). */
function fileText(src: string): string | undefined {
  try {
    if (statSync(src).size > MAX_SHOWCASE_SNAPSHOT_FILE_BYTES) return undefined
    return readFileSync(src, 'utf8')
  } catch {
    return undefined
  }
}

/** Ссылки из html/css. */
function pageRefs(text: string): string[] {
  const refs: string[] = []
  for (const re of REF_PATTERNS) for (const m of text.matchAll(re)) refs.push(m[1].trim())
  return refs
}

/** Ссылки из markdown: картинки и определения ссылок плюс `src=`/`href=` встроенного HTML. */
export function markdownRefs(text: string): string[] {
  const refs = pageRefs(text)
  for (const re of MD_REF_PATTERNS) for (const m of text.matchAll(re)) refs.push((m[1] ?? m[2]).trim())
  return refs
}

/**
 * Ссылка `ref` из файла `fromRel` → файл снимка. Внешние адреса (`https:`, `//`, `data:`), якоря и абсолютные
 * пути пропускаются; путь вне репозитория (в том числе через симлинк), не файл, тип не из белого списка — тоже.
 */
function resolveRef(root: string, fromRel: string, ref: string): SnapshotFile | undefined {
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('/') || ref.startsWith('#') || ref.startsWith('\\')) return undefined
  let clean: string
  try {
    clean = decodeURI(ref.split(/[?#]/)[0])
  } catch {
    return undefined
  }
  if (!clean || clean.includes('\0')) return undefined
  const rel = posix.normalize(posix.join(posix.dirname(fromRel), clean))
  if (rel.startsWith('../') || rel === '..' || rel.split('/').some((s) => s.startsWith('.'))) return undefined
  if (!isEntryType(rel) && !isAssetType(rel)) return undefined
  const abs = resolve(root, ...rel.split('/'))
  if (!isInside(root, abs)) return undefined
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink() || !st.isFile()) return undefined
    return { rel, src: abs, size: st.size }
  } catch {
    return undefined
  }
}

/** Снимок, записанный во временную папку: `commit` ставит его на место, `discard` убирает. */
export interface PreparedSnapshot {
  /** Точки входа — `DispatchShowcase.files`. */
  files: string[]
  snapshot: ShowcaseSnapshot
  commit(): void
  discard(): void
}

/**
 * Копирует файлы плана во временную папку рядом с `dest`. На место (`commit`) она встаёт одним `rename`, поэтому
 * «половинного» снимка не бывает: сбой копирования убирает временную папку и бросает ошибку, прежний снимок в `dest`
 * остаётся нетронутым до `commit`.
 */
export function writeShowcaseSnapshot(plan: SnapshotPlan, dest: string, now = Date.now()): PreparedSnapshot {
  const tmp = `${dest}.tmp-${randomBytes(6).toString('hex')}`
  try {
    mkdirSync(tmp, { recursive: true, mode: 0o700 })
    for (const f of plan.files) {
      const to = join(tmp, ...f.rel.split('/'))
      // Пути — из проверенного плана, но проверяем ещё раз: из временной папки выйти нельзя.
      if (!isInside(tmp, to)) throw new Error(`недопустимый путь «${f.rel}»`)
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
      copyFileSync(f.src, to, constants.COPYFILE_EXCL)
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`не удалось снять показ: ${(e as Error).message}`)
  }
  let done = false
  return {
    files: plan.entries,
    snapshot: { at: now, files: plan.files.length, bytes: plan.bytes },
    commit() {
      if (done) return
      done = true
      try {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        renameSync(tmp, dest)
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true })
        throw e
      }
    },
    discard() {
      if (done) return
      done = true
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/**
 * Снимок показа запуска `dispatchId` для `worker.done` (`ProjectDeps.snapshotShowcase`): файлы из worktree его задачи
 * во временную папку рядом с `showcaseSnapshotDir`. `text` — описание показа: его картинки тоже попадают в снимок.
 * Нет worktree на диске — ошибка агенту, если заявлены файлы (взять неоткуда); у одного описания картинки best-effort,
 * поэтому без worktree или без найденных картинок снимка нет — undefined.
 */
export function snapshotDispatchShowcase(
  store: TaskStore, snapshots: ShowcaseSnapshots, dispatchId: string, declared: readonly string[], text?: string, now = Date.now()
): PreparedSnapshot | undefined {
  const dispatch = store.getDispatch(dispatchId)
  const task = dispatch ? store.getTask(dispatch.taskId) : undefined
  if (!dispatch || !task) throw new Error(`dispatch not found: ${dispatchId}`)
  if (!task.worktree || !existsSync(task.worktree)) {
    if (declared.length === 0) return undefined
    throw new Error('у задачи нет worktree на диске — файлы показа взять неоткуда: сдай done без --show или опиши результат в --show-file')
  }
  const plan = planShowcaseSnapshot(task.worktree, declared, text)
  if (plan.files.length === 0) return undefined
  const dest = showcaseSnapshotDir(snapshots.root, snapshots.projectId, task.runId, dispatch.id)
  return writeShowcaseSnapshot(plan, dest, now)
}
