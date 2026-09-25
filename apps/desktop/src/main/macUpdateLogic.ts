// Чистая логика macOS-установщика обновлений: разбор latest-mac.yml, выбор zip под архитектуру, сравнение версий,
// проверки путей и текст detached-скрипта подмены .app. Без electron и без обращений к сети — тестируется в node:test
// (`macUpdateLogic.test.ts`). Сеть, распаковка и запуск — в `macUpdater.ts`.
import type { UpdateUnsupportedReason } from '../shared/ipc'
import type { UpdateSupport } from './updater'

/** Репозиторий с релизами. Публичный: токен не нужен. */
export const RELEASES_REPO = { owner: 'NANDIorg', repo: 'BigOrcaCocks' } as const
/** Откуда берётся манифест: `latest` — последний опубликованный (не draft, не prerelease) релиз. */
export const LATEST_DOWNLOAD_URL = `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases/latest/download`

/** Один файл релиза из `latest-mac.yml`. `sha512` — base64, как пишет electron-builder. */
export interface UpdateFile {
  url: string
  sha512: string
  size: number | null
}

/** Манифест релиза (`latest-mac.yml`). */
export interface UpdateManifest {
  version: string
  files: UpdateFile[]
}

function unquote(v: string): string {
  const s = v.trim()
  if (s.length >= 2 && ((s[0] === "'" && s.endsWith("'")) || (s[0] === '"' && s.endsWith('"')))) return s.slice(1, -1)
  return s
}

/**
 * Разбор `latest-mac.yml` от electron-builder. Формат плоский (скаляры верхнего уровня и список `files` из скаляров),
 * поэтому полноценный YAML-парсер не нужен — core и main живут без лишних зависимостей.
 * Если `files` нет (старый формат), берётся пара `path` + `sha512` верхнего уровня.
 */
export function parseUpdateManifest(text: string): UpdateManifest {
  const top: Record<string, string> = {}
  const files: Record<string, string>[] = []
  let inFiles = false
  let cur: Record<string, string> | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const topKey = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (topKey) {
      inFiles = topKey[1] === 'files' && topKey[2].trim() === ''
      cur = null
      if (!inFiles) top[topKey[1]] = unquote(topKey[2])
      continue
    }
    if (!inFiles) continue
    const item = /^\s+-\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (item) {
      cur = { [item[1]]: unquote(item[2]) }
      files.push(cur)
      continue
    }
    const field = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (field && cur) cur[field[1]] = unquote(field[2])
  }
  if (!top.version) throw new Error('в latest-mac.yml нет поля version')
  if (!parseSemver(top.version)) throw new Error(`в latest-mac.yml версия «${top.version}» не похожа на semver`)
  const result: UpdateFile[] = []
  for (const f of files) {
    if (!f.url || !f.sha512) continue
    const size = Number(f.size)
    result.push({ url: f.url, sha512: f.sha512, size: Number.isFinite(size) && size > 0 ? size : null })
  }
  if (result.length === 0 && top.path && top.sha512) result.push({ url: top.path, sha512: top.sha512, size: null })
  return { version: top.version, files: result }
}

/**
 * Выбор zip под архитектуру процесса. Имена файлов — `${productName}-${version}-${arch}.zip` (`artifactName` в
 * electron-builder.yml): для arm64 нужен файл с «arm64», для x64 — zip без «arm64» (x64 или universal).
 * dmg и прочее игнорируются: dmg на месте не подменить. Нет подходящего — null.
 */
export function pickMacZip(files: UpdateFile[], arch: string): UpdateFile | null {
  const zips = files.filter((f) => f.url.toLowerCase().endsWith('.zip'))
  const isArm = (f: UpdateFile) => /arm64/i.test(f.url)
  if (arch === 'arm64') return zips.find(isArm) ?? null
  if (arch === 'x64') return zips.find((f) => /x64/i.test(f.url)) ?? zips.find((f) => !isArm(f)) ?? null
  return null
}

/**
 * Имя файла релиза → URL скачивания. Принимаем только простое имя: без `/`, `\`, `..` — иначе манифест мог бы
 * увести загрузку на чужой адрес или выйти из каталога загрузки.
 */
export function assetUrl(name: string): string {
  if (!name || /[\\/]/.test(name) || name.includes('..') || /[\0-\x1f]/.test(name)) {
    throw new Error(`в latest-mac.yml недопустимое имя файла «${name}»`)
  }
  return `${LATEST_DOWNLOAD_URL}/${encodeURIComponent(name)}`
}

