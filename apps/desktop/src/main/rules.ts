import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { isRuleFileName, RULE_FILE_NAMES, type RuleFile, type RuleFileName } from '../shared/ipc'

/** Правила — текст для агента, а не дамп: больше не читаем и не пишем. */
export const RULE_MAX_BYTES = 1024 * 1024

/** Имя от renderer (не доверенного) → имя из белого списка; всё остальное, включая пути, — ошибка. */
export function ruleFileName(name: unknown): RuleFileName {
  if (!isRuleFileName(name)) throw new Error(`можно править только ${RULE_FILE_NAMES.join(' и ')} в корне проекта, а не «${String(name)}»`)
  return name
}

const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Реальный путь файла правил или null, если его нет. Симлинк допустим (CLAUDE.md → AGENTS.md —
 * обычная практика), но только внутрь проекта: запись идёт в цель, а не поверх ссылки.
 */
function existingTarget(root: string, name: RuleFileName): string | null {
  const path = join(root, name)
  try {
    lstatSync(path)
  } catch {
    return null
  }
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new Error(`${name}: ссылка ведёт на несуществующий файл`)
  }
  if (!isInside(realpathSync(root), real)) throw new Error(`${name}: ссылка ведёт за пределы проекта`)
  const st = statSync(real)
  if (!st.isFile()) throw new Error(`${name}: это не файл`)
  if (st.size > RULE_MAX_BYTES) throw new Error(`${name}: файл больше ${RULE_MAX_BYTES / 1024 / 1024} МБ`)
  return real
}

/** CRLF, если он встречается в файле (Windows-репозиторий), иначе LF. */
export function detectEol(raw: string): RuleFile['eol'] {
  return raw.includes('\r\n') ? 'crlf' : 'lf'
}

/** Текст из UI (переводы строк любые) → переводы строк файла на диске. */
export function withEol(text: string, eol: RuleFile['eol']): string {
  const lf = text.replace(/\r\n?/g, '\n')
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

export function readRule(root: string, name: unknown): RuleFile {
  const n = ruleFileName(name)
  const real = existingTarget(root, n)
  if (!real) return { name: n, exists: false, text: '', eol: 'lf' }
  const raw = readFileSync(real, 'utf8')
  return { name: n, exists: true, text: withEol(raw, 'lf'), eol: detectEol(raw) }
}

export function listRules(root: string): RuleFile[] {
  return RULE_FILE_NAMES.map((n) => readRule(root, n))
}

/**
 * Записать файл правил атомарно: временный файл рядом с целью + rename, чтобы агент, читающий
 * правила в этот момент, не увидел половину. Перевод строк и права берутся у существующего файла.
 * Не коммитит — это решает человек.
 */
export function writeRule(root: string, name: unknown, text: unknown): RuleFile {
  const n = ruleFileName(name)
  if (typeof text !== 'string') throw new Error(`${n}: текст должен быть строкой`)
  if (Buffer.byteLength(text, 'utf8') > RULE_MAX_BYTES) throw new Error(`${n}: текст больше ${RULE_MAX_BYTES / 1024 / 1024} МБ`)
  const real = existingTarget(root, n)
  const target = real ?? join(root, n)
  const eol = real ? detectEol(readFileSync(real, 'utf8')) : 'lf'
  const tmp = join(dirname(target), `.${basename(target)}.orca-${process.pid}-${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, withEol(text, eol), { encoding: 'utf8', flag: 'wx' })
    if (real) chmodSync(tmp, statSync(real).mode & 0o7777)
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw new Error(`${n}: не удалось записать — ${e instanceof Error ? e.message : String(e)}`)
  }
  return readRule(root, n)
}
