import type React from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { BoardColumn, GlobalTask, Task, WfNode, WfSubflow, Workflow } from '@orca-board/core'
import { WfNodeIcon } from './icons'
import { useT, type TFunction } from './i18n'
import { nodeTitle } from './defaultTitles'
import { fullStamp } from './globalFormat'
import { formatClock } from './globalTimeline'
import { WF_TYPE_TITLES } from './workflowForm'
import { wfPortClass, wfPortLabel } from './workflowEdit'
import { NODE_H, NODE_W, curvePath, curvePoint, edgeCurveOf, graphBounds, nodeHeight } from './workflowGeometry'
import { pathNodeName } from './subtaskPath'
import { laneTitle } from './runStage'
import {
  defaultProgressNode, isPassThrough, nodeVisits, passExits, pathProgress, progressLayout, runProgress, subtaskPathSteps, visitTasks,
  workPath, type NodeVisit, type PassExit, type PathStep, type ProgressLane, type ProgressNodeState
} from './workflowProgress'

interface Props {
  global: GlobalTask
  /** Граф прогона (`workflowForRun`); нет — типы ещё не загрузились или старый main: заглушка. */
  workflow?: Workflow
  /** Название типа задачи — в крошках «Граф типа «…»». */
  typeTitle?: string
  /** Подзадачи этой глобальной задачи. */
  tasks: Task[]
  /** Колонки доски подзадач: статус подзадачи, у которой нет пути (проверка, вопрос). */
  columns: BoardColumn[]
  /** Выбранная нода; нет — текущая (`defaultProgressNode`). */
  selected?: string
  onSelect(nodeId: string): void
  onOpenTask(taskId: string): void
}

type Graph = Pick<WfSubflow, 'nodes' | 'edges'>

/** Плашка над нодой: «сейчас · 2-й заход» на графе прогона, число подзадач на пути подзадачи. */
interface Badge {
  text: string
  bad: boolean
  title?: string
}

interface NodeView {
  state: ProgressNodeState
  visits: number
}

/** Подпись на ноде обрезается: полное название — в подсказке и в панели справа. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Ширина плашки по тексту: в SVG нет автоширины, а измерять текст в DOM ради плашки — лишний проход. */
function badgeWidth(text: string): number {
  return Math.round(text.length * 6.2 + 16)
}

function stateText(t: TFunction, state: ProgressNodeState, visit: number): string {
  if (state === 'current') return visit > 1 ? t('global.graph.state.currentVisit', { n: visit }) : t('global.graph.state.current')
  if (state === 'waiting') return t('global.graph.state.waiting')
  return t(state === 'done' ? 'global.graph.state.done' : 'global.graph.state.todo')
}

/** Пути разветвления, которые касаются ноды: у `fork` — его пути, у `join` — пути его `fork`; у прочих нод — пусто. */
function nodeLanes(node: WfNode, lanes: readonly ProgressLane[]): ProgressLane[] {
  if (node.type === 'fork') return lanes.filter((l) => l.forkId === node.id)
  if (node.type === 'join') return lanes.filter((l) => l.forkId === node.forkId)
  return []
}

/**
 * Вкладка «Граф» экрана глобальной задачи (макет `docs/design/workflow-progress/variant-a.html`): граф воркфлоу только для
 * чтения — пройденные ноды и переходы, текущая нода, возвраты — и панель выбранной ноды: заходы, причины возвратов, сводки,
 * подзадачи захода с пилюлей пути. «Открыть путь подзадачи» показывает путь «Работы» со сводкой по её подзадачам. Логика —
 * `workflowProgress.ts`, раскладка — координаты графа из редактора (`workflowGeometry.ts`).
 */
