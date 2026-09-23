import { sectionDiffLine, sectionsDiff, stableJson, type AgentInfo } from '@orca-board/core'
import type { Project, ProjectDefaults } from '../../../shared/ipc'

/** JSON с отсортированными ключами — `stableJson` из core, имя оставлено для редактора воркфлоу. */
export const stable = stableJson

/**
 * Чем настройки проекта отличаются от дефолта для новых проектов — строки для «Обзора»
 * («роли (+1 «Дизайнер»)», «разрешения»). Пустой массив — совпадают. Сравнение — `sectionsDiff` из core.
 */
export function defaultsDiff(p: Project, d: ProjectDefaults, agents: AgentInfo[]): string[] {
  return sectionsDiff(p, d, agents).map((x) => sectionDiffLine(x, agents))
}
