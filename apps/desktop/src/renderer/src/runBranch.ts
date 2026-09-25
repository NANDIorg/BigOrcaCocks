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
    t('global.branch.copyHint')
  ]
  return {
    label: git.branch,
    tone: git.pushError ? 'warn' : git.pushedAt !== undefined ? 'ok' : 'plain',
    title: lines.join('\n')
  }
}
