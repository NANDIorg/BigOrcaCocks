/**
 * Файлы правил проекта в корне репозитория — единственные, которые UI может записать (раздел «Правила»).
 * Белый список: имя от renderer сверяется с ним в main, произвольных путей нет.
 */
export const RULE_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'] as const

export type RuleFileName = (typeof RULE_FILE_NAMES)[number]

export function isRuleFileName(v: unknown): v is RuleFileName {
  return typeof v === 'string' && (RULE_FILE_NAMES as readonly string[]).includes(v)
}

/** Файл правил в корне проекта. */
export interface RuleFile {
  name: RuleFileName
  exists: boolean
  /** Содержимое с переводами строк `\n` (textarea всё равно их нормализует); нет файла — ''. */
  text: string
  /** Перевод строк файла на диске — main вернёт его при записи. Новый файл — 'lf'. */
  eol: 'lf' | 'crlf'
}