interface Semver {
  major: number
  minor: number
  patch: number
  pre: string[]
}

/** Разбор semver (`1.2.3`, `v1.2.3-beta.1`, `+build` игнорируется); не semver — null. */
export function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

/** Сравнение по правилам semver.org: −1, 0, 1. Не semver — ошибка (лучше упасть при проверке, чем «обновить» на мусор). */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) throw new Error(`невозможно сравнить версии «${a}» и «${b}»`)
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1
    } else if (pn !== qn) {
      return pn ? -1 : 1
    } else if (p !== q) {
      return p < q ? -1 : 1
    }
  }
  return 0
}

/** `true`, если `candidate` строго новее `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** `…/orca-board.app/Contents/MacOS/orca-board` → `…/orca-board.app`; не из бандла (dev, node) — null. */
export function bundlePathFromExecPath(execPath: string): string | null {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return m ? m[1] : null
}

/**
 * По одному пути, без обращения к диску: запущено ли приложение оттуда, где его можно подменить.
 * `/Volumes/…` — смонтированный dmg (или внешний диск, с которого запускать нельзя же обновлять на месте),
 * `/AppTranslocation/` — Gatekeeper запустил копию из read-only образа.
 */
export function classifyBundlePath(bundlePath: string): UpdateUnsupportedReason | null {
  if (bundlePath.includes('/AppTranslocation/')) return 'translocated'
  if (bundlePath.startsWith('/Volumes/')) return 'not-in-applications'
  return null
}

/**
 * Поддерживается ли обновление на этом запуске. `canWrite(path)` — проверка права записи (в main — `fs.accessSync`).
 * Подмена .app требует записи и в сам бандл, и в его папку: старый .app переименовывается, новый создаётся рядом.
 * Не из бандла или `!isPackaged` — `dev`. Всё, что не «ok», — `manual-download`: человек скачивает сам.
 */
export function detectMacSupport(env: {
  isPackaged: boolean
  bundlePath: string | null
  canWrite: (p: string) => boolean
}): UpdateSupport {
  if (!env.isPackaged || !env.bundlePath) return { mode: 'auto', unsupportedReason: 'dev' }
  const byPath = classifyBundlePath(env.bundlePath)
  if (byPath) return { mode: 'manual-download', unsupportedReason: byPath }
  const parent = env.bundlePath.slice(0, env.bundlePath.lastIndexOf('/')) || '/'
  if (!env.canWrite(env.bundlePath) || !env.canWrite(parent)) {
    return { mode: 'manual-download', unsupportedReason: 'no-write-access' }
  }
  return { mode: 'auto', unsupportedReason: null }
}

/** Понятная причина по-русски для логов и ошибок main. Тексты в UI — через i18n renderer по `unsupportedReason`. */
export function macUnsupportedMessage(reason: UpdateUnsupportedReason): string {
  switch (reason) {
    case 'dev':
      return 'обновление выключено: приложение запущено из исходников'
    case 'portable':
      return 'portable-версию нельзя обновить на ходу: скачайте новую вручную'
    case 'translocated':
      return 'macOS запустила копию приложения из временного read-only образа (App Translocation). Переместите приложение в «Программы» и запустите оттуда'
    case 'not-in-applications':
      return 'приложение запущено из образа диска или с внешнего тома. Переместите приложение в «Программы» и запустите оттуда'
    case 'no-write-access':
      return 'нет прав на запись в папку с приложением. Переместите приложение в «Программы» (или в папку, где вы можете писать) и запустите оттуда'
  }
}

/** Пути установки, которые получит скрипт. */
export interface InstallPaths {
  /** Работающий `.app`, который заменяем. */
  bundle: string
  /** Каталог загрузки/распаковки версии (удаляется после успеха). */
  stage: string
  /** Новый `.app` внутри `stage`. */
  staged: string
  /** Куда уходит старый `.app` (`userData/updates/previous`). */
  previous: string
}

const within = (dir: string, p: string) => p !== dir && p.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

/**
 * Проверка путей перед запуском скрипта, который делает `rm -rf` и `mv`: всё абсолютное, без `..`, бандлы — `.app`,
 * новый лежит внутри `stage`, и ни один каталог не вложен в заменяемое приложение. Ошибка — по-русски.
 */
