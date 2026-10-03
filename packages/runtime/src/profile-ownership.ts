import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, statSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createServer, createConnection, type Socket } from 'node:net'

export const PROFILE_OWNER_FILE = '.orca-owner.json'
export type ProfileOwnerEndpoint = { kind: 'ipc'; path: string } | { kind: 'tcp'; host: '127.0.0.1'; port: number }
export interface ProfileOwnerInfo {
  schemaVersion: 1
  protocolMajor: 1
  profileId: string
  dataDir: string
  hostname: string
  pid: number
  instanceId: string
  endpoint: ProfileOwnerEndpoint
}
export interface ProfileLocation { dataDir: string; profileId: string; file: string; endpoint: ProfileOwnerEndpoint }
export interface ProfileOwnership { readonly info: ProfileOwnerInfo; release(): Promise<void> }
export type ProfileOwnershipErrorCode = 'ownership.invalid' | 'ownership.schemaUnsupported' | 'ownership.busy' | 'ownership.unavailable'

export class ProfileOwnershipError extends Error {
  readonly code: ProfileOwnershipErrorCode
  constructor(code: ProfileOwnershipErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = 'ProfileOwnershipError'
  }
}

function invalid(message: string): never { throw new ProfileOwnershipError('ownership.invalid', message) }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function sameEndpoint(a: unknown, b: ProfileOwnerEndpoint): boolean {
  return object(a) && a.kind === b.kind && (b.kind === 'ipc' ? a.path === b.path : a.host === b.host && a.port === b.port)
}

/** Физический каталог объединяет symlink/junction и варианты регистра без смешивания разных case-sensitive каталогов. */
export async function getProfileLocation(dataDir: string): Promise<ProfileLocation> {
  if (!isAbsolute(dataDir)) invalid('Каталог профиля должен быть абсолютным путём.')
  const canonical = realpathSync.native(dataDir)
  const stat = statSync(canonical, { bigint: true })
  if (!stat.isDirectory()) invalid('Путь профиля не является каталогом.')
  const profileId = createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex')
  const endpoint: ProfileOwnerEndpoint = process.platform === 'linux'
    ? { kind: 'ipc', path: `\0orca-profile-${profileId.slice(0, 40)}` }
    : process.platform === 'win32'
      ? { kind: 'ipc', path: `\\\\.\\pipe\\orca-profile-${profileId.slice(0, 40)}` }
      : { kind: 'tcp', host: '127.0.0.1', port: 49152 + Number.parseInt(profileId.slice(0, 4), 16) % 16384 }
  return { dataDir: canonical, profileId, file: join(canonical, PROFILE_OWNER_FILE), endpoint }
}

function readRecord(location: ProfileLocation): Record<string, unknown> | undefined {
  let stat
  try { stat = lstatSync(location.file) } catch (error) { if (missing(error)) return undefined; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) invalid('Запись владельца профиля повреждена или является ссылкой.')
  let record: unknown
  try { record = JSON.parse(readFileSync(location.file, 'utf8')) } catch (cause) {
    throw new ProfileOwnershipError('ownership.invalid', 'Не удалось прочитать запись владельца профиля.', { cause })
  }
  if (!object(record)) invalid('Запись владельца профиля должна быть объектом.')
  if (record.schemaVersion !== 1 || record.protocolMajor !== 1) {
    throw new ProfileOwnershipError('ownership.schemaUnsupported', 'Версия записи владельца профиля не поддерживается.')
  }
  if (record.profileId !== location.profileId || typeof record.dataDir !== 'string' || !isAbsolute(record.dataDir)
    || record.hostname !== hostname() || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1
    || typeof record.instanceId !== 'string' || !record.instanceId || !sameEndpoint(record.endpoint, location.endpoint)) {
    invalid('Запись владельца относится к другому профилю или содержит неверную identity.')
  }
  // Rename/перенос профиля выполняется offline: прежний путь обязан указывать на тот же физический каталог.
  let previous
  try { previous = statSync(realpathSync.native(record.dataDir), { bigint: true }) } catch { invalid('Прежний каталог владельца недоступен; требуется проверка переноса профиля.') }
  const physicalId = createHash('sha256').update(`${previous.dev}:${previous.ino}`).digest('hex')
  if (physicalId !== location.profileId) invalid('Прежний каталог владельца относится к другому профилю.')
  return record
}