export function WorkflowProgress(props: Props): React.JSX.Element {
  const { global, workflow, tasks, columns, onSelect, onOpenTask } = props
  const t = useT()
  const [pathOf, setPathOf] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Внутри разветвления «сейчас» несколько: прокрутка следует за любой их сменой.
  const current = [global.stage?.nodeId, ...(global.lanes ?? []).map((l) => l.nodeId)].join(',')
  // Широкий граф в узком окне прокручивается по горизонтали: выбранная (иначе текущая) нода не должна оказаться за краем.
  useEffect(() => {
    const box = scrollRef.current
    const el = box?.querySelector<SVGGElement>('.wf-progress-node.is-selected') ?? box?.querySelector<SVGGElement>('.wf-progress-node.is-current')
    if (!box || !el || box.scrollWidth <= box.clientWidth) return
    const r = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    box.scrollLeft += r.left + r.width / 2 - (b.left + b.width / 2)
  }, [current, props.selected, pathOf])
  if (!workflow || workflow.nodes.length === 0) {
    return <p className="muted gt-stub">{t('global.graph.noWorkflow')}</p>
  }
  const graph = progressLayout(workflow)
  const progress = runProgress(global, graph)
  const selId = props.selected && graph.nodes.some((n) => n.id === props.selected) ? props.selected : defaultProgressNode(progress, global, graph)
  const selNode = graph.nodes.find((n) => n.id === selId)
  const currentIds = progress.currents.map((c) => c.nodeId)
  const visits = selId ? nodeVisits(global, selId, currentIds) : []
  const shown = visits.at(-1)
  const shownTasks = selId && shown ? visitTasks(tasks, selId, shown) : []
  const path = selId ? workPath(workflow, selId) : undefined
  // Проваливание живёт, пока выбрана та же «Работа»: клик по ссылке «на графе» в «Истории» выбирает другую ноду — назад к графу.
  const drill = pathOf !== null && pathOf === selId && path && selNode?.type === 'work' ? selNode : undefined

  const select = (id: string): void => {
    setPathOf(null)
    onSelect(id)
  }

  const nameOf = (id: string): string => {
    const n = graph.nodes.find((x) => x.id === id)
    return n ? nodeTitle(n) : id
  }
  const currentNode = graph.nodes.find((n) => n.id === progress.current)
  const waitingJoin = progress.lanes.find((l) => l.arrived)?.nodeId
  const aria = t('global.graph.aria', {
    state: progress.currents.length > 1
      ? t('global.graph.ariaNowMany', { names: progress.currents.map((c) => `«${nameOf(c.nodeId)}»`).join(', ') })
      : currentNode
        ? progress.currentVisit > 1
          ? t('global.graph.ariaNowVisit', { name: nodeTitle(currentNode), n: progress.currentVisit })
          : t('global.graph.ariaNow', { name: nodeTitle(currentNode) })
        : waitingJoin
          ? t('global.graph.ariaWaiting', { name: nameOf(waitingJoin) })
          : t(progress.closed ? 'global.graph.ariaDone' : 'global.graph.ariaIdle')
  })

  let canvas: React.JSX.Element
  if (drill && path) {
    const laid = progressLayout(path)
    const pp = pathProgress(shownTasks, workflow, drill.id)
    const badges: Record<string, Badge> = {}
    for (const n of laid.nodes) {
      const here = pp?.nodes[n.id]?.here ?? []
      if (here.length === 0) continue
      const titles = here.map((id) => tasks.find((x) => x.id === id)?.title ?? id)
      badges[n.id] = { text: t('global.progress.subtasks', { count: here.length }), bad: n.type === 'human', title: t('global.graph.pathHere', { names: titles.join(', ') }) }
    }
    canvas = (
      <ProgressGraph
        graph={laid}
        name={(n) => pathNodeName(n, drill)}
        nodes={pp?.nodes ?? {}}
        edges={pp?.edges ?? {}}
        badges={badges}
        forwardCounts={false}
        ariaLabel={t('global.graph.pathAria', { name: nodeTitle(drill) })}
      />
    )
  } else {
    const badges: Record<string, Badge> = {}
    for (const c of progress.currents) {
      const text = c.visit > 1 ? t('global.graph.badge.nowVisit', { n: c.visit }) : t('global.graph.badge.now')
      const lane = c.lane !== undefined ? t('global.graph.visitLane', { name: laneTitle(workflow, c.lane) }) : undefined
      badges[c.nodeId] = { text, bad: c.returned, ...(lane ? { title: `${nameOf(c.nodeId)} — ${lane}` } : {}) }
    }
    // Слияние, куда пришла часть путей: «ждёт · 1 из 2», в подсказке — кого ждёт.
    for (const n of graph.nodes) {
      if (n.type !== 'join' || progress.nodes[n.id]?.state !== 'waiting') continue
      const lanes = nodeLanes(n, progress.lanes)
      const pending = lanes.filter((l) => !l.arrived).map((l) => laneTitle(workflow, l.id))
      badges[n.id] = {
        text: t('global.graph.badge.waiting', { n: lanes.filter((l) => l.arrived).length, total: lanes.length }),
        bad: false,
        ...(pending.length ? { title: t('global.graph.waitingFor', { names: pending.join(', ') }) } : {})
      }
    }
    canvas = (
      <ProgressGraph
        graph={graph}
        name={nodeTitle}
        nodes={progress.nodes}
        edges={progress.edges}
        badges={badges}
        selected={selId}
        onSelect={select}
        ariaLabel={aria}
      />
    )
  }

  return (
    <div className="wf-progress">
      <section className="gt-box wf-progress-canvas" aria-label={aria}>
        <div className="wf-progress-bar">
          <nav className="wf-progress-crumbs" aria-label={t('global.graph.crumbAria')}>
            {drill ? (
              <>
                <button type="button" className="btn-text" onClick={() => setPathOf(null)}>
                  {props.typeTitle ? t('global.graph.crumbType', { type: props.typeTitle }) : t('global.graph.crumbRoot')}
                </button>
                <span className="muted" aria-hidden>›</span>
                <b>{t('global.graph.crumbPath', { name: nodeTitle(drill) })}</b>
              </>
            ) : (
              <b>{props.typeTitle ? t('global.graph.crumbType', { type: props.typeTitle }) : t('global.graph.crumbRoot')}</b>
            )}
          </nav>
          <span className="chip wf-progress-ro">{t('global.graph.readOnly')}</span>
        </div>
        <div ref={scrollRef} className="wf-progress-scroll">{canvas}</div>
        <div className="wf-progress-legend" role="list" aria-label={t('global.graph.legendAria')}>
          <span role="listitem"><i className="is-done" aria-hidden />{t('global.graph.legend.done')}</span>
          <span role="listitem"><i className="is-current" aria-hidden />{t('global.graph.legend.current')}</span>
          {graph.nodes.some((n) => n.type === 'join') && (
            <span role="listitem"><i className="is-waiting" aria-hidden />{t('global.graph.legend.waiting')}</span>
          )}
          <span role="listitem"><i className="is-todo" aria-hidden />{t('global.graph.legend.todo')}</span>
          <span role="listitem"><i className="is-accept" aria-hidden />{t('global.graph.legend.accept')}</span>
          <span role="listitem"><i className="is-return" aria-hidden />{t('global.graph.legend.return')}</span>
        </div>
      </section>
      {selNode && (
        <NodePanel
          node={selNode}
          graph={graph}
          view={progress.nodes[selNode.id] ?? { state: 'todo', visits: 0 }}
          currentVisit={progress.currents.find((c) => c.nodeId === selNode.id)?.visit ?? 0}
          visits={visits}
          lanes={nodeLanes(selNode, progress.lanes)}
          exits={passExits(graph, progress.edges, selNode.id)}
          shownTasks={shownTasks}
          shownVisit={shown?.visit}
          workflow={workflow}
          columns={columns}
          drilled={drill !== undefined}
          onTogglePath={path ? () => setPathOf(drill ? null : selNode.id) : undefined}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  )
}

interface GraphProps {
  graph: Graph
  name(node: WfNode): string
  nodes: Readonly<Record<string, NodeView>>
  edges: Readonly<Record<string, number>>
  badges: Readonly<Record<string, Badge>>
  selected?: string
  /** Нет — ноды не выбираются (путь подзадачи). */
  onSelect?(nodeId: string): void
  /**
   * «×N» и на прямых рёбрах, пройденных несколько раз. На пути подзадачи счётчик — сумма по подзадачам, а не повторы:
   * там он только на возвратах.
   */
  forwardCounts?: boolean
  ariaLabel: string
}

/** Отступ сверху под плашки «сейчас» над нодами и галочки пройденных. */
const TOP_PAD = 34
const SIDE_PAD = 12

/** SVG графа только для чтения. Геометрия рёбер — та же, что в редакторе (`edgeCurveOf`), вид — свой (`.wf-progress-*`). */
function ProgressGraph(props: GraphProps): React.JSX.Element {
  const { graph, nodes, edges, badges, selected, onSelect } = props
  const t = useT()
  const wf: Workflow = { version: 2, nodes: graph.nodes, edges: graph.edges }
  const b = graphBounds(wf) ?? { x: 0, y: 0, w: NODE_W, h: NODE_H }
  const vx = b.x - SIDE_PAD
  const vy = b.y - TOP_PAD
  const vw = b.w + SIDE_PAD * 2
  const vh = b.h + TOP_PAD
  const typeOf = (id: string): WfNode['type'] => graph.nodes.find((n) => n.id === id)?.type ?? 'work'

  return (
    <svg
      className="wf-progress-svg"
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      width={vw}
      height={vh}
      style={{ maxWidth: vw, minWidth: Math.round(vw * 0.75) }}
      role="group"
      aria-label={props.ariaLabel}
    >
      {graph.edges.map((edge) => {
        const curve = edgeCurveOf(wf, edge)
        if (!curve) return null
        const from = graph.nodes.find((n) => n.id === edge.from)
        const count = edges[edge.id] ?? 0
        const end = curve[3]
        const back = curve[3].x - curve[0].x < 40
        const mid = curvePoint(curve, 0.5)
        const label = from && edge.outcome !== 'next' ? wfPortLabel(from, edge.outcome) : ''
        const showCount = count > 0 && (back || (count > 1 && props.forwardCounts !== false))
        const cls = `wf-progress-edge wf-progress-edge--${wfPortClass(typeOf(edge.from), edge.outcome)}${count > 0 ? ' is-walked' : ''}`
        return (
          <g key={edge.id} className={cls}>
            {count > 0 && <title>{t('global.graph.edgeCount', { n: count })}</title>}
            <path d={curvePath(curve)} className="wf-progress-edge-line" />
            <polygon points={`${end.x - 9},${end.y - 5} ${end.x},${end.y} ${end.x - 9},${end.y + 5}`} className="wf-progress-edge-arrow" />
            {(label || showCount) && (
              <text x={mid.x} y={back ? mid.y + 14 : mid.y - 6} textAnchor="middle" className="wf-progress-edge-label">
                {clip(label, 16)}
                {showCount && <tspan className="wf-progress-edge-count" dx={label ? 6 : 0}>×{count}</tspan>}
              </text>
            )}
          </g>
        )
      })}

      {graph.nodes.map((node) => {
        const view = nodes[node.id] ?? { state: 'todo', visits: 0 }
        const h = nodeHeight(node)
        const title = props.name(node)
        const typeTitle = WF_TYPE_TITLES[node.type]
        const badge = badges[node.id]
        const isSelected = selected === node.id
        const NodeIcon = WfNodeIcon[node.type]
        const state = stateText(t, view.state, view.visits)
        const pick = onSelect ? (): void => onSelect(node.id) : undefined
        const cls = `wf-progress-node wf-progress-node--${node.type} is-${view.state}${isSelected ? ' is-selected' : ''}${pick ? ' is-clickable' : ''}`
        return (
          <g
            key={node.id}
            className={cls}
            transform={`translate(${node.x} ${node.y})`}
            {...(pick ? {
              tabIndex: 0,
              role: 'button',
              'aria-pressed': isSelected,
              'aria-label': t('global.graph.nodeAria', { name: title, state }),
              onClick: pick,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                pick()
              }
            } : {})}
          >
            <title>{badge?.title ?? `${title} — ${typeTitle} · ${state}`}</title>
            {isSelected && <rect x={-5} y={-5} width={NODE_W + 10} height={h + 10} rx={14} className="wf-progress-sel" />}
            {(view.state === 'current' || view.state === 'waiting') && <rect x={-1} y={-1} width={NODE_W + 2} height={h + 2} rx={11} className="wf-progress-halo" />}
            <rect width={NODE_W} height={h} rx={10} className="wf-progress-box" />
            <g className="wf-progress-icon" transform={`translate(10 ${(h - 20) / 2})`}><NodeIcon /></g>
            <text x={38} y={h / 2 - (title === typeTitle ? -4 : 3)} className="wf-progress-title">{clip(title, 14)}</text>
            {title !== typeTitle && <text x={38} y={h / 2 + 13} className="wf-progress-sub">{clip(typeTitle, 18)}</text>}
            {badge && (
              <g className={`wf-progress-badge${badge.bad ? ' is-bad' : ''}`} transform={`translate(${NODE_W / 2 - badgeWidth(badge.text) / 2} -26)`}>
                <rect width={badgeWidth(badge.text)} height={18} rx={9} />
                <text x={badgeWidth(badge.text) / 2} y={12.5} textAnchor="middle">{badge.text}</text>
              </g>
            )}
            {!badge && view.state === 'done' && node.type !== 'start' && (
              <g className="wf-progress-check" transform={`translate(${NODE_W - 9} -7)`}>
                <circle cx={8} cy={8} r={8} />
                <path d="M4.5 8.2l2.3 2.3 4.5-4.6" />
              </g>
            )}
            {view.state === 'done' && view.visits > 1 && (
              <g className="wf-progress-badge is-count" transform={`translate(${NODE_W - 42} -7)`}>
                <title>{t('global.graph.badge.visits', { n: view.visits })}</title>
                <rect width={28} height={16} rx={8} />
                <text x={14} y={11.5} textAnchor="middle">×{view.visits}</text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}

interface PanelProps {
  node: WfNode
  graph: Graph
  view: NodeView
  /** Заход, если граф стоит на этой ноде; иначе 0. */
  currentVisit: number
  visits: NodeVisit[]
  /** Сквозная нода (условие): куда граф из неё вышел. */
  exits: PassExit[]
  /** Пути разветвления этой ноды `fork`/`join`, пока граф внутри него: где стоит каждый. */
  lanes: ProgressLane[]
  /** Подзадачи последнего (или текущего) захода. */
  shownTasks: Task[]
  shownVisit?: number
  workflow: Workflow
  columns: BoardColumn[]
  drilled: boolean
  /** Нода «Работа» — вход в путь подзадачи и выход из него; нет — кнопки нет. */
  onTogglePath?(): void
  onOpenTask(taskId: string): void
}

/** Панель выбранной ноды: состояние, заходы с причинами возвратов и сводками, подзадачи захода. */
function NodePanel(props: PanelProps): React.JSX.Element {
  const { node, graph, view, visits, exits, shownTasks, workflow, columns } = props
  const t = useT()
  const nameOf = (id: string | undefined): string => {
    const n = id !== undefined ? graph.nodes.find((x) => x.id === id) : undefined
    return n ? nodeTitle(n) : (id ?? '')
  }
  const hasTasks = node.type === 'work' || node.type === 'ask' || node.type === 'gate'
  const tasksTitle = node.type === 'gate'
    ? t('global.graph.checks')
    : props.shownVisit !== undefined && props.shownVisit > 1 ? t('global.graph.subtasksVisit', { n: props.shownVisit }) : t('global.graph.subtasks')

  return (
    <aside className="gt-box wf-progress-panel" aria-live="polite">
      <div className="wf-progress-panel-head">
        <h3>{nodeTitle(node)}</h3>
        <span className={`chip wf-progress-state is-${view.state}`}>{stateText(t, view.state, props.currentVisit || view.visits)}</span>
      </div>
      <dl className="gt-kv wf-progress-kv">
        <dt>{t('global.graph.type')}</dt>
        <dd>{WF_TYPE_TITLES[node.type]}</dd>
      </dl>

      {props.lanes.length > 0 && (
        <>
          <h4 className="wf-progress-sec">{t('global.graph.lanes')}</h4>
          <ul className="wf-progress-lanes">
            {props.lanes.map((l) => (
              <li key={l.id} className={l.arrived ? 'is-arrived' : 'is-now'}>
                <b>{laneTitle(workflow, l.id)}</b>
                <span className="muted">{l.arrived ? t('global.graph.laneArrived') : t('global.graph.laneAt', { name: nameOf(l.nodeId) })}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {node.type !== 'start' && isPassThrough(node) && (
        <>
          <h4 className="wf-progress-sec">{t('global.graph.pass')}</h4>
          {view.state === 'todo' ? (
            <p className="muted wf-progress-empty">{t('global.graph.noVisits')}</p>
          ) : (
            <>
              <p className="muted wf-progress-empty">{t('global.graph.passedThrough')}</p>
              {exits.length > 0 && (
                <ul className="wf-progress-visits">
                  {exits.map((x) => {
                    const args = { outcome: wfPortLabel(node, x.outcome), name: nameOf(x.to), n: x.count }
                    return <li key={x.edgeId}>{t(x.count > 1 ? 'global.graph.passExitCount' : 'global.graph.passExit', args)}</li>
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}

      {node.type !== 'start' && !isPassThrough(node) && (
        <>
          <h4 className="wf-progress-sec">{t('global.graph.visits')}</h4>
          {visits.length === 0 ? (
            <p className="muted wf-progress-empty">{t('global.graph.noVisits')}</p>
          ) : (
            <ol className="wf-progress-visits">
              {visits.map((v) => (
                <li key={v.index} className={v.current ? 'is-now' : v.leftWith === 'reject' ? 'is-bad' : v.returned ? 'is-returned' : ''}>
                  <div className="wf-progress-visit-head">
                    <b>{node.type === 'end' ? t('global.graph.visitEnd') : t('global.graph.visit', { n: v.visit })}</b>
                    {v.lane !== undefined && <span className="chip wf-progress-lane">{t('global.graph.visitLane', { name: laneTitle(workflow, v.lane) })}</span>}
                    <span className="muted" title={fullStamp(v.at)}>
                      {formatClock(v.at)}
                      {node.type !== 'end' && (v.till !== undefined ? <>–{formatClock(v.till)}</> : !v.closed && <>–{t('global.graph.now')}</>)}
                    </span>
                  </div>
                  <div className="muted wf-progress-visit-sub">
                    {v.returned
                      ? <span className="wf-progress-ret">{v.cameWith === 'restart' ? t('global.graph.restarted') : t('global.graph.returnedBy', { name: nameOf(v.from) })}</span>
                      : v.from !== undefined ? t('global.graph.cameFrom', { name: nameOf(v.from) }) : t('global.graph.cameStart')}
                    {v.to !== undefined && (
                      <> {v.leftWith && v.leftWith !== 'restart' && v.leftWith !== 'next'
                        ? t('global.graph.left', { name: nameOf(v.to), outcome: wfPortLabel(node, v.leftWith) })
                        : t('global.graph.leftPlain', { name: nameOf(v.to) })}</>
                    )}
                    {v.closed && node.type !== 'end' && <> {t('global.graph.runClosed')}</>}
                  </div>
                  {v.reason && <div className="wf-progress-quote">{v.reason}</div>}
                  {v.decision && <div className="wf-progress-visit-sub">{t('global.timeline.stageDecision', { label: v.decision })}</div>}
                  {v.leftReason && <div className="wf-progress-quote">{v.leftReason}</div>}
                  {v.summary && <div className="wf-progress-summary">{v.summary}</div>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {hasTasks && (
        <>
          <h4 className="wf-progress-sec">{tasksTitle}</h4>
          {shownTasks.length === 0 ? (
            <p className="muted wf-progress-empty">{t(view.state === 'todo' ? 'global.graph.subtasksAhead' : 'global.graph.subtasksNone')}</p>
          ) : (
            <ul className="wf-progress-tasks">
              {shownTasks.map((task) => {
                const steps = subtaskPathSteps(task, workflow)
                return (
                  <li key={task.id} className="wf-progress-task">
                    <button type="button" className="wf-progress-task-title" title={`${t('global.graph.openTask')}: ${task.title}`} onClick={() => props.onOpenTask(task.id)}>
                      {task.title}
                    </button>
                    <span className="muted wf-progress-task-role">{task.roleId}</span>
                    {steps && steps.length > 0
                      ? <PathPill steps={steps} />
                      : <span className="chip wf-progress-task-status">{columns.find((c) => c.id === task.status)?.title ?? task.status}</span>}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}

      {props.onTogglePath && (
        <button type="button" className="btn-sm wf-progress-open" aria-pressed={props.drilled} onClick={props.onTogglePath}>
          {t(props.drilled ? 'global.graph.closePath' : 'global.graph.openPath')}
        </button>
      )}
    </aside>
  )
}

/** Пилюля пути подзадачи: «Работа › Мерж › Конец», текущий шаг выделен, беда (конфликт, возврат) — красным. */
function PathPill({ steps }: { steps: PathStep[] }): React.JSX.Element {
  const t = useT()
  const cur = steps.find((s) => s.state === 'current') ?? steps.filter((s) => s.state === 'done').at(-1) ?? steps[0]
  return (
    <span className="wf-progress-pill" role="img" aria-label={t('global.graph.pathSteps', { step: cur?.name ?? '' })}>
      {steps.map((s, i) => (
        <Fragment key={s.nodeId}>
          {i > 0 && <em aria-hidden>›</em>}
          <span className={`is-${s.state}${s.bad ? ' is-bad' : ''}`}>{s.name}</span>
        </Fragment>
      ))}
    </span>
  )
}
