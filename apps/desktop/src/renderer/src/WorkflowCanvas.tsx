import { useEffect, useId, useRef, useState } from 'react'
import type React from 'react'
import { forkBranches, wfPorts, wfWorkRoleIds, type WfNode, type WfNodeTemplate, type WfNodeType, type WfPort, type WfValidation, type Workflow } from '@orca-board/core'
import { Icon, WfNodeIcon } from './icons'
import {
  NODE_H, NODE_W, autoLayout, curvePath, edgeCurve, edgeCurveOf, fitView, hitEdge, hitNode, hitPort, inputPoint, nodeHeight, panBy,
  portPoint, screenToWorld, snap, viewBox, zoomAt, type Point, type View
} from './workflowGeometry'
import {
  addNode, canConnect, connect, issueTargets, moveNode, removeSelected, wfPortClass, wfPortLabel,
  type WfSelection
} from './workflowEdit'
import { canOpenPath, subflowSummary, type WfScope } from './workflowNav'
import { WF_TYPE_TITLES } from './workflowForm'
import { gitNodeSubtitle } from './workflowGit'
import { laneHighlight, shortIssueText } from './workflowEditorView'
import { useT, type TFunction } from './i18n'
import { nodeTitle } from './defaultTitles'
import { insertTemplate, type NodeTemplatesHook } from './nodeTemplates'
import { WorkflowPalette } from './WorkflowPalette'

interface Props {
  workflow: Workflow
  onChange: (wf: Workflow) => void
  selection: WfSelection
  onSelect: (sel: WfSelection) => void
  /** Результат validateWorkflow: ноды и рёбра с проблемами подсвечиваются, тексты — во всплывающей подсказке. */
  issues?: WfValidation
  /**
   * Что редактируется: граф типа (`'run'`, по умолчанию) или путь подзадачи (`'subtask'`). В пути палитра без нод,
   * которых там нельзя (`ask`), и без входа в ноду.
   */
  scope?: WfScope
  /** Двойной клик по ноде «Работа»: открыть путь её подзадачи. Нет — двойной клик ничего не делает. */
  onOpenNode?: (nodeId: string) => void
  /** Библиотека своих нод: в палитре появляется группа «Свои ноды» со вставкой копии. Нет — группы нет. */
  library?: NodeTemplatesHook
  /** Только просмотр: кнопки палитры недоступны (холст правки и так не пропускает). */
  readOnly?: boolean
  /** Левая часть шапки холста: крошки уровня графа. */
  header?: React.ReactNode
  /** Под холстом, в той же колонке: баннер пути подзадачи и панель «Проблемы». */
  below?: React.ReactNode
  /** «Сохранить выбранную ноду» в палитре; нет — кнопка недоступна. */
  onSaveSelected?(): void
}

/** Текущий жест мышью. Перетаскивание ноды живёт локально и уходит в onChange одним изменением на отпускании. */
type Gesture =
  | { kind: 'pan'; start: Point; view: View }
  | { kind: 'drag'; nodeId: string; offset: Point; pos: Point; moved: boolean }
  | { kind: 'connect'; from: string; outcome: WfPort; pointer: Point; target?: string }

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Вторая строка ноды: что на этапе происходит. `wf` — для названия парного разветвления у слияния. */
function nodeSubtitle(node: WfNode, t: TFunction, wf: Workflow): string {
  switch (node.type) {
    case 'work': {
      // Со своим путём подзадачи вторая строка — что путь делает («ревью + мерж»); роли видны в инспекторе.
      if (node.subflow !== undefined) return subflowSummary(node.subflow)
      const roleIds = wfWorkRoleIds(node)
      return roleIds.length > 0 ? t('config.wf.sub.roles', { roles: roleIds.join(', ') }) : t('config.wf.sub.anyRole')
    }
    case 'ask': return node.roleId ? t('config.wf.sub.role', { role: node.roleId }) : t('config.wf.sub.taskRole')
    case 'gate': return node.roleId ? t('config.wf.sub.role', { role: node.roleId }) : t('config.wf.sub.noRole')
    case 'decision':
      // Роль видна первой: без неё нода не запустится; число вариантов — сколько веток у развилки.
      return t('config.wf.sub.decision', {
        role: node.roleId || t('config.wf.sub.noRole'),
        n: Array.isArray(node.options) ? node.options.length : 0
      })
    case 'human': return t('config.wf.sub.inbox')
    case 'condition':
      if (node.test.kind === 'attempts') return t('config.wf.sub.attempts', { node: node.test.node || '?', n: node.test.atLeast })
      if (node.test.kind === 'role') return t('config.wf.sub.roles', { roles: node.test.roleIds.join(', ') || '?' })
      return t('config.wf.sub.files')
    case 'merge': return t('config.wf.sub.merge')
    case 'git': return gitNodeSubtitle(node)
    case 'fork': return t('config.wf.sub.fork', { n: Array.isArray(node.branches) ? node.branches.length : 0 })
    case 'join': {
      const fork = wf.nodes.find((n) => n.id === node.forkId && n.type === 'fork')
      return fork ? t('config.wf.sub.join', { fork: nodeTitle(fork) }) : t('config.wf.sub.joinNoFork')
    }
    case 'end': return node.merged ? t('config.wf.sub.merged') : t('config.wf.sub.notMerged')
    default: return ''
  }
}

