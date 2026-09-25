// macOS-бэкенд обновления (`PlatformUpdater`): свой установщик вместо Squirrel.Mac, который не работает с ad-hoc подписью.
// check — latest-mac.yml из GitHub Releases; download — zip в userData/updates/, sha512, распаковка `ditto`, `codesign`,
// сверка CFBundleIdentifier и версии; install — detached-скрипт, который после выхода подменяет .app и перезапускает его.
// Модуль не импортирует electron: всё окружение приходит в `MacUpdaterEnv` (`macUpdaterEnv()` собирает его из `app`/`net`),
// поэтому класс тестируется в node:test с подставными fetch/run. Чистая логика — в `macUpdateLogic.ts`.
// См. docs/architecture.md → «Обновление» (macOS).
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { once } from 'node:events'
import type { WriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { join } from 'node:path'
import type { UpdateInfo } from '../shared/ipc'
import type { PlatformUpdater, UpdateSupport } from './updater'
import {
  INSTALL_SCRIPT,
  LATEST_DOWNLOAD_URL,
  RELEASES_REPO,
  assetUrl,
  bundleMismatch,
  bundlePathFromExecPath,
  detectMacSupport,
  isNewerVersion,
  parseUpdateManifest,
  pickMacZip,
  releaseTag,
  validateInstallPaths,
  type UpdateFile
} from './macUpdateLogic'

/** Запрос: `fetch` из Node или `net.fetch` из electron (последний учитывает системный прокси). */
export type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

/** Внешние зависимости бэкенда. В тестах подставляются фейки. */
export interface MacUpdaterEnv {
  /** `app.getVersion()`. */
  version: string
  /** `process.arch`: `arm64` | `x64`. */
  arch: string
  /** Путь к работающему `.app`. */
  bundlePath: string
  /** `app.getPath('userData')`. */
  userData: string
  /** PID процесса, выход которого ждёт скрипт. */
  pid: number
  fetch: FetchFn
  /** Внешняя команда БЕЗ shell (`execFile` с массивом аргументов); возвращает stdout, при ненулевом коде бросает. */
  run: (file: string, args: string[]) => Promise<string>
  /** Запустить процесс отдельно от приложения (переживает его выход); резолвится, когда процесс стартовал. */
  spawnDetached: (file: string, args: string[]) => Promise<void>
}

const REQUEST_TIMEOUT_MS = 30_000
/** Скачивание считается зависшим, если данных нет столько времени. */
const DOWNLOAD_STALL_MS = 60_000
const UA = 'orca-board-updater'

const updatesDir = (userData: string) => join(userData, 'updates')

/** Ошибка сети/протокола в понятной по-русски форме; исходный текст сохраняется в конце. */
function netError(what: string, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : ''
  return new Error(`${what}: ${msg}${cause}`)
}

/** GET с таймаутом; не-2xx — ошибка. */
async function getWithTimeout(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetchFn(url, { signal: ctl.signal, headers: { 'User-Agent': UA, ...headers } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  } finally {
    clearTimeout(timer)
  }
}

/** Скачать файл на диск, считая sha512 на лету. Прогресс — целые проценты, только при смене значения. */
async function downloadFile(
  fetchFn: FetchFn,
  url: string,
  dest: string,
  expectedSize: number | null,
  onProgress: (percent: number) => void
): Promise<{ sha512: string; bytes: number }> {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => ctl.abort(), DOWNLOAD_STALL_MS)
  }
  arm()
  let out: WriteStream | null = null
  try {
    const res = await fetchFn(url, { signal: ctl.signal, headers: { 'User-Agent': UA } })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    // Файл открываем только после успешного ответа; ошибку записи (диск полон) ловим, а не роняем процесс.
    const file = createWriteStream(dest)
    out = file
    let writeError: Error | null = null
    file.on('error', (e) => {
      writeError = e
    })
    const headerSize = Number(res.headers.get('content-length'))
    const total = headerSize > 0 ? headerSize : (expectedSize ?? 0)
    const hash = createHash('sha512')
    let bytes = 0
    let last = -1
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      arm()
      hash.update(chunk)
      bytes += chunk.byteLength
      if (writeError) throw writeError
      if (!file.write(chunk)) await once(file, 'drain')
      if (total > 0) {
        const pct = Math.min(100, Math.floor((bytes / total) * 100))
        if (pct !== last) {
          last = pct
          onProgress(pct)
        }
      }
    }
    file.end()
    await finished(file)
    return { sha512: hash.digest('base64'), bytes }
  } catch (e) {
    out?.destroy()
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Ищет `*.app` на верхнем уровне каталога. */
function findApp(dir: string): string | null {
  const app = readdirSync(dir).find((n) => n.endsWith('.app'))
  return app ? join(dir, app) : null
}

/** Что известно о найденной версии после `check()`. */
interface Found {
  version: string
  file: UpdateFile
}

/** Скачанное, проверенное и распакованное обновление, готовое к подмене. */
interface Staged {
  version: string
  stage: string
  app: string
}

export class MacUpdater implements PlatformUpdater {
  private found: Found | null = null
  private staged: Staged | null = null
  /** install.sh уже запущен: второй скрипт гонялся бы с первым за `previous/` и .app. */
  private installLaunched = false

  constructor(private env: MacUpdaterEnv) {}

  async check(): Promise<UpdateInfo | null> {
    let manifestText: string
    try {
      manifestText = await (await getWithTimeout(this.env.fetch, `${LATEST_DOWNLOAD_URL}/latest-mac.yml`)).text()
    } catch (e) {
      throw netError('не удалось получить список обновлений (latest-mac.yml из GitHub Releases)', e)
    }
    const manifest = parseUpdateManifest(manifestText)
    this.found = null
    this.staged = null
    if (!isNewerVersion(manifest.version, this.env.version)) return null
    const file = pickMacZip(manifest.files, this.env.arch)
    if (!file) throw new Error(`в релизе ${manifest.version} нет zip-сборки для macOS (${this.env.arch})`)
    this.found = { version: manifest.version, file }
    const release = await this.fetchRelease(manifest.version)
    return { version: manifest.version, releaseNotes: release.notes, releaseUrl: release.url }
  }

  async download(onProgress: (percent: number) => void): Promise<void> {
    if (!this.found) throw new Error('обновление не найдено: сначала нужна проверка обновлений')
    const { version, file } = this.found
    this.staged = null
    const root = updatesDir(this.env.userData)
    const stage = join(root, `${version}-${this.env.arch}`)
    this.cleanupStaging()
    mkdirSync(stage, { recursive: true })

    const zip = join(stage, 'update.zip')
    const url = assetUrl(file.url, version)
    onProgress(0)
    let got: { sha512: string; bytes: number }
    try {
      got = await downloadFile(this.env.fetch, url, `${zip}.part`, file.size, onProgress)
    } catch (e) {
      rmSync(stage, { recursive: true, force: true })
      throw netError(`не удалось скачать обновление ${version}`, e)
    }
    if (got.sha512 !== file.sha512 || (file.size !== null && got.bytes !== file.size)) {
      rmSync(stage, { recursive: true, force: true })
      throw new Error(`скачанный файл обновления ${version} повреждён: контрольная сумма sha512 не совпала с манифестом релиза`)
    }
    renameSync(`${zip}.part`, zip)

    try {
      const unpacked = join(stage, 'unpacked')
      await this.env.run('ditto', ['-x', '-k', zip, unpacked])
      const app = findApp(unpacked)
      if (!app) throw new Error('в архиве нет приложения (.app)')
      await this.verifyBundle(app, version)
      rmSync(zip, { force: true })
      this.staged = { version, stage, app }
    } catch (e) {
      rmSync(stage, { recursive: true, force: true })
      throw new Error(`обновление ${version} не прошло проверку: ${e instanceof Error ? e.message : String(e)}`)
    }
    onProgress(100)
  }

  async install(): Promise<void> {
    // Скрипт уже ждёт выхода приложения и сам всё подменит; повторный запуск — только гонка (см. lock в INSTALL_SCRIPT).
    if (this.installLaunched) return
    const staged = this.staged
    if (!staged) throw new Error('обновление не скачано: установить нечего')
    if (!existsSync(staged.app)) throw new Error('скачанное обновление пропало с диска: скачайте его заново')
    const root = updatesDir(this.env.userData)
    const paths = { bundle: this.env.bundlePath, stage: staged.stage, staged: staged.app, previous: join(root, 'previous') }
    validateInstallPaths(paths)
    const log = join(root, 'install.log')
    const script = join(root, 'install.sh')
    writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 })
    // Маркер для «Обновлено до …» после перезапуска (consumeJustUpdated).
    writeFileSync(join(root, 'pending.json'), JSON.stringify({ from: this.env.version, to: staged.version }))
    appendFileSync(log, `${new Date().toISOString()} готовим установку ${this.env.version} → ${staged.version}\n`)
    try {
      await this.env.spawnDetached('/bin/sh', [script, String(this.env.pid), paths.bundle, paths.staged, paths.stage, paths.previous, log])
    } catch (e) {
      throw netError('не удалось запустить установщик обновления', e)
    }
    this.installLaunched = true
  }

  /**
   * Версия, с которой обновились, — если это запуск сразу после успешной установки; иначе null.
   * Заодно убирает маркер и остатки скачивания. Отдаёт один раз. Неудавшаяся установка (маркер есть, версия старая) —
   * маркер сбрасывается, причина в install.log.
   */
  consumeJustUpdated(): string | null {
    const file = join(updatesDir(this.env.userData), 'pending.json')
    if (!existsSync(file)) return null
    let from: string | null = null
    try {
      const p = JSON.parse(readFileSync(file, 'utf8')) as { from?: unknown; to?: unknown }
      if (typeof p.from === 'string' && p.to === this.env.version) from = p.from
    } catch {
      // Повреждённый маркер — как будто его нет.
    }
    rmSync(file, { force: true })
    if (from) this.cleanupStaging()
    return from
  }

  /** Метаданные релиза из публичного API. Любая ошибка — пустые заметки и ссылка на страницу релиза: сеть не должна ломать проверку. */
  private async fetchRelease(version: string): Promise<{ notes: string; url: string }> {
    const tag = releaseTag(version)
    const fallbackUrl = `https://github.com/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases/tag/${tag}`
    try {
      const res = await getWithTimeout(
        this.env.fetch,
        `https://api.github.com/repos/${RELEASES_REPO.owner}/${RELEASES_REPO.repo}/releases/tags/${tag}`,
        { Accept: 'application/vnd.github+json' }
      )
      const body = (await res.json()) as { body?: unknown; html_url?: unknown }
      return {
        notes: typeof body.body === 'string' ? body.body : '',
        url: typeof body.html_url === 'string' && body.html_url.startsWith('https://') ? body.html_url : fallbackUrl
      }
    } catch {
      return { notes: '', url: fallbackUrl }
    }
  }

  /** Подпись, идентификатор и версия распакованного приложения. Бросает с причиной. */
  private async verifyBundle(app: string, version: string): Promise<void> {
    await this.env.run('codesign', ['--verify', '--deep', '--strict', app])
    const plistValue = async (bundle: string, key: string) =>
      (await this.env.run('plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])).trim()
    const actual = { id: await plistValue(app, 'CFBundleIdentifier'), version: await plistValue(app, 'CFBundleShortVersionString') }
    const current = { id: await plistValue(this.env.bundlePath, 'CFBundleIdentifier'), version }
    const mismatch = bundleMismatch(actual, current)
    if (mismatch) throw new Error(mismatch)
  }

  /** Стирает все каталоги загрузок прошлых попыток; `previous/` и `install.log` не трогает. */
  private cleanupStaging(): void {
    const root = updatesDir(this.env.userData)
    if (!existsSync(root)) return
    for (const name of readdirSync(root)) {
      if (/^\d+\.\d+\.\d+.*-(arm64|x64)$/.test(name)) rmSync(join(root, name), { recursive: true, force: true })
    }
  }
}

const execFileText = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${err.message}${stderr ? `: ${stderr.trim()}` : ''}`))
      else resolve(stdout)
    })
  })

const spawnDetached = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

const canWrite = (p: string): boolean => {
  try {
    accessSync(p, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Части electron, которые нужны бэкенду; структурный тип — чтобы не импортировать electron в этот модуль. */
export interface ElectronLike {
  app: { getVersion(): string; getPath(name: 'userData'): string }
  net: { fetch(url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response> }
}

/** Работает ли обновление на этом запуске (dev, dmg, translocation, нет прав записи) — `detectMacSupport` с настоящей ФС. */
export function macUpdateSupport(env: { isPackaged: boolean }): UpdateSupport {
  return detectMacSupport({ isPackaged: env.isPackaged, bundlePath: bundlePathFromExecPath(process.execPath), canWrite })
}

/**
 * macOS-бэкенд на настоящем окружении: `net.fetch` (системный прокси), `execFile`, `spawn`.
 * Вызывать только при `macUpdateSupport(...).unsupportedReason === null` — тогда `bundlePath` гарантированно есть.
 */
export function createMacUpdater({ app, net }: ElectronLike): MacUpdater {
  const bundlePath = bundlePathFromExecPath(process.execPath)
  if (!bundlePath) throw new Error('macOS-обновление: приложение запущено не из .app')
  return new MacUpdater({
    version: app.getVersion(),
    arch: process.arch,
    bundlePath,
    userData: app.getPath('userData'),
    pid: process.pid,
    fetch: (url, init) => net.fetch(url, init),
    run: execFileText,
    spawnDetached
  })
}
