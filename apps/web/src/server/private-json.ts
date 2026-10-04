import { constants } from 'node:fs'
import { open, lstat, mkdir, link, unlink, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

async function privateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог конфигурации должен быть обычным каталогом')
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
    throw new Error('Каталог конфигурации должен принадлежать пользователю сервиса и иметь права 0700')
  }
}

/** Auth файлы не читаются через symlink и не публикуются с общими правами. */
export async function readPrivateJson(file: string, limit: number): Promise<unknown> {
  await privateDirectory(dirname(file))
  const entry = await lstat(file)
  if (entry.isSymbolicLink()) throw new Error('Файл конфигурации не может быть симлинком')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Некорректный размер файла конфигурации')
    if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error('Файл конфигурации должен иметь права 0600 и владельца сервиса')
    const bytes = await handle.readFile()
    if (bytes.length > limit) throw new Error('Слишком большой файл конфигурации')
    try { return JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new Error('Некорректный JSON конфигурации') }
  } finally { await handle.close() }
}

export async function createPrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await privateDirectory(dirname(file))
  const temporary = join(dirname(file), `.orca-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await link(temporary, file)
  } finally { await unlink(temporary).catch(() => {}) }
}
export async function replacePrivateJson(file: string, value: unknown): Promise<void> {
  await readPrivateJson(file, 64 * 1024)
  const temporary = join(dirname(file), `.orca-${randomUUID()}.tmp`)
  try { await createPrivateJson(temporary, value); await rename(temporary, file) }
  finally { await unlink(temporary).catch(() => {}) }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
