import { realpath, readdir, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { OperatorProtocolError } from '@orca-board/runtime'
import { record } from './private-json.ts'

export async function createProjectRootPolicy(roots: readonly string[]) {
  const allowed = await Promise.all(roots.map(async root => {
    const value = await realpath(root)
    if (!(await stat(value)).isDirectory()) throw new Error('Root проектов должен быть каталогом')
    return value
  }))
  const inside = (root: string, target: string) => { const path = relative(root, target); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`) }
  async function directory(raw: unknown): Promise<string> {
    if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\0')) throw new OperatorProtocolError('protocol.invalidInput', 'Некорректный путь проекта')
    const canonical = await realpath(raw)
    if (!allowed.some(root => inside(root, canonical)) || !(await stat(canonical)).isDirectory()) throw new OperatorProtocolError('command.forbidden', 'Каталог вне разрешённых roots')
    return canonical
  }
  return {
    async list(raw?: string) {
      if (raw === undefined) return { path: null, roots: allowed, directories: [] }
      const path = await directory(raw); const entries = await readdir(path, { withFileTypes: true })
      const names = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort().slice(0, 200)
      return { path, roots: allowed, directories: names }
    },
    async beforeCall(_context: unknown, raw: unknown): Promise<unknown> {
      if (!record(raw) || !['profile.addProject', 'profile.detectTaskType'].includes(String(raw.method))) return raw
      if (!Array.isArray(raw.args)) throw new OperatorProtocolError('protocol.invalidInput', 'Некорректные аргументы')
      return { ...raw, args: [await directory(raw.args[0]), ...raw.args.slice(1)] }
    }
  }
}
