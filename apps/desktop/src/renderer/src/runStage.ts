import type { GlobalTask, Task, WfNodeType, Workflow } from '@orca-board/core'
import { t, type TKey } from './i18n'
import { nodeTitle } from './defaultTitles'
import type { StageLabel } from './cardState'

// Воркфлоу глобальной задачи (`Run.workflowScope: 'run'`, docs/workflow.md): где стоит граф и как подзадачи привязаны к этапам.
// Чистые функции без React: пилюля этапа на карточке и в шапке, группы подзадач на доске. Всё, что читается из снимка,
// необязательно — старый main этих полей не отдаёт, тогда пилюли и групп просто нет.

/** Подсказка пилюли по типу ноды, на которой стоит глобальная задача; остальные типы — общая. */
const HINT_KEYS: Partial<Record<WfNodeType, TKey>> = {
  work: 'global.stage.hint.work',
  ask: 'global.stage.hint.ask',
  gate: 'global.stage.hint.gate',
  human: 'global.stage.hint.human',
  git: 'global.stage.hint.git',
  merge: 'global.stage.hint.merge'
}

/**
 * Пилюля «где сейчас граф» у глобальной задачи: название ноды из графа прогона (`workflow`) и «N-й заход» со второго.
 * Нет позиции (граф не начат, прогон старого формата, старый main), нет графа или нода неизвестна — null: id ноды
 * человеку ничего не говорит. На старте и на конце подписи тоже нет: старт задача проходит насквозь, а конец — это «Сделано».
 */
export function runStageLabel(
  g: Partial<Pick<GlobalTask, 'stage' | 'workflowScope'>>,
  workflow: Workflow | undefined
): StageLabel | null {
  const stage = g.stage
  if (g.workflowScope !== 'run' || !stage || !workflow) return null
  const node = workflow.nodes.find((n) => n.id === stage.nodeId)
  if (!node || node.type === 'start' || node.type === 'end') return null
  const name = nodeTitle(node)
  const visits = stage.visits?.[stage.nodeId] ?? 1
  const text = visits > 1 ? t('board.stage.visit', { name, n: visits }) : name
  return { kind: node.type === 'gate' ? 'gate' : 'stage', text, title: t(HINT_KEYS[node.type] ?? 'global.stage.hint.other', { name }) }
}

/** Ключ этапа подзадачи: `узел#заход`; пустой — задача не привязана к этапу (заведена до входа в граф, старый движок). */
export function taskStageKey(task: Partial<Pick<Task, 'stageOf'>>): string {
  return task.stageOf ? `${task.stageOf.nodeId}#${task.stageOf.visit}` : ''
}

/** Группа подзадач одного этапа на доске. */
export interface StageGroup {
  /** `taskStageKey`. */
  key: string
  /** «Реализация · 2/3»; у задач без этапа — «Без этапа · 1/1». */
  label: string
  /** Порядок показа: группы идут в порядке появления этапов (по времени создания первой подзадачи). */
  order: number
}

/**
 * Группы подзадач по этапам: ключ этапа → подпись с прогрессом «сделано / всего» и порядок. Считается по всем
 * подзадачам доски, а не по колонке, чтобы подпись была одной и той же во всех колонках. Группировать нечего —
 * подзадачи одного этапа (или ни одной с `stageOf`), названий нод нет (старый main, тип без графа) — null.
 */
export function stageGroups(
  tasks: readonly Pick<Task, 'stageOf' | 'createdAt' | 'status'>[],
  titles: Readonly<Record<string, string>> | undefined,
  isDone: (status: string) => boolean
): Map<string, StageGroup> | null {
  if (!titles) return null
  const acc = new Map<string, { stageOf: Task['stageOf']; first: number; done: number; total: number }>()
  for (const task of tasks) {
    const key = taskStageKey(task)
    const cur = acc.get(key) ?? { stageOf: task.stageOf, first: task.createdAt, done: 0, total: 0 }
    cur.first = Math.min(cur.first, task.createdAt)
    cur.total++
    if (isDone(task.status)) cur.done++
    acc.set(key, cur)
  }
  if (acc.size < 2) return null
  const groups = new Map<string, StageGroup>()
  const ordered = [...acc.entries()].sort((a, b) => a[1].first - b[1].first)
  ordered.forEach(([key, g], order) => {
    const counts = { done: g.done, total: g.total }
    let label: string
    if (!g.stageOf) label = t('board.stage.groupNone', counts)
    else {
      const name = titles[g.stageOf.nodeId] ?? g.stageOf.nodeId
      label = g.stageOf.visit > 1
        ? t('board.stage.groupVisit', { name, n: g.stageOf.visit, ...counts })
        : t('board.stage.group', { name, ...counts })
    }
    groups.set(key, { key, label, order })
  })
  return groups
}

/** Разбить подзадачи колонки на группы этапов в порядке этапов; `groups` нет — одна безымянная группа. */
export function splitByStage<T extends Pick<Task, 'stageOf'>>(
  items: readonly T[],
  groups: ReadonlyMap<string, StageGroup> | null
): { label?: string; items: T[] }[] {
  if (!groups) return [{ items: [...items] }]
  const byKey = new Map<string, T[]>()
  for (const item of items) {
    const key = taskStageKey(item)
    byKey.set(key, [...(byKey.get(key) ?? []), item])
  }
  return [...byKey.entries()]
    .sort((a, b) => (groups.get(a[0])?.order ?? 0) - (groups.get(b[0])?.order ?? 0))
    .map(([key, list]) => ({ label: groups.get(key)?.label, items: list }))
}
