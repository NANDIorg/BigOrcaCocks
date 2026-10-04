import type { RunGit } from '@orca-board/core'
import { t } from './i18n'

/** Чип ветки глобальной задачи в шапке: подпись — имя ветки, подсказка — база и worktree. */
export interface BranchChip {
  label: string
  title: string
}

/**
 * Ветка для шапки (`GlobalTaskHeader`). Нет worktree — его убрали после «Сделано», ветка осталась в репозитории:
 * что с ней делать дальше (push, PR, мерж), решает человек.
 */
export function branchChip(git: RunGit): BranchChip {
  const lines = [
    t('global.branch.base', { base: git.base }),
    git.worktree ? t('global.branch.worktree', { path: git.worktree }) : t('global.branch.noWorktree'),
    t('global.branch.copyHint')
  ]
  return { label: git.branch, title: lines.join('\n') }
}
