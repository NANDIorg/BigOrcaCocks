import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, cp, rm, realpath, rename, symlink, lstat, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { acquireProfileOwnership, compareVersions, PROFILE_OWNER_FILE } from '@orca-board/runtime'
import { configFile, installationDirectory } from './setup.ts'
import { loadWebConfig } from './config.ts'
import { record, createPrivateJson, replacePrivateJson, readPrivateJson } from './private-json.ts'
import { localHealth } from './health.ts'

const repository = 'NANDIorg/BigOrcaCocks'
export interface WebRelease { version: string; releaseNotes: string; releaseUrl: string }
export function selectWebRelease(releases: unknown, currentVersion: string): WebRelease | null {
  if (!Array.isArray(releases)) throw new Error('Некорректный список релизов')
  const stable = releases.filter(record).filter(release => release.draft === false && release.prerelease === false && typeof release.tag_name === 'string' && /^web\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name))
    .sort((left, right) => compareVersions(String(right.tag_name).slice(5), String(left.tag_name).slice(5)))
  const release = stable[0]
  if (!release) return null
  const version = String(release.tag_name).slice(5)
  if (compareVersions(version, currentVersion) <= 0) return null
  if (!Array.isArray(release.assets) || !release.assets.some(asset => record(asset) && asset.name === `orca-web-linux-x64-${version}.tar.gz`)) throw new Error('В выпуске Web нет совместимой сборки Linux x64')
  return { version, releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 8000) : '', releaseUrl: `https://github.com/${repository}/releases/tag/web/v${version}` }
}
export async function latestWebRelease(currentVersion: string, signal?: AbortSignal): Promise<WebRelease | null> {
  const timeout = AbortSignal.timeout(30_000)
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, { headers: { accept: 'application/vnd.github+json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  const text = await response.text()
  if (!response.ok || text.length > 4 * 1024 * 1024) throw new Error('Не удалось получить список выпусков Web')
  return selectWebRelease(JSON.parse(text) as unknown, currentVersion)
}
const transient = new Set([PROFILE_OWNER_FILE, 'operator-endpoint.json', 'backups', 'tmp'])
export function archiveNamesSafe(names: string[]): boolean {
  return names.length > 0 && names.every(name => {
    const path = name.replace(/\/$/, ''); const segments = path.split('/')
    return segments[0] === 'orca-web' && segments.every(part => part !== '' && part !== '.' && part !== '..' && !/[\\\0\r\n]/.test(part))
  })
}
export async function validateInstalledRelease(directory: string, version: string): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'app', 'package.json'), 'utf8'))
  const release: unknown = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
  if (!record(manifest) || manifest.name !== '@orca-board/web' || manifest.version !== version || !record(release) || release.version !== version || release.platform !== 'linux' || release.arch !== 'x64' || release.schemaVersion !== 1) throw new Error('Несовместимый Web artifact')
  for (const path of ['node/bin/node', 'app/control.mjs', 'app/browser/index.html', 'app/skills/worker.md', 'app/cli/orca-board.js']) {
    const target = await realpath(join(directory, path)); const rel = relative(await realpath(directory), target)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || !(await lstat(target)).isFile()) throw new Error('Artifact содержит небезопасный путь')
  }
}
async function download(url: string, file: string, progress?: (percent: number | null) => void): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error('Не удалось скачать Web artifact')
  let size = 0
  const total = Number(response.headers.get('content-length'))
  let last = 0
  await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length
    if (Date.now() - last >= 500) { last = Date.now(); progress?.(total > 0 ? Math.min(99, size / total * 100) : null) }
    callback(size > 512 * 1024 * 1024 ? new Error('Слишком большой Web artifact') : null, chunk)
  } }), createWriteStream(file, { flags: 'wx', mode: 0o600 }))
}
export async function unpackRelease(archive: string, directory: string, version: string): Promise<void> {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trimEnd().split('\n')
  if (!archiveNamesSafe(names)) throw new Error('Небезопасные пути Web archive')
  const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (listing.trimEnd().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw new Error('Web archive должен содержать только обычные файлы и каталоги')
  await mkdir(directory, { recursive: false, mode: 0o700 })
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', directory], { stdio: 'pipe' })
  await validateInstalledRelease(directory, version)
}
export async function switchRelease(base: string, directory: string): Promise<void> {
  const releases = await realpath(join(base, 'releases')); const target = await realpath(directory); const rel = relative(releases, target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Версия должна принадлежать releases')
  const link = join(base, `.current-${randomUUID()}`)
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  try { await rename(link, join(base, 'current')) } finally { await rm(link, { force: true }) }
}
export async function copyProfile(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const name of await readdir(source)) if (!transient.has(name)) await cp(join(source, name), join(destination, name), { recursive: true, dereference: false, preserveTimestamps: true })
}
export async function restoreProfile(backup: string, destination: string): Promise<void> {
  // Inode корня и OS owner guard сохраняются; Git repositories/worktrees вне профиля не трогаем.
  for (const name of await readdir(destination)) if (!transient.has(name)) await rm(join(destination, name), { recursive: true, force: true })
  await copyProfile(backup, destination)
}
const transactionFile = (base: string) => join(base, 'updates', 'transaction.json')
export const updateLockFile = (base: string) => join(base, 'updates', 'lock.json')
export async function pinRecovery(base: string): Promise<void> {
  const target = await realpath(join(base, 'current'))
  const temporary = join(base, `.recovery-${randomUUID()}`)
  try { await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir'); await rename(temporary, join(base, 'recovery')) }
  finally { await rm(temporary, { force: true }) }
}
interface UpdateTransaction { schemaVersion: 1; previous: string; next: string; version: string; backup: string | null }
/** ExecStopPost выполняет recovery даже после SIGKILL/timeout worker, когда HTTP-сервис уже остановлен. */
export async function recoverRelease(options: { base: string; dataDir: string; configDir: string; stop(): Promise<void>; start(): Promise<void> }): Promise<boolean> {
  let raw: unknown
  try { raw = await readPrivateJson(transactionFile(options.base), 8192) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  if (!record(raw) || raw.schemaVersion !== 1 || typeof raw.previous !== 'string' || typeof raw.next !== 'string' || typeof raw.version !== 'string'
    || !(raw.backup === null || typeof raw.backup === 'string')) throw new Error('Некорректная транзакция обновления')
  const releases = await realpath(join(options.base, 'releases'))
  for (const path of [raw.previous, raw.next]) {
    const rel = relative(releases, await realpath(path))
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Некорректные пути восстановления')
  }
  const switched = await realpath(join(options.base, 'current')) !== await realpath(raw.previous)
  if (switched && !raw.backup) throw new Error('Нельзя восстановить изменённую версию без backup')
  if (raw.backup) {
    const backupRoot = await realpath(join(options.dataDir, 'backups', 'web-update'))
    const rel = relative(backupRoot, await realpath(raw.backup))
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Некорректный backup восстановления')
  }
  await options.stop()
  const owner = await acquireProfileOwnership({ dataDir: options.dataDir })
  try {
    if (switched && raw.backup) {
      await restoreProfile(join(raw.backup, 'profile'), owner.info.dataDir)
      for (const name of await readdir(options.configDir)) await rm(join(options.configDir, name), { recursive: true, force: true })
      await cp(join(raw.backup, 'config'), options.configDir, { recursive: true, dereference: false })
    }
    await switchRelease(options.base, raw.previous)
  } finally { await owner.release() }
  await options.start()
  await rm(transactionFile(options.base), { force: true })
  return true
}
export async function activateRelease(options: { base: string; directory: string; dataDir: string; configDir: string; version: string;
  stop(): Promise<void>; start(): Promise<void>; healthy(version: string): Promise<void> }): Promise<{ backup: string }> {
  const previous = await realpath(join(options.base, 'current'))
  const transaction: UpdateTransaction = { schemaVersion: 1, previous, next: options.directory, version: options.version, backup: null }
  await createPrivateJson(transactionFile(options.base), transaction)
  await options.stop()
  let backup: string | undefined; let switched = false
  try {
    const owner = await acquireProfileOwnership({ dataDir: options.dataDir })
    try {
      const backupRoot = join(owner.info.dataDir, 'backups', 'web-update', `${Date.now()}-${randomUUID()}`)
      await copyProfile(owner.info.dataDir, join(backupRoot, 'profile'))
      await cp(options.configDir, join(backupRoot, 'config'), { recursive: true, dereference: false })
      await writeFile(join(backupRoot, 'update.json'), JSON.stringify({ schemaVersion: 1, previous, next: options.directory, version: options.version }), { mode: 0o600 })
      backup = backupRoot
      transaction.backup = backup
      await replacePrivateJson(transactionFile(options.base), transaction)
      await switchRelease(options.base, options.directory); switched = true
    } finally { await owner.release() }
    await options.start(); await options.healthy(options.version)
    await rm(transactionFile(options.base), { force: true })
    return { backup: backup! }
  } catch (error) {
    if (switched && backup) {
      await options.stop()
      const owner = await acquireProfileOwnership({ dataDir: options.dataDir })
      try {
        await restoreProfile(join(backup, 'profile'), owner.info.dataDir)
        for (const name of await readdir(options.configDir)) await rm(join(options.configDir, name), { recursive: true, force: true })
        await cp(join(backup, 'config'), options.configDir, { recursive: true, dereference: false })
        await switchRelease(options.base, previous)
      }
      finally { await owner.release() }
    }
    await options.start()
    await rm(transactionFile(options.base), { force: true })
    throw new Error(`Обновление не запущено; сохранена предыдущая версия${backup ? `, backup: ${backup}` : ''}`, { cause: error })
  }
}
export async function prepareWebRelease(base: string, version: string, progress?: (percent: number | null) => void): Promise<string> {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Некорректная версия Web')
  const work = join(base, `.update-${randomUUID()}`)
  const directory = join(base, 'releases', version)
  await mkdir(work, { mode: 0o700 })
  try {
    const name = `orca-web-linux-x64-${version}.tar.gz`
    const prefix = `https://github.com/${repository}/releases/download/web%2Fv${version}/`
    const sums = await fetch(`${prefix}SHA256SUMS`, { signal: AbortSignal.timeout(30_000) })
    const text = await sums.text(); if (!sums.ok || text.length > 64 * 1024) throw new Error('Нет корректных контрольных сумм релиза')
    const checksum = text.split('\n').find(line => line.slice(66) === name)?.slice(0, 64)
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Нет SHA256 Web artifact')
    const archive = join(work, name); await download(`${prefix}${name}`, archive, progress)
    const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk)
    if (hash.digest('hex') !== checksum) throw new Error('SHA256 Web artifact не совпадает')
    let exists = false
    try { await lstat(directory); exists = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (exists) await validateInstalledRelease(directory, version)
    else {
      // Неполная распаковка не остаётся под именем готовой версии при сбое процесса.
      const staging = join(base, 'releases', `.prepared-${randomUUID()}`)
      try { await unpackRelease(archive, staging, version); await rename(staging, directory) }
      finally { await rm(staging, { recursive: true, force: true }) }
    }
    progress?.(100)
    return directory
  } finally { await rm(work, { recursive: true, force: true }) }
}
export async function installWebRelease(base: string, version: string, nonInteractive = false): Promise<{ backup: string }> {
  const config = await loadWebConfig(configFile())
  const directory = join(base, 'releases', version)
  await validateInstalledRelease(directory, version)
  const service = async (action: 'start' | 'stop') => { execFileSync('sudo', [...(nonInteractive ? ['-n'] : []), '/usr/bin/systemctl', action, 'orca-web.service'], { stdio: 'inherit' }) }
  return activateRelease({ base, directory, dataDir: config.dataDir, configDir: config.configDir, version,
    stop: () => service('stop'), start: () => service('start'), healthy: async expected => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const ready = await localHealth(config).catch(() => null)
        if (record(ready) && ready.status === 'ready' && ready.version === expected) return
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      throw new Error('Новая версия не прошла проверку запуска')
    } })
}
export async function recoverWebRelease(base: string): Promise<boolean> {
  const config = await loadWebConfig(configFile())
  const service = async (action: 'start' | 'stop') => { execFileSync('sudo', ['-n', '/usr/bin/systemctl', action, 'orca-web.service'], { stdio: 'inherit' }) }
  return recoverRelease({ base, dataDir: config.dataDir, configDir: config.configDir, stop: () => service('stop'), start: () => service('start') })
}
export async function updateWeb(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0) throw new Error('Обновление Web рассчитано на обычного пользователя Linux x64')
  const base = installationDirectory()
  const current: unknown = JSON.parse(await readFile(join(base, 'current', 'app', 'package.json'), 'utf8'))
  if (!record(current) || typeof current.version !== 'string') throw new Error('Некорректный installed manifest')
  const release = await latestWebRelease(current.version)
  if (!release) { process.stdout.write('Orca Web уже использует актуальную версию.\n'); return }
  const lock = updateLockFile(base); await createPrivateJson(lock, { kind: 'cli', id: randomUUID(), pid: process.pid, at: Date.now() })
  try {
    await prepareWebRelease(base, release.version)
    const result = await installWebRelease(base, release.version)
    process.stdout.write(`Orca Web обновлена до ${release.version}. Backup: ${result.backup}\n`)
  } finally { await rm(lock, { force: true }) }
}
