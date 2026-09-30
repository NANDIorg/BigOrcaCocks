// Разветвление графа глобальной задачи (`fork` … `join`): области путей на графе и позиции прогона внутри разветвления
// (`Run.lanes`). Контракт — docs/workflow.md, «Разветвление». Модуль импортирует renderer (подсветка путей, экран
// прогона) и workflow.ts (валидация), поэтому без node-импортов и без значений из workflow.ts — только типы:
// иначе импорт стал бы циклическим.
import type { Run, RunLane } from './types'
import type { WfEdge, WfForkBranch, WfNode, Workflow } from './workflow'

/** Id пути прогона (`RunLane.id`, `WfBranchStep.laneId`, `lane` в событиях): `<id ноды fork>:<id пути>`. */
export function laneId(forkId: string, branchId: string): string {
  return `${forkId}:${branchId}`
}

/** Сырые пути ноды: `branches` пришли из файла или UI, поэтому читаются без доверия к типам. */
function rawBranches(node: { branches?: unknown }): Array<{ id: string; label?: unknown }> {
  const raw: unknown = node.branches
  if (!Array.isArray(raw)) return []
  return raw.flatMap((b: unknown) => (b && typeof b === 'object' && typeof (b as { id?: unknown }).id === 'string' ? [b as { id: string; label?: unknown }] : []))
}

/** Id путей ноды `fork` в порядке редактора — её порты (`wfPorts`). Битые записи (не объект, id не строка) портов не дают. */
export function forkBranchIds(node: Extract<WfNode, { type: 'fork' }>): string[] {
  return rawBranches(node).map((b) => b.id)
}

/** Пути ноды `fork` без битых записей, название обрезано по краям; пустое — id пути. Для `workflow show`, событий и UI. */
export function forkBranches(node: Extract<WfNode, { type: 'fork' }>): WfForkBranch[] {
  return rawBranches(node).map((b) => ({ id: b.id, label: typeof b.label === 'string' && b.label.trim() ? b.label.trim() : b.id }))
}

/** Область одного пути разветвления (`laneRegions`). */
export interface LaneRegion {
  laneId: string
  branchId: string
  /** Куда ведёт порт пути; нет — у порта нет ребра. Равно `ForkRegions.joinId` — путь пустой (`fork` сразу в `join`). */
  entry?: string
  /**
   * Ноды пути в порядке обхода от входа: достижимы от входа без прохода через `join` и `fork`, кроме чужих (`leaked`).
   * Сам `join` сюда не входит.
   */
  nodes: string[]
  /**
   * Ноды, до которых путь дотянулся, но которые ему не принадлежат: конец и ноды вне разветвления — достижимые от старта
   * или после слияния, не проходя через `fork`, и сами не доходящие до `join` (ноды до разветвления, после слияния).
   * Их появление — утечка из пути (`forkBranchLeaks`, `forkEndInBranch`).
   */
  leaked: string[]
}

/** Области всех путей разветвления `forkId`. */
export interface ForkRegions {
  forkId: string
  /** Парный `join` (у `join` `forkId` указывает на эту ноду); нет — его нет или их несколько (`joins`). */
  joinId?: string
  /** Все `join`, которые называют этот `fork` своим. */
  joins: string[]
  lanes: LaneRegion[]
}

/**
 * Области путей разветвления: какие ноды принадлежат какому пути. Одна и та же функция нужна валидации (скобки
 * `fork`/`join`), store (чей путь у ноды) и редактору (подсветка). Область строится по рёбрам как есть, без проверки
 * графа: на битом графе области пересекаются или «протекают» — это и ищет `validateWorkflow`. Нет ноды `forkId` или это
 * не `fork` — undefined.
 */
export function laneRegions(wf: Pick<Workflow, 'nodes' | 'edges'>, forkId: string): ForkRegions | undefined {
  const fork = wf.nodes.find((n) => n.id === forkId)
  if (!fork || fork.type !== 'fork') return undefined
  const joins = wf.nodes.filter((n) => n.type === 'join' && n.forkId === forkId).map((n) => n.id)
  const stop = new Set([forkId, ...joins])
  const out = (id: string): WfEdge[] => wf.edges.filter((e) => e.from === id)
  // Кто доходит до слияния, не проходя через сам fork: обратный обход от всех его join.
  const toJoin = new Set<string>()
  const back = [...joins]
  while (back.length) {
    const id = back.shift()!
    for (const e of wf.edges) {
      if (e.to !== id || e.from === forkId || stop.has(e.from) || toJoin.has(e.from)) continue
      toJoin.add(e.from)
      back.push(e.from)
    }
  }
  // Что достижимо снаружи разветвления: от старта и после слияния, не проходя через fork.
  const outside = new Set<string>()
  const start = wf.nodes.find((n) => n.type === 'start')
  const ahead = [...(start ? [start.id] : []), ...joins.flatMap((j) => out(j).map((e) => e.to))]
  while (ahead.length) {
    const id = ahead.shift()!
    if (id === forkId || outside.has(id)) continue
    outside.add(id)
    ahead.push(...out(id).map((e) => e.to))
  }
  const foreign = (id: string): boolean =>
    wf.nodes.find((n) => n.id === id)?.type === 'end' || (outside.has(id) && !toJoin.has(id))
  const lanes = forkBranchIds(fork).map((branchId): LaneRegion => {
    const entry = out(forkId).find((e) => e.outcome === branchId)?.to
    const seen: string[] = []
    const queue = entry !== undefined && !stop.has(entry) ? [entry] : []
    while (queue.length) {
      const id = queue.shift()!
      if (seen.includes(id) || !wf.nodes.some((n) => n.id === id)) continue
      seen.push(id)
      for (const e of out(id)) if (!stop.has(e.to)) queue.push(e.to)
    }
    return {
      laneId: laneId(forkId, branchId), branchId, ...(entry !== undefined ? { entry } : {}),
      nodes: seen.filter((id) => !foreign(id)),
      leaked: seen.filter(foreign)
    }
  })
  return { forkId, ...(joins.length === 1 ? { joinId: joins[0] } : {}), joins, lanes }
}

