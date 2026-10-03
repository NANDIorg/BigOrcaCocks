import { isAbsolute, relative } from 'node:path'

/** Сравнение абсолютных путей; callers передают realpath, когда проверяют symlink. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
