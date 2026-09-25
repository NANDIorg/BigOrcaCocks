import type { RunGit } from '@orca-board/core'
import { t } from './i18n'
import { formatStamp } from './boardSort'

/** Чип ветки глобальной задачи в шапке: подпись — имя ветки, тон — итог push, подсказка — база, worktree, push. */
export interface BranchChip {
  label: string
  tone: 'plain' | 'ok' | 'warn'
  title: string
}

/**
 * Состояние ветки для шапки (`GlobalTaskHeader`). Ошибка push важнее старого успеха: после неё ветка на remote
 * может быть не свежей. Нет worktree — его убрали после «Сделано», ветка осталась в репозитории.
 */
export function branchChip(git: RunGit): BranchChip {
  const lines = [
    t('global.branch.base', { base: git.base }),
    git.worktree ? t('global.branch.worktree', { path: git.worktree }) : t('global.branch.noWorktree'),
    git.pushError
      ? t('global.branch.pushError', { error: git.pushError })
      : git.pushedAt !== undefined
        ? t('global.branch.pushed', { date: formatStamp(git.pushedAt) })
        : t('global.branch.notPushed'),
    ...(git.prError
      ? [t('global.branch.prError', { error: prErrorText(git) })]
      : git.prUrl ? [t('global.branch.pr', { url: git.prUrl })] : []),
    t('global.branch.copyHint')
  ]
  return {
    label: git.branch,
    tone: git.pushError || git.prError ? 'warn' : git.pushedAt !== undefined ? 'ok' : 'plain',
    title: lines.join('\n')
  }
}

/** Причина ошибки PR: «нет gh» и «нет логина» — на языке интерфейса, остальное — текст gh (`prError`) как есть. */
export function prErrorText(git: RunGit): string {
  if (git.prErrorCode === 'ghMissing') return t('global.branch.prGhMissing')
  if (git.prErrorCode === 'ghAuth') return t('global.branch.prGhAuth')
  return git.prError ?? ''
}

/** Ссылка на PR для чипа: только https — значение приходит из вывода `gh`, в `href` ему без проверки не место. */
export function prLink(git: RunGit): string | undefined {
  return git.prUrl && git.prUrl.startsWith('https://') ? git.prUrl : undefined
}
