import { isRuleFileName, RULE_FILE_NAMES, type OrcaApi, type RuleFile, type RuleFileName } from '../../shared/ipc'

/** Как STALE_APP_MESSAGE в docLinks.ts: renderer обновился по HMR, а main/preload — ещё нет. */
export const RULES_STALE_MESSAGE = 'Приложение запущено со старой версией main/preload, где ещё нет раздела «Правила». Перезапустите приложение.'

/** `window.orca.rules` или понятная ошибка вместо «Cannot read properties of undefined». */
export function rulesApi(api: Partial<OrcaApi> | undefined): OrcaApi['rules'] {
  if (!api?.rules) throw new Error(RULES_STALE_MESSAGE)
  return api.rules
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'rules:…'». */
export function isStaleRulesError(message: string): boolean {
  return /No handler registered for 'rules:/.test(message)
}

/** Для чего файл — подпись под переключателем. */
export const RULE_HINTS: Record<RuleFileName, string> = {
  'CLAUDE.md': 'Читает Claude Code: запреты, обязательные шаги, стиль, проверки.',
  'AGENTS.md': 'Читают Codex и другие агенты. Обычно отсылает к CLAUDE.md, чтобы правила не расходились.'
}

/** Заготовка для «Создать»: AGENTS.md отсылает к CLAUDE.md, CLAUDE.md — пустой каркас разделов. */
export const RULE_TEMPLATES: Record<RuleFileName, string> = {
  'CLAUDE.md': [
    '# Правила проекта',
    '',
    '## Нельзя',
    '',
    '- ',
    '',
    '## Обязательно',
    '',
    '- ',
    '',
    '## Стиль кода',
    '',
    '- ',
    '',
    '## Проверки перед сдачей',
    '',
    '- ',
    '',
    '## Git и ветки',
    '',
    '- ',
    ''
  ].join('\n'),
  'AGENTS.md': '# Правила проекта\n\nПравила проекта — в CLAUDE.md, прочитай его.\n'
}

/** Выбранный файл: сохранённый, если он из белого списка, иначе первый существующий, иначе CLAUDE.md. */
export function pickRule(files: RuleFile[], stored: string | null): RuleFileName {
  if (isRuleFileName(stored)) return stored
  return files.find((f) => f.exists)?.name ?? RULE_FILE_NAMES[0]
}

/**
 * Есть несохранённые изменения. Переводы строк не считаются: textarea отдаёт `\n`,
 * а файл на диске может быть в CRLF (main вернёт ему CRLF при записи).
 */
export function isDirty(draft: string | null, saved: string): boolean {
  if (draft === null) return false
  return draft.replace(/\r\n?/g, '\n') !== saved.replace(/\r\n?/g, '\n')
}

/** Файл из списка по имени; нет в списке (старый main) — как отсутствующий. */
export function ruleByName(files: RuleFile[], name: RuleFileName): RuleFile {
  return files.find((f) => f.name === name) ?? { name, exists: false, text: '', eol: 'lf' }
}
