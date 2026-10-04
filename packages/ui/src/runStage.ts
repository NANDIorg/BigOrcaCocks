import { forkBranches, laneId, type GlobalTask, type Task, type WfNodeType, type Workflow } from '@orca-board/core'
import { t, type TKey } from './i18n'
import { forkBranchTitle, nodeTitle } from './defaultTitles'
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
  merge: 'global.stage.hint.merge',
  decision: 'global.stage.hint.decision'
}

/** Позиция графа прогона для UI: основная (`stage`) или путь разветвления (`lanes`). */
export interface RunStagePosition {
  nodeId: string
  /** Заход в ноду (`stage.visits`, счётчики общие на весь прогон); нет счётчика — 1. */
  visit: number
  /** Id пути (`GlobalTaskLane.id`); нет — основная позиция. */
  lane?: string
  /** Путь пришёл в слияние (`join`) и ждёт остальные. */
  arrived: boolean
}

type PositionSource = Partial<Pick<GlobalTask, 'stage' | 'lanes'>>

/**
 * Где стоит граф прогона: без путей — одна позиция `stage` (как всегда), внутри разветвления — по позиции на путь в
 * порядке `lanes` (нода `fork`, на которой «запаркован» `stage`, в список не входит). Как `runPositions` в core, но по
 * снимку `GlobalTask`: там у путей только поля для UI. Граф не начат — пусто.
 */
export function runStagePositions(g: PositionSource): RunStagePosition[] {
  const stage = g.stage
  if (!stage) return []
  const visit = (id: string): number => stage.visits?.[id] ?? 1
  if (g.lanes && g.lanes.length > 0) {
    return g.lanes.map((l) => ({ nodeId: l.nodeId, visit: visit(l.nodeId), lane: l.id, arrived: l.arrivedAt !== undefined }))
  }
  return [{ nodeId: stage.nodeId, visit: visit(stage.nodeId), arrived: false }]
}

/** Ноды, на которых граф работает сейчас: позиции без путей, уже пришедших в слияние. */
export function activeStageNodes(g: PositionSource): RunStagePosition[] {
  return runStagePositions(g).filter((p) => !p.arrived)
}

/**
 * Название пути разветвления по его id (`<fork>:<путь>`): подпись пути из ноды `fork` графа. Графа нет или путь из него
 * убрали — id пути без ноды `fork`: он хотя бы короткий.
 */
export function laneTitle(workflow: Pick<Workflow, 'nodes'> | undefined, lane: string): string {
  for (const n of workflow?.nodes ?? []) {
    if (n.type !== 'fork') continue
    const branch = forkBranches(n).find((b) => laneId(n.id, b.id) === lane)
    if (branch) return forkBranchTitle(branch)
  }
  const sep = lane.indexOf(':')
  return sep >= 0 && sep < lane.length - 1 ? lane.slice(sep + 1) : lane
}

/**
 * Пилюля «где сейчас граф» у глобальной задачи: название ноды из графа прогона (`workflow`) и «N-й заход» со второго.
 * Нет позиции (граф не начат, прогон старого формата, старый main), нет графа или нода неизвестна — null: id ноды
 * человеку ничего не говорит. На старте и на конце подписи тоже нет: старт задача проходит насквозь, а конец — это «Сделано».
 * Внутри разветвления — этапы всех путей через « · » («Бэкенд · Фронтенд»); путь, пришедший в слияние, в подписи не
 * виден, но назван в подсказке. Пришли все — название слияния.
 */
export function runStageLabel(
  g: Partial<Pick<GlobalTask, 'stage' | 'workflowScope' | 'lanes'>>,
  workflow: Workflow | undefined
): StageLabel | null {
  const stage = g.stage
  if (g.workflowScope !== 'run' || !stage || !workflow) return null
  if (g.lanes && g.lanes.length > 0) return lanesLabel(g, workflow)
  const node = workflow.nodes.find((n) => n.id === stage.nodeId)
  if (!node || node.type === 'start' || node.type === 'end') return null
  const name = nodeTitle(node)
  const visits = stage.visits?.[stage.nodeId] ?? 1
  const text = visits > 1 ? t('board.stage.visit', { name, n: visits }) : name
  return { kind: node.type === 'gate' ? 'gate' : 'stage', text, title: t(HINT_KEYS[node.type] ?? 'global.stage.hint.other', { name }) }
}

/** Пилюля разветвления: этап каждого пути; подсказка — строка на путь: «Бэкенд: «Реализация»», «Фронтенд: ждёт в слиянии». */
function lanesLabel(g: PositionSource, workflow: Workflow): StageLabel | null {
  const positions = runStagePositions(g)
  const named = positions.flatMap((p) => {
    const node = workflow.nodes.find((n) => n.id === p.nodeId)
    if (!node) return []
    const name = nodeTitle(node)
    return [{ p, node, name, text: p.visit > 1 && !p.arrived ? t('board.stage.visit', { name, n: p.visit }) : name }]
  })
  if (named.length === 0) return null
  const active = named.filter((x) => !x.p.arrived)
  // Пришли все: барьер вот-вот откроется — показываем само слияние.
  const shown = active.length > 0 ? active : named.slice(0, 1)
  const lines = named.map((x) => {
    const lane = x.p.lane ? laneTitle(workflow, x.p.lane) : x.name
    return x.p.arrived ? t('global.stage.laneArrived', { lane }) : t('global.stage.laneAt', { lane, name: x.name })
  })
  return {
    kind: active.length > 0 && active.every((x) => x.node.type === 'gate') ? 'gate' : 'stage',
    text: shown.map((x) => x.text).join(' · '),
    title: [t('global.stage.hint.lanes', { n: named.length }), ...lines].join('\n')
  }
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