export function validateInstallPaths(p: InstallPaths): void {
  const all: [string, string][] = [
    ['работающее приложение', p.bundle],
    ['каталог обновления', p.stage],
    ['новое приложение', p.staged],
    ['каталог предыдущей версии', p.previous]
  ]
  for (const [label, v] of all) {
    if (!v.startsWith('/') || v.split('/').includes('..') || v.split('/').includes('.')) {
      throw new Error(`установка: путь «${label}» должен быть абсолютным и без «.»/«..»: ${v}`)
    }
    if (v.length < 2 || v.includes('\n')) throw new Error(`установка: недопустимый путь «${label}»: ${v}`)
  }
  if (!p.bundle.endsWith('.app')) throw new Error(`установка: работающее приложение не .app: ${p.bundle}`)
  if (!p.staged.endsWith('.app')) throw new Error(`установка: новое приложение не .app: ${p.staged}`)
  if (!within(p.stage, p.staged)) throw new Error(`установка: новое приложение ${p.staged} лежит вне каталога ${p.stage}`)
  for (const [label, v] of [['каталог обновления', p.stage], ['каталог предыдущей версии', p.previous], ['новое приложение', p.staged]] as const) {
    if (v === p.bundle || within(p.bundle, v)) throw new Error(`установка: «${label}» находится внутри заменяемого приложения: ${v}`)
  }
  if (p.previous === p.stage || within(p.stage, p.previous) || within(p.previous, p.stage)) {
    throw new Error('установка: каталог предыдущей версии и каталог обновления не должны пересекаться')
  }
}

/** Совпадают ли идентификатор и версия распакованного приложения с ожидаемыми. Причина по-русски или null. */
export function bundleMismatch(
  actual: { id: string; version: string },
  expected: { id: string; version: string }
): string | null {
  if (actual.id !== expected.id) {
    return `идентификатор приложения в архиве «${actual.id}» не совпадает с текущим «${expected.id}»`
  }
  if (actual.version !== expected.version) {
    return `версия приложения в архиве «${actual.version}» не совпадает с версией релиза «${expected.version}»`
  }
  return null
}

/**
 * Скрипт подмены. Запускается detached через `/bin/sh <script> <аргументы>`; пути приходят позиционными аргументами,
 * а не подставляются в текст — никакой shell-инъекции через имена файлов.
 * Аргументы: PID TARGET NEW STAGE PREVIOUS LOG.
 *  1. ждёт выхода PID (не дольше 10 минут: если человек отменил выход, скрипт молча завершается);
 *  2. переносит старый .app в PREVIOUS, копирует новый `ditto` (сохраняет подпись и атрибуты);
 *  3. при любой ошибке возвращает старый .app и запускает его;
 *  4. снимает com.apple.quarantine, чистит STAGE, `open` новое приложение.
 * Лог — в LOG (`userData/updates/install.log`).
 */
export const INSTALL_SCRIPT = `#!/bin/sh
PID="$1"; TARGET="$2"; NEW="$3"; STAGE="$4"; PREV="$5"; LOG="$6"
log() { printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
log "старт: заменяем $TARGET на $NEW, ждём выхода pid $PID"

i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then log "приложение не вышло за 10 минут — установка отменена"; exit 1; fi
  sleep 0.5
done

if [ ! -d "$NEW" ]; then log "нового приложения нет ($NEW) — установка уже выполнена или отменена"; exit 1; fi

BACKUP="$PREV/$(basename "$TARGET")"
rm -rf "$PREV" && mkdir -p "$PREV" || { log "не удалось подготовить $PREV"; exit 1; }
if ! mv "$TARGET" "$BACKUP"; then
  log "не удалось перенести старое приложение в $BACKUP — оставляем как есть"
  open "$TARGET" >> "$LOG" 2>&1
  exit 1
fi

if ! ditto "$NEW" "$TARGET" >> "$LOG" 2>&1; then
  log "ditto не сработал — возвращаем старое приложение"
  rm -rf "$TARGET"
  if mv "$BACKUP" "$TARGET"; then log "старое приложение восстановлено"; else log "ОШИБКА: старое приложение осталось в $BACKUP"; fi
  open "$TARGET" >> "$LOG" 2>&1
  exit 1
fi

xattr -dr com.apple.quarantine "$TARGET" >> "$LOG" 2>&1 || log "xattr: карантин не снят (не критично)"
rm -rf "$STAGE"
log "установлено, запускаем $TARGET"
open "$TARGET" >> "$LOG" 2>&1 || log "open вернул ошибку"
`
