import type { OrcaApi } from '../../shared/ipc'

/** Как STALE_APP_MESSAGE в docLinks.ts: renderer обновился по HMR, а main/preload — ещё нет. */
export const AGENT_RULES_STALE_MESSAGE =
  'Приложение запущено со старой версией main/preload, где ещё нет «Правил доски». Перезапустите приложение.'

/** Пример в пустом редакторе: типичное правило, которое нужно агентам доски, но не обычным сессиям. */
export const AGENT_RULES_PLACEHOLDER = [
  '# Например',
  '',
  '- Не создавать задачи, не писать комментарии и отчёты в ORION.',
  '- Результат сдавать только через orca-board, без файлов-отчётов в репозитории.'
].join('\n')

type SetAgentRules = OrcaApi['projects']['setAgentRules']

/** `window.orca.projects.setAgentRules` или понятная ошибка: старый preload этого метода не знает. */
export function agentRulesApi(api: { projects?: Partial<OrcaApi['projects']> } | undefined): SetAgentRules {
  const set = api?.projects?.setAgentRules
  if (!set) throw new Error(AGENT_RULES_STALE_MESSAGE)
  return set
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'projects:setAgentRules'». */
export function isStaleAgentRulesError(message: string): boolean {
  return /No handler registered for 'projects:(get|set)AgentRules'/.test(message)
}

/** Подпись счётчика в меню «О проекте»: сколько непустых строк правил, пусто — «нет». */
export function agentRulesCount(rules: string | undefined): string {
  const lines = (rules ?? '').split(/\r?\n/).filter((l) => l.trim()).length
  return lines ? `${lines} стр.` : 'нет'
}
