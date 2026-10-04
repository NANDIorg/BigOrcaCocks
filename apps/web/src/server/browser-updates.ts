import { randomUUID } from 'node:crypto'
import { rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { UpdateState } from '@orca-board/client/desktop-settings'
import { compareVersions } from '@orca-board/runtime'
import { readPrivateJson, createPrivateJson, replacePrivateJson, record } from './private-json.ts'
import { installationDirectory } from './setup.ts'
import { latestWebRelease, prepareWebRelease, installWebRelease, recoverWebRelease, updateLockFile, pinRecovery, type WebRelease } from './update.ts'
import { privilegedCommand } from './privileges.ts'

const execute = promisify(execFile)
type Action = 'download' | 'install'
interface Job { id: string; action: Action; version: string; at: number }
interface SavedUpdate { schemaVersion: 1; state: UpdateState; job: Job | null }
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const states = new Set(['idle', 'available', 'downloading', 'ready', 'installing', 'error'])
const stateFile = (base: string) => join(base, 'updates', 'state.json')
const lockFile = updateLockFile
async function save(base: string, saved: SavedUpdate): Promise<void> {
  try { await replacePrivateJson(stateFile(base), saved) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await createPrivateJson(stateFile(base), saved) }
}
async function load(base: string): Promise<SavedUpdate | null> {
  let raw: unknown
  try { raw = await readPrivateJson(stateFile(base), 64 * 1024) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.state)) throw new Error('Некорректное состояние обновления')
  const s = raw.state
  if (typeof s.currentVersion !== 'string' || !versionPattern.test(s.currentVersion) || typeof s.status !== 'string' || !states.has(s.status)
    || s.mode !== 'server' || s.installPending !== null || s.unsupportedReason !== null
    || !(s.availableVersion === null || typeof s.availableVersion === 'string' && versionPattern.test(s.availableVersion))
    || !(s.releaseNotes === null || typeof s.releaseNotes === 'string' && s.releaseNotes.length <= 8000)
    || !(s.releaseUrl === null || typeof s.releaseUrl === 'string' && /^https:\/\/github\.com\/NANDIorg\/BigOrcaCocks\/releases\/tag\/web\/v\d+\.\d+\.\d+$/.test(s.releaseUrl))
    || !(s.percent === null || typeof s.percent === 'number' && Number.isFinite(s.percent) && s.percent >= 0 && s.percent <= 100)
    || !(s.error === null || ['check', 'download', 'install', 'interrupted'].includes(String(s.error)))) throw new Error('Некорректное состояние обновления')
  const job = raw.job
  if (job !== null && (!record(job) || typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id)
    || !['download', 'install'].includes(String(job.action)) || typeof job.version !== 'string' || !versionPattern.test(job.version)
    || typeof job.at !== 'number' || !Number.isFinite(job.at))) throw new Error('Некорректное задание обновления')
  return raw as unknown as SavedUpdate
}
function initial(version: string, managed: boolean): UpdateState {
  return { status: 'idle', currentVersion: version, availableVersion: null, releaseNotes: null, releaseUrl: null, percent: null,
    installPending: null, mode: managed ? 'server' : 'manual-download', unsupportedReason: managed ? null : 'server-unmanaged', error: null }
}
export async function managedWebInstallation(resourceDir: string): Promise<boolean> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.env.ORCA_WEB_MANAGED !== '1') return false
  return await realpath(join(installationDirectory(), 'current', 'app')).then(path => realpath(resourceDir).then(resource => path === resource), () => false)
}
export interface BrowserUpdates {
  getState(): Promise<UpdateState>
  check(): Promise<UpdateState>
  download(version: string): Promise<UpdateState>
  install(version: string): Promise<UpdateState>
  stop(): void
}
/** Панель только ставит задание; worker живёт в другом systemd unit и переживает остановку панели. */
export function createBrowserUpdates(options: { version: string; managed: boolean; base?: string;
  latest?(current: string, signal?: AbortSignal): Promise<WebRelease | null>; dispatch?(): Promise<void>; workerActive?(): Promise<boolean> }): BrowserUpdates {
  const base = options.base ?? installationDirectory()
  let state = initial(options.version, options.managed)
  let checking: Promise<UpdateState> | undefined
  let queuing: Promise<UpdateState> | undefined
  let closing = false
  const checkingAbort = new AbortController()
  const workerActive = options.workerActive ?? (async () => {
    const { stdout } = await execute('/usr/bin/systemctl', ['show', '-p', 'ActiveState', '--value', 'orca-web-update.service'], { timeout: 5000 })
    return ['active', 'activating', 'deactivating', 'reloading'].includes(stdout.trim())
  })
  const dispatch = options.dispatch ?? (async () => {
    const [command, args] = privilegedCommand('/usr/bin/systemctl', ['start', '--no-block', 'orca-web-update.service'], true)
    await execute(command, args, { timeout: 10_000 })
  })
  async function getState(): Promise<UpdateState> {
    if (!options.managed) return { ...state }
    let saved = await load(base)
    const claimed = await readPrivateJson(lockFile(base), 2048).catch(() => null)
    if (record(claimed) && claimed.kind === 'browser' && typeof claimed.pid === 'number' && claimed.pid > 0 && Number.isSafeInteger(claimed.pid)
      && (!saved?.job || saved.job.id !== claimed.id)) {
      let alive = true
      try { process.kill(claimed.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
      if ((!alive || !queuing && typeof claimed.at === 'number' && Date.now() - claimed.at > 30_000) && !await workerActive()) {
        await rm(lockFile(base), { force: true })
        state = { ...initial(options.version, true), status: 'error', error: 'interrupted' }
        await save(base, { schemaVersion: 1, state, job: null })
        return { ...state }
      }
    }
    if (!saved) return { ...state }
    // После SIGKILL/сбоя загрузки не оставляем вечный прогресс. CLI claim не удаляем.
    if (saved.job && Date.now() - saved.job.at > 30_000 && !await workerActive()) {
      const fresh = await load(base)
      // Worker мог завершиться между чтением state и systemctl show. Не затираем его ready/idle.
      if (!fresh?.job || fresh.job.id !== saved.job.id) {
        state = fresh ? { ...fresh.state, currentVersion: options.version } : initial(options.version, true)
        return { ...state }
      }
      saved = fresh
      const locked = await readPrivateJson(lockFile(base), 2048).catch(() => null)
      if (record(locked) && locked.kind === 'browser' && locked.id === saved.job!.id) await rm(lockFile(base), { force: true })
      saved.state = { ...saved.state, status: 'error', error: 'interrupted', percent: null }; saved.job = null
      await save(base, saved)
    }
    state = { ...saved.state, currentVersion: options.version }
    // CLI мог установить новую версию вне браузера; старое ready не предлагает downgrade.
    if (!saved.job && state.availableVersion && compareVersions(state.availableVersion, options.version) <= 0) state = initial(options.version, true)
    return { ...state }
  }
  async function check(): Promise<UpdateState> {
    if (checking) return checking
    checking = (async () => {
      const current = await getState()
      if (closing || queuing || ['downloading', 'ready', 'installing'].includes(current.status)) return current
      try {
        const release = await (options.latest ?? latestWebRelease)(options.version, checkingAbort.signal)
        if (closing) return { ...state }
        state = release ? { ...initial(options.version, options.managed), status: options.managed ? 'available' : 'unsupported', availableVersion: release.version, releaseNotes: release.releaseNotes, releaseUrl: release.releaseUrl }
          : initial(options.version, options.managed)
      } catch { if (closing) return { ...state }; state = { ...initial(options.version, options.managed), status: 'error', error: 'check' } }
      if (options.managed) await save(base, { schemaVersion: 1, state, job: null })
      return { ...state }
    })().finally(() => { checking = undefined })
    return checking
  }
  async function queue(action: Action, version: string): Promise<UpdateState> {
    if (queuing) return queuing
    queuing = (async () => {
      if (checking) await checking
      const current = await getState()
      if (closing || !options.managed || !versionPattern.test(version) || current.availableVersion !== version || compareVersions(version, options.version) <= 0) throw new Error('Обновление недоступно')
      if (current.status === 'downloading' || current.status === 'installing') return current
      if (current.status !== (action === 'download' ? 'available' : 'ready')) throw new Error('Сначала проверьте и скачайте обновление')
      // ExecStopPost предыдущего worker должен закончиться до публикации нового задания.
      if (!options.dispatch) await dispatchWhenInactive(workerActive, async () => {})
      const job: Job = { id: randomUUID(), action, version, at: Date.now() }
      await createPrivateJson(lockFile(base), { ...job, kind: 'browser', pid: process.pid })
      state = { ...current, status: action === 'download' ? 'downloading' : 'installing', percent: null, error: null }
      try {
        await pinRecovery(base)
        await save(base, { schemaVersion: 1, state, job })
        await dispatch()
      } catch {
        state = { ...current, status: 'error', error: action }
        await save(base, { schemaVersion: 1, state, job: null })
        await rm(lockFile(base), { force: true })
      }
      return { ...state }
    })().finally(() => { queuing = undefined })
    return queuing
  }
  // Общий публичный feed проверяется на старте и раз в 6 часов, без автоматической установки.
  const timer = setInterval(() => { void check().catch(() => {}) }, 6 * 60 * 60 * 1000); timer.unref()
  return { getState, check, download: version => queue('download', version), install: version => queue('install', version), stop: () => { closing = true; checkingAbort.abort(); clearInterval(timer) } }
}
export async function dispatchWhenInactive(active: () => Promise<boolean>, start: () => Promise<void>, delay = () => new Promise<void>(resolve => setTimeout(resolve, 100))): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!await active()) { await start(); return }
    await delay()
  }
  throw new Error('Предыдущий updater ещё завершает работу')
}
export async function recoverBrowserUpdate(): Promise<void> {
  const base = installationDirectory()
  await recoverWebRelease(base)
  const saved = await load(base)
  if (!saved?.job) {
    const locked = await readPrivateJson(lockFile(base), 2048).catch(() => null)
    if (record(locked) && locked.kind === 'browser') await rm(lockFile(base), { force: true })
    return
  }
  saved.state = { ...saved.state, status: 'error', percent: null, error: 'interrupted' }; saved.job = null
  await save(base, saved)
  await rm(lockFile(base), { force: true })
}
export async function runBrowserUpdateWorker(options: { base?: string; prepare?: typeof prepareWebRelease; install?: typeof installWebRelease } = {}): Promise<void> {
  const base = options.base ?? installationDirectory()
  const saved = await load(base)
  const locked = await readPrivateJson(lockFile(base), 2048)
  if (!saved?.job || !record(locked) || locked.kind !== 'browser' || locked.id !== saved.job.id || locked.action !== saved.job.action || locked.version !== saved.job.version) throw new Error('Нет подтверждённого задания обновления')
  const job = saved.job
  let writes = Promise.resolve()
  try {
    if (compareVersions(job.version, saved.state.currentVersion) <= 0) throw new Error('Downgrade запрещён')
    if (job.action === 'download') {
      await (options.prepare ?? prepareWebRelease)(base, job.version, percent => {
        const progress = { ...saved.state, percent }
        writes = writes.then(() => save(base, { ...saved, state: progress })).catch(() => {})
      })
      await writes
      saved.state = { ...saved.state, status: 'ready', percent: null, error: null }
    } else {
      await (options.install ?? installWebRelease)(base, job.version, true)
      saved.state = initial(job.version, true)
    }
    saved.job = null
    await save(base, saved)
  } catch (error) {
    await writes
    saved.state = { ...saved.state, status: 'error', percent: null, error: job.action }; saved.job = null
    await save(base, saved)
    throw error
  } finally { await rm(lockFile(base), { force: true }) }
}
