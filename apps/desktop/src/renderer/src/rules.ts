import { isRuleFileName, RULE_FILE_NAMES, type OrcaApi, type RuleFile, type RuleFileName } from '../../shared/ipc'
import { t } from './i18n'

/** Как staleAppMessage() в docLinks.ts: renderer обновился по HMR, а main/preload — ещё нет. */
export function rulesStaleMessage(): string {
  return t('config.about.rules.stale')
}

/** `window.orca.rules` или понятная ошибка вместо «Cannot read properties of undefined». */
export function rulesApi(api: Partial<OrcaApi> | undefined): OrcaApi['rules'] {
  if (!api?.rules) throw new Error(rulesStaleMessage())
  return api.rules
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'rules:…'». */
export function isStaleRulesError(message: string): boolean {
  return /No handler registered for 'rules:/.test(message)
}

/** Для чего файл — подпись под переключателем. Геттеры: текст на текущем языке интерфейса. */
export const RULE_HINTS: Record<RuleFileName, string> = {
  get 'CLAUDE.md'() {
    return t('config.about.rules.hintClaude')
  },
  get 'AGENTS.md'() {
    return t('config.about.rules.hintAgents')
  }
}

/**
 * Заготовка для «Создать»: AGENTS.md отсылает к CLAUDE.md, CLAUDE.md — пустой каркас разделов.
 * На языке интерфейса: файл пишет человек, заготовка — только подсказка структуры.
 */
export const RULE_TEMPLATES: Record<RuleFileName, string> = {
  get 'CLAUDE.md'() {
    const sections = ['tplDont', 'tplMust', 'tplStyle', 'tplChecks', 'tplGit'] as const
    return [
      `# ${t('config.about.rules.tplTitle')}`,
      '',
      ...sections.flatMap((k) => [`## ${t(`config.about.rules.${k}`)}`, '', '- ', ''])
    ].join('\n')
  },
  get 'AGENTS.md'() {
    return `# ${t('config.about.rules.tplTitle')}\n\n${t('config.about.rules.tplAgents')}\n`
  }
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