/** Плашка проблемы под нодой: первая проблема коротко, остальные — числом; полный текст — в `<title>` и инспекторе. */
function issuePill(messages: readonly string[], t: TFunction): string {
  const first = clip(shortIssueText(messages[0] ?? ''), 34)
  return messages.length > 1 ? `${first} ${t('config.wf.canvas.moreIssues', { n: messages.length - 1 })}` : first
}

/**
 * Нодовый редактор воркфлоу на SVG. Колесо — масштаб под курсором, перетаскивание фона — панорама,
 * перетаскивание ноды — перенос (с привязкой к сетке), от порта-кружка тянется переход к другой ноде,
 * Delete/Backspace удаляет выделенное. Попадание в ноду/порт/ребро считается по геометрии
 * (workflowGeometry.ts), а не по DOM-событиям элементов: при захвате указателя (setPointerCapture)
 * элемент под курсором события не получает.
 *
 * Рендерит две колонки сетки `.wf-editor`: палитру (WorkflowPalette.tsx) и центральную колонку — шапку с масштабом,
 * холст и то, что передали в `below`. Третья колонка — инспектор — у вызывающего кода.
 */
export function WorkflowCanvas({
  workflow, onChange, selection, onSelect, issues, scope = 'run', onOpenNode, library, readOnly = false, header, below, onSaveSelected
}: Props): React.JSX.Element {
  const t = useT()
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ x: -32, y: -32, scale: 1 })
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const fitted = useRef(false)
  const gridId = `wf-grid-${useId().replace(/:/g, '')}`

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Первый раз, когда холст получил размер, — вписать граф целиком.
  useEffect(() => {
    if (fitted.current || size.w === 0 || size.h === 0) return
    fitted.current = true
    setView(fitView(workflow, size.w, size.h))
  }, [size, workflow])

  // React вешает onWheel пассивным — preventDefault там не работает, а без него прокручивается страница.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      // Щипок на трекпаде приходит как wheel с ctrlKey и маленьким deltaY — ему нужен коэффициент крупнее.
      const k = e.ctrlKey ? 0.01 : 0.0015
      const factor = Math.exp(-e.deltaY * k)
      setView((v) => zoomAt(v, { x: e.clientX - r.left, y: e.clientY - r.top }, factor))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const local = (e: React.PointerEvent): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0 && e.button !== 1) return
    const svg = e.currentTarget
    svg.focus()
    svg.setPointerCapture(e.pointerId)
    const screen = local(e)
    const world = screenToWorld(view, screen)
    if (e.button === 0) {
      const port = hitPort(workflow, world)
      if (port) {
        setGesture({ kind: 'connect', from: port.nodeId, outcome: port.outcome, pointer: world })
        return
      }
      const nodeId = hitNode(workflow, world)
      if (nodeId) {
        const node = workflow.nodes.find((n) => n.id === nodeId)!
        onSelect({ kind: 'node', id: nodeId })
        setGesture({ kind: 'drag', nodeId, offset: { x: world.x - node.x, y: world.y - node.y }, pos: { x: node.x, y: node.y }, moved: false })
        return
      }
      const edgeId = hitEdge(workflow, world, 6 / view.scale)
      if (edgeId) {
        onSelect({ kind: 'edge', id: edgeId })
        return
      }
      onSelect(null)
    }
    setGesture({ kind: 'pan', start: screen, view })
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!gesture) return
    const screen = local(e)
    if (gesture.kind === 'pan') {
      setView(panBy(gesture.view, screen.x - gesture.start.x, screen.y - gesture.start.y))
      return
    }
    const world = screenToWorld(view, screen)
    if (gesture.kind === 'drag') {
      const pos = { x: snap(world.x - gesture.offset.x), y: snap(world.y - gesture.offset.y) }
      if (pos.x !== gesture.pos.x || pos.y !== gesture.pos.y) setGesture({ ...gesture, pos, moved: true })
      return
    }
    setGesture({ ...gesture, pointer: world, target: hitNode(workflow, world) })
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const g = gesture
    setGesture(null)
    if (!g) return
    if (g.kind === 'drag' && g.moved) onChange(moveNode(workflow, g.nodeId, g.pos.x, g.pos.y))
    if (g.kind === 'connect' && g.target && canConnect(workflow, g.from, g.outcome, g.target)) {
      const res = connect(workflow, g.from, g.outcome, g.target)
      if (res.workflow !== workflow) onChange(res.workflow)
      if (res.edgeId) onSelect({ kind: 'edge', id: res.edgeId })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>): void => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
      e.preventDefault()
      onChange(removeSelected(workflow, selection))
      onSelect(null)
    } else if (e.key === 'Escape') {
      if (gesture) setGesture(null)
      else onSelect(null)
    }
  }

  /** Свободное место у центра окна: каждая следующая нода чуть ниже предыдущей, чтобы новые не ложились стопкой. */
  const freeSpot = (): Point => {
    const c = screenToWorld(view, { x: size.w / 2, y: size.h / 2 })
    let x = snap(c.x - NODE_W / 2)
    let y = snap(c.y - NODE_H / 2)
    while (workflow.nodes.some((n) => n.x === x && n.y === y)) { x += 20; y += 20 }
    return { x, y }
  }

  const add = (type: WfNodeType): void => {
    const { x, y } = freeSpot()
    const res = addNode(workflow, type, x, y)
    onChange(res.workflow)
    onSelect({ kind: 'node', id: res.nodeId })
  }

  /** Вставка копии своей ноды (`templateId` — на шаблон). */
  const addTemplate = (template: WfNodeTemplate): void => {
    const { x, y } = freeSpot()
    const res = insertTemplate(workflow, template, x, y)
    onChange(res.workflow)
    onSelect({ kind: 'node', id: res.nodeId })
  }

  // Двойной клик по ноде «Работа» — вход в её путь подзадачи. Попадание считаем по геометрии, как и остальные жесты.
  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!onOpenNode || scope !== 'run') return
    const r = svgRef.current!.getBoundingClientRect()
    const nodeId = hitNode(workflow, screenToWorld(view, { x: e.clientX - r.left, y: e.clientY - r.top }))
    if (nodeId && canOpenPath(workflow, [], nodeId)) onOpenNode(nodeId)
  }

  const zoomCenter = (factor: number): void => setView((v) => zoomAt(v, { x: size.w / 2, y: size.h / 2 }, factor))

  const shown = gesture?.kind === 'drag' ? moveNode(workflow, gesture.nodeId, gesture.pos.x, gesture.pos.y) : workflow
  const targets = issueTargets(issues)
  const connectSrc = gesture?.kind === 'connect' ? shown.nodes.find((n) => n.id === gesture.from) : undefined
  // Выделено разветвление или слияние — ноды путей обведены цветом пути и подписаны в подсказке. Номер пути в
  // `laneHighlight` — порядок портов, тот же, что у `forkBranches`.
  const lanes = laneHighlight(shown, selection?.kind === 'node' ? selection.id : undefined)
  const laneFork = lanes.size > 0 && selection?.kind === 'node' ? shown.nodes.find((n) => n.id === selection.id) : undefined
  const laneForkNode = laneFork?.type === 'join' ? shown.nodes.find((n) => n.id === laneFork.forkId) : laneFork
  const laneNames = laneForkNode?.type === 'fork' ? forkBranches(laneForkNode).map((b) => b.label ?? b.id) : []

  return (
    <>
      <WorkflowPalette
        scope={scope}
        readOnly={readOnly}
        onAdd={add}
        library={library}
        onAddTemplate={addTemplate}
        onSaveSelected={onSaveSelected}
      />
      <section className="wf-mid" aria-label={t('config.wf.canvas.region')}>
        <div className="wf-canvas-head">
          <div className="wf-canvas-where">{header}</div>
          <button type="button" className="icon-btn" title={t('config.wf.canvas.zoomOut')} aria-label={t('config.wf.canvas.zoomOut')} onClick={() => zoomCenter(1 / 1.2)}>−</button>
          <button type="button" className="icon-btn" title={t('config.wf.canvas.zoomIn')} aria-label={t('config.wf.canvas.zoomIn')} onClick={() => zoomCenter(1.2)}><Icon.plus /></button>
          <button type="button" className="btn-sm" title={t('config.wf.canvas.fit')} onClick={() => setView(fitView(workflow, size.w, size.h))}>
            {t('config.wf.canvas.fitShort')}
          </button>
          <button
            type="button"
            className="btn-sm"
            title={t('config.wf.canvas.layout')}
            disabled={readOnly}
            onClick={() => {
              const laid = autoLayout(workflow)
              onChange(laid)
              setView(fitView(laid, size.w, size.h))
            }}
          >
            <Icon.columns /> {t('config.wf.canvas.layoutShort')}
          </button>
        </div>
        <div className="wf-canvas" ref={wrapRef}>
          <svg
            ref={svgRef}
            className={`wf-svg${gesture?.kind === 'pan' ? ' panning' : ''}${gesture?.kind === 'connect' ? ' connecting' : ''}`}
            viewBox={size.w ? viewBox(view, size.w, size.h) : undefined}
            tabIndex={0}
            role="application"
            aria-label={t('config.wf.canvas.aria')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            onDoubleClick={onDoubleClick}
          >
            <defs>
              <pattern id={gridId} width={20} height={20} patternUnits="userSpaceOnUse">
                <circle cx={1} cy={1} r={1} className="wf-grid-dot" />
              </pattern>
            </defs>
            <rect x={view.x} y={view.y} width={size.w / view.scale} height={size.h / view.scale} fill={`url(#${gridId})`} />

            {shown.edges.map((edge) => {
              const curve = edgeCurveOf(shown, edge)
              if (!curve) return null
              const end = curve[3]
              const issue = targets.edges.get(edge.id)
              const selected = selection?.kind === 'edge' && selection.id === edge.id
              const fromType = shown.nodes.find((n) => n.id === edge.from)?.type ?? 'work'
              const cls = `wf-edge wf-edge--${wfPortClass(fromType, edge.outcome)}${selected ? ' selected' : ''}${issue ? ` wf-issue--${issue.level}` : ''}`
              return (
                <g key={edge.id} className={cls}>
                  {issue && <title>{issue.messages.join('\n')}</title>}
                  <path d={curvePath(curve)} className="wf-edge-line" />
                  <polygon points={`${end.x - 9},${end.y - 5} ${end.x},${end.y} ${end.x - 9},${end.y + 5}`} className="wf-edge-arrow" />
                </g>
              )
            })}

            {shown.nodes.map((node) => {
              const issue = targets.nodes.get(node.id)
              const selected = selection?.kind === 'node' && selection.id === node.id
              const isTarget = gesture?.kind === 'connect' && gesture.target === node.id
              const targetOk = isTarget && canConnect(shown, gesture.from, gesture.outcome, node.id)
              const cls = [
                'wf-node', `wf-node--${node.type}`,
                selected && 'selected',
                issue && `wf-issue--${issue.level}`,
                isTarget && (targetOk ? 'drop-ok' : 'drop-bad'),
                lanes.has(node.id) && `wf-node--lane wf-node--lane-${lanes.get(node.id)! % 4}`
              ].filter(Boolean).join(' ')
              const NodeIcon = WfNodeIcon[node.type]
              const sub = nodeSubtitle(node, t, shown)
              const laneIndex = lanes.get(node.id)
              const laneTitle = laneIndex === undefined || !laneForkNode
                ? undefined
                : t('config.wf.canvas.lane', { lane: laneNames[laneIndex] ?? '', fork: nodeTitle(laneForkNode) })
              const ownPath = node.type === 'work' && node.subflow !== undefined
              // Нода decision с множеством вариантов выше обычной: содержимое держим по центру высоты.
              const h = nodeHeight(node)
              const dy = (h - NODE_H) / 2
              return (
                <g key={node.id} className={cls} transform={`translate(${node.x} ${node.y})`}>
                  <title>{[`${nodeTitle(node)} — ${WF_TYPE_TITLES[node.type]}`, ...(laneTitle ? [laneTitle] : []), ...(ownPath ? [t('config.wf.path.nodeHint', { steps: sub })] : []), ...(issue?.messages ?? [])].join('\n')}</title>
                  {laneIndex !== undefined && <rect x={-5} y={-5} width={NODE_W + 10} height={h + 10} rx={14} className="wf-node-lane" />}
                  <rect width={NODE_W} height={h} rx={10} className="wf-node-box" />
                  <rect x={0} y={8} width={4} height={h - 16} rx={2} className="wf-node-strip" />
                  <g className="wf-node-icon" transform={`translate(10 ${(h - 20) / 2})`}><NodeIcon /></g>
                  <text x={38} y={dy + (sub ? 26 : 35)} className="wf-node-title">{clip(nodeTitle(node), 13)}</text>
                  {sub && <text x={38} y={dy + 43} className="wf-node-sub">{clip(sub, ownPath ? 17 : 19)}</text>}
                  {ownPath && (
                    <g className="wf-node-path" transform={`translate(${NODE_W - 22} 5)`}>
                      <rect width={17} height={17} rx={5} />
                      <g transform="translate(3.5 3.5) scale(0.5)"><Icon.subflow /></g>
                    </g>
                  )}
                  {node.type !== 'start' && <circle cx={0} cy={h / 2} r={4} className="wf-port-in" />}
                  {wfPorts(node).map((outcome) => {
                    const p = portPoint(node, outcome)
                    const x = p.x - node.x
                    const y = p.y - node.y
                    return (
                      <g key={outcome} className={`wf-port wf-port--${wfPortClass(node.type, outcome)}`}>
                        <circle cx={x} cy={y} r={6} />
                        {/* Метка варианта — текст человека, может быть длинной; полная — в инспекторе. */}
                        <text x={x + 9} y={y - 5} className="wf-port-label">{clip(wfPortLabel(node, outcome), 16)}</text>
                      </g>
                    )
                  })}
                  {/* Проблема видна без наведения: значок «!» в углу и плашка с текстом под нодой, не только цвет рамки. */}
                  {issue && (
                    <g className={`wf-node-badge wf-node-badge--${issue.level}`} transform="translate(-8 -8)" aria-hidden>
                      <circle cx={8} cy={8} r={8} />
                      <text x={8} y={12} textAnchor="middle">!</text>
                    </g>
                  )}
                  {issue && (() => {
                    const text = issuePill(issue.messages, t)
                    const w = Math.min(NODE_W + 60, text.length * 6 + 18)
                    return (
                      <g className={`wf-node-pill wf-node-pill--${issue.level}`} transform={`translate(${(NODE_W - w) / 2} ${h + 6})`}>
                        <rect width={w} height={18} rx={9} />
                        <text x={w / 2} y={12.5} textAnchor="middle">{text}</text>
                      </g>
                    )
                  })()}
                </g>
              )
            })}

            {gesture?.kind === 'connect' && connectSrc && (
              <path
                className={`wf-edge-draft wf-edge--${wfPortClass(connectSrc.type, gesture.outcome)}`}
                d={curvePath(edgeCurve(
                  portPoint(connectSrc, gesture.outcome),
                  gesture.target ? inputPoint(shown.nodes.find((n) => n.id === gesture.target)!) : gesture.pointer
                ))}
              />
            )}
          </svg>
        </div>
        {below}
      </section>
    </>
  )
}
