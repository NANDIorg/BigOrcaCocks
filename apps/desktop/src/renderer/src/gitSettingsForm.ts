import { isProtectedBranch, prBaseBranch, type RunBranchSettings } from '@orca-board/core'
import type { GhStatus } from '../../shared/ipc'
import { t } from './i18n'

// Логика раздела «О проекте → Git» без React: режим, «когда готово» и схема пути работы (GitSection.tsx).
// Модель настроек прежняя (enabled/push/pr), форма лишь показывает её как два режима и один выбор из трёх.

/** Что приложение делает с веткой глобальной задачи, когда та уходит на «Проверку». */
export type GitFinish = 'none' | 'push' | 'pr'

export const GIT_FINISHES: readonly GitFinish[] = ['none', 'push', 'pr']

/** PR без push не бывает (`prNeedsPush`), поэтому три варианта вместо двух зависимых переключателей. */
export function gitFinish(s: Pick<RunBranchSettings, 'push' | 'pr'>): GitFinish {
  if (!s.push) return 'none'
  return s.pr ? 'pr' : 'push'
}

export function withGitFinish(finish: GitFinish): Pick<RunBranchSettings, 'push' | 'pr'> {
  return { push: finish !== 'none', pr: finish === 'pr' }
}

/** Начало шаблона до первой подстановки: `feature/{runId}-{slug}` → `feature/…`. */
function branchPrefix(template: string): string {
  return `${template.split('{')[0]}…`
}

/**
 * Путь готовой работы для схемы под режимом: `подзадача → main` или `подзадача → feature/… → PR → develop`.
 * `current` — ветка, открытая в проекте сейчас (null — неизвестна или detached HEAD).
 */
export function gitFlow(s: RunBranchSettings, current: string | null, mode: 'current' | 'run'): string[] {
  const here = current ?? t('config.about.git.flow.current')
  const subtask = t('config.about.git.flow.subtask')
  if (mode === 'current') return [subtask, here]
  const steps = [subtask, branchPrefix(s.template)]
  const finish = gitFinish(s)
  if (finish === 'push') steps.push(s.remote)
  // База PR — «От чего ответвлять» без remote; пусто — ветка, открытая в проекте при старте задачи.
  if (finish === 'pr') steps.push('PR', (s.base.trim() ? prBaseBranch(s.base, s.remote) : undefined) ?? here)
  return steps
}

/**
 * Ветка проекта защищена — подзадачи без ветки глобальной задачи в неё не сольются (`git.protectedBranch`).
 * Предупреждаем в форме заранее, а не когда задача встанет в `workflow_blocked`.
 */
export function currentBranchProtected(current: string | null, protectedList: string): boolean {
  if (!current) return false
  return isProtectedBranch(current, protectedList.split(',').map((p) => p.trim()).filter(Boolean))
}

/** Проверка gh под «Push + PR»: ещё идёт, итог `projects:ghStatus` или старый preload без метода. */
export type GhCheck = { state: 'checking' } | { state: 'stale' } | GhStatus

/**
 * Строка под «Push + PR»: готов ли gh открыть PR. Проблему видно при настройке, а не после первой глобальной
 * задачи. Сохранить с ней можно: gh могут поставить или авторизовать позже.
 */
export function ghNote(check: GhCheck): { tone: 'ok' | 'warn' | 'muted'; text: string } {
  switch (check.state) {
    case 'checking': return { tone: 'muted', text: t('config.about.git.gh.checking') }
    case 'ok': return { tone: 'ok', text: t('config.about.git.gh.ok', { repo: check.repo }) }
    case 'missing': return { tone: 'warn', text: t('config.about.git.gh.missing') }
    case 'noAuth': return { tone: 'warn', text: t('config.about.git.gh.noAuth') }
    case 'notGithub': return { tone: 'warn', text: t('config.about.git.gh.notGithub') }
    case 'error': return { tone: 'warn', text: t('config.about.git.gh.error', { detail: check.detail }) }
    case 'stale': return { tone: 'warn', text: t('config.about.git.gh.stale') }
  }
}