function writeRecord(file: string, record: Record<string, unknown>): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (!missing(error)) throw error }
  }
}

function connectOptions(endpoint: ProfileOwnerEndpoint) {
  return endpoint.kind === 'ipc' ? { path: endpoint.path } : { host: endpoint.host, port: endpoint.port }
}

/** Проверка только identity; этот guard не предоставляет операторские или агентские методы. */
export function probeProfileOwner(info: ProfileOwnerInfo): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(connectOptions(info.endpoint))
    let text = ''
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket.destroy()
      resolve(value)
    }
    const deadline = setTimeout(() => finish(false), 1500)
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(false))
    socket.once('connect', () => socket.write(JSON.stringify({ protocolMajor: 1, profileId: info.profileId, instanceId: info.instanceId }) + '\n'))
    socket.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(text) + chunk.length > 4096) return finish(false)
      text += chunk.toString('utf8')
      const end = text.indexOf('\n')
      if (end < 0) return
      try {
        const reply: unknown = JSON.parse(text.slice(0, end))
        finish(object(reply) && reply.protocolMajor === 1 && reply.profileId === info.profileId
          && reply.instanceId === info.instanceId && reply.pid === info.pid && reply.hostname === info.hostname)
      } catch { finish(false) }
    })
  })
}

/** Bind выполняется до чтения/замены owner record: аварийный процесс теряет OS guard без опасного unlink stale socket. */
export async function acquireProfileOwnership({ dataDir }: { dataDir: string }): Promise<ProfileOwnership> {
  if (!isAbsolute(dataDir)) invalid('Каталог профиля должен быть абсолютным путём.')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const location = await getProfileLocation(dataDir)
  const sockets = new Set<Socket>()
  let info: ProfileOwnerInfo | undefined
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(1000, () => socket.destroy())
    let text = ''
    socket.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(text) + chunk.length > 4096) { socket.destroy(); return }
      text += chunk.toString('utf8')
      const end = text.indexOf('\n')
      if (end < 0) return
      try {
        const request: unknown = JSON.parse(text.slice(0, end))
        if (info && object(request) && request.protocolMajor === 1 && request.profileId === info.profileId && request.instanceId === info.instanceId) {
          socket.end(JSON.stringify(info) + '\n')
        } else socket.destroy()
      } catch { socket.destroy() }
    })
  })
  server.maxConnections = 16
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ ...connectOptions(location.endpoint), exclusive: true }, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (cause) {
    // Чужой endpoint не удаляется даже при stale/подменённой записи.
    let previous: Record<string, unknown> | undefined
    try { previous = readRecord(location) } catch { /* отказ bind уже исключает запись */ }
    if (previous && await probeProfileOwner(previous as unknown as ProfileOwnerInfo)) {
      throw new ProfileOwnershipError('ownership.busy', 'Этот профиль Orca уже открыт в другом процессе.', { cause })
    }
    throw new ProfileOwnershipError('ownership.unavailable', 'Не удалось приобрести защиту профиля: локальный endpoint занят или недоступен.', { cause })
  }
  try {
    const previous = readRecord(location)
    info = { schemaVersion: 1, protocolMajor: 1, profileId: location.profileId, dataDir: location.dataDir,
      hostname: hostname(), pid: process.pid, instanceId: randomUUID(), endpoint: location.endpoint }
    writeRecord(location.file, { ...previous, ...info })
  } catch (error) { await close(); throw error }
  const owned = info
  let releasePromise: Promise<void> | undefined
  return {
    get info() { return structuredClone(owned) },
    release() {
      return releasePromise ??= (async () => {
        try {
          // Подменённый/повреждённый record принадлежит проверке восстановления, не нашему cleanup.
          const current = readRecord(location)
          if (current?.instanceId === owned.instanceId) unlinkSync(location.file)
        } finally { await close() }
      })()
    }
  }
}
