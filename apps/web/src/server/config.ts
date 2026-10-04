import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { record, readPrivateJson } from './private-json.ts'

export interface WebConfig {
  schemaVersion: 1
  configDir: string
  dataDir: string
  projectRoots: string[]
  origin: string
  port: number
  mode: 'local' | 'proxy'
  previewOrigin: string
  previewPort: number
}
const keys = ['schemaVersion', 'configDir', 'dataDir', 'projectRoots', 'origin', 'port', 'mode', 'previewOrigin', 'previewPort']
export function parseWebConfig(input: unknown): WebConfig {
  if (!record(input) || Object.keys(input).some(key => !keys.includes(key)) || input.schemaVersion !== 1) throw new Error('Неподдерживаемая схема Web конфигурации')
  const path = (value: unknown) => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('Пути Web конфигурации должны быть абсолютными')
    return value
  }
  const configDir = path(input.configDir); const dataDir = path(input.dataDir)
  if (!Array.isArray(input.projectRoots) || input.projectRoots.length < 1 || input.projectRoots.length > 32) throw new Error('Задайте от 1 до 32 каталогов проектов')
  const projectRoots = input.projectRoots.map(path)
  const port = input.port ?? 3737
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Порт Web должен быть в диапазоне 1..65535')
  const mode = input.mode ?? 'local'
  if (mode !== 'local' && mode !== 'proxy') throw new Error('Неподдерживаемый режим Web')
  const origin = input.origin ?? `http://localhost:${port}`
  if (typeof origin !== 'string') throw new Error('Некорректный origin Web')
  let url: URL
  try { url = new URL(origin) } catch { throw new Error('Некорректный origin Web') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || origin.replace(/\/$/, '') !== url.origin) throw new Error('Origin Web должен содержать только протокол, hostname и порт')
  if (mode === 'local' ? url.protocol !== 'http:' || url.hostname !== 'localhost' : url.protocol !== 'https:') throw new Error('Локальный Web использует localhost; серверный — HTTPS origin')
  const previewPort = input.previewPort ?? 3738
  if (typeof previewPort !== 'number' || !Number.isSafeInteger(previewPort) || previewPort < 1 || previewPort > 65535 || previewPort === port) throw new Error('Задайте отдельный порт preview')
  const previewOrigin = input.previewOrigin ?? (mode === 'local' ? `http://127.0.0.1:${previewPort}` : undefined)
  if (typeof previewOrigin !== 'string') throw new Error('Задайте отдельный HTTPS origin preview')
  const preview = new URL(previewOrigin)
  if (preview.origin !== previewOrigin || preview.hostname === url.hostname || preview.username || preview.password || preview.pathname !== '/' || preview.search || preview.hash
    || (mode === 'local' ? preview.protocol !== 'http:' || preview.hostname !== '127.0.0.1' : preview.protocol !== 'https:')) throw new Error('Preview должен использовать отдельный hostname без cookies панели')
  return { schemaVersion: 1, configDir, dataDir, projectRoots, origin: url.origin, port, mode, previewOrigin, previewPort }
}
export async function loadWebConfig(file: string): Promise<WebConfig> {
  const config = parseWebConfig(await readPrivateJson(file, 16 * 1024))
  config.projectRoots = await Promise.all(config.projectRoots.map(async root => {
    const canonical = await realpath(root)
    if (!(await stat(canonical)).isDirectory()) throw new Error('Root проекта должен быть каталогом')
    return canonical
  }))
  return config
}