/**
 * Какому пути принадлежит нода: первый `fork`, в области пути которого она лежит (`LaneRegion.nodes`). Нода вне
 * разветвлений, сам `fork` и `join` — undefined. На валидном графе путь у ноды один (области не пересекаются).
 */
export function nodeLane(wf: Pick<Workflow, 'nodes' | 'edges'>, nodeId: string): { forkId: string; branchId: string; laneId: string } | undefined {
  for (const n of wf.nodes) {
    if (n.type !== 'fork') continue
    const lane = laneRegions(wf, n.id)?.lanes.find((l) => l.nodes.includes(nodeId))
    if (lane) return { forkId: n.id, branchId: lane.branchId, laneId: lane.laneId }
  }
  return undefined
}

/**
 * Активная позиция прогона: основная (`Run.stage`, путей нет) или позиция пути (`Run.lanes`). Единый способ для store,
 * main и renderer прочитать «где сейчас глобальная задача», не разбирая оба поля самим.
 */
export interface RunPosition {
  nodeId: string
  /** Id пути (`RunLane.id`); нет — основная позиция прогона. */
  lane?: string
  /** Заход в ноду (`Run.stage.visits[nodeId]`, счётчики общие на весь прогон); нет счётчика — 1. */
  visit: number
  /** Путь пришёл в `join` и ждёт остальные (`RunLane.arrivedAt`). */
  arrived?: true
  /** Что сказали проверка или человек при входе в этап этой позиции (`Run.stageInput` или `RunLane.stageInput`). */
  input?: Run['stageInput']
  /** Подзадачи «Работы» этой позиции закрыты (`Run.stageTasksDoneAt` или `RunLane.stageTasksDoneAt`). */
  tasksDoneAt?: number
}

type RunPositionSource = Pick<Run, 'stage' | 'lanes' | 'stageInput' | 'stageTasksDoneAt'>

/** Основная позиция: `Run.stage` (при путях — нода `fork`, на которой прогон стоит до слияния). */
function trunk(run: RunPositionSource): RunPosition | undefined {
  const stage = run.stage
  if (!stage) return undefined
  return {
    nodeId: stage.nodeId, visit: stage.visits[stage.nodeId] ?? 1,
    ...(run.stageInput ? { input: run.stageInput } : {}),
    ...(run.stageTasksDoneAt !== undefined ? { tasksDoneAt: run.stageTasksDoneAt } : {})
  }
}

function lanePosition(run: RunPositionSource, lane: RunLane): RunPosition {
  return {
    nodeId: lane.nodeId, lane: lane.id, visit: run.stage?.visits[lane.nodeId] ?? 1,
    ...(lane.arrivedAt !== undefined ? { arrived: true as const } : {}),
    ...(lane.stageInput ? { input: lane.stageInput } : {}),
    ...(lane.stageTasksDoneAt !== undefined ? { tasksDoneAt: lane.stageTasksDoneAt } : {})
  }
}

/**
 * Все активные позиции прогона: граф не начат — пусто; путей нет — одна основная (как было всегда); внутри
 * разветвления — по позиции на путь в порядке `Run.lanes` (основная, на `fork`, в список не входит).
 */
export function runPositions(run: RunPositionSource): RunPosition[] {
  if (!run.stage) return []
  if (run.lanes && run.lanes.length > 0) return run.lanes.map((l) => lanePosition(run, l))
  const main = trunk(run)
  return main ? [main] : []
}

/**
 * Позиция на ноде `nodeId`: среди путей, иначе основная, если стоит на ней. Нет `nodeId` — основная позиция. Нет такой
 * позиции — undefined: решение по этой ноде опоздало, граф ушёл дальше. Несколько путей в одном `join` — первый.
 */
export function runPositionAt(run: RunPositionSource, nodeId?: string): RunPosition | undefined {
  if (nodeId === undefined) return trunk(run)
  const lane = run.lanes?.find((l) => l.nodeId === nodeId)
  if (lane) return lanePosition(run, lane)
  return run.stage?.nodeId === nodeId ? trunk(run) : undefined
}
