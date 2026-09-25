import { useEffect, useId, useRef, useState } from 'react'
import type React from 'react'
import { WF_PORTS, wfWorkRoleIds, type WfNode, type WfNodeType, type WfOutcome, type WfValidation, type Workflow } from '@orca-board/core'
import { Icon, WfNodeIcon } from './icons'
import {
  NODE_H, NODE_W, autoLayout, curvePath, edgeCurve, edgeCurveOf, fitView, hitEdge, hitNode, hitPort, inputPoint, panBy,
  portPoint, screenToWorld, snap, viewBox, zoomAt, type Point, type View
} from './workflowGeometry'
import {
  WF_ADDABLE_TYPES, addNode, canConnect, connect, issueTargets, moveNode, removeSelected, wfOutcomeLabel,
  type WfSelection
} from './workflowEdit'
import { WF_TYPE_TITLES } from './workflowForm'
import { WF_NODE_HELP } from './workflowHelp'
import { gitNodeSubtitle } from './workflowGit'
import { useT, type TFunction } from './i18n'
import { nodeTitle } from './defaultTitles'

interface Props {
  workflow: Workflow
  onChange: (wf: Workflow) => void
  selection: WfSelection
  onSelect: (sel: WfSelection) => void
  /** Результат validateWorkflow: ноды и рёбра с проблемами подсвечиваются, тексты — во всплывающей подсказке. */
  issues?: WfValidation
}

/** Текущий жест мышью. Перетаскивание ноды живёт локально и уходит в onChange одним изменением на отпускании. */
type Gesture =
  | { kind: 'pan'; start: Point; view: View }
  | { kind: 'drag'; nodeId: string; offset: Point; pos: Point; moved: boolean }
  | { kind: 'connect'; from: string; outcome: WfOutcome; pointer: Point; target?: string }

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Вторая строка ноды: что на этапе происходит. */
function nodeSubtitle(node: WfNode, t: TFunction): string {
  switch (node.type) {
    case 'work': {
      const roleIds = wfWorkRoleIds(node)
      return roleIds.length > 0 ? t('config.wf.sub.roles', { roles: roleIds.join(', ') }) : t('config.wf.sub.anyRole')
    }
    case 'ask': return node.roleId ? t('config.wf.sub.role', { role: node.roleId }) : t('config.wf.sub.taskRole')
    case 'gate': return node.roleId ? t('config.wf.sub.role', { role: node.roleId }) : t('config.wf.sub.noRole')
    case 'human': return t('config.wf.sub.inbox')
    case 'condition':
      if (node.test.kind === 'attempts') return t('config.wf.sub.attempts', { node: node.test.node || '?', n: node.test.atLeast })
      if (node.test.kind === 'role') return t('config.wf.sub.roles', { roles: node.test.roleIds.join(', ') || '?' })
      return t('config.wf.sub.files')
    case 'merge': return t('config.wf.sub.merge')
    case 'git': return gitNodeSubtitle(node)
    case 'end': return node.merged ? t('config.wf.sub.merged') : t('config.wf.sub.notMerged')
    default: return ''
  }
}

/**
 * Нодовый редактор воркфлоу на SVG. Колесо — масштаб под курсором, перетаскивание фона — панорама,
 * перетаскивание ноды — перенос (с привязкой к сетке), от порта-кружка тянется переход к другой ноде,
 * Delete/Backspace удаляет выделенное. Попадание в ноду/порт/ребро считается по геометрии
 * (workflowGeometry.ts), а не по DOM-событиям элементов: при захвате указателя (setPointerCapture)
 * элемент под курсором события не получает.
 */
export function WorkflowCanvas({ workflow, onChange, selection, onSelect, issues }: Props): React.JSX.Element {
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

  const add = (type: WfNodeType): void => {
    const c = screenToWorld(view, { x: size.w / 2, y: size.h / 2 })
    // Каждая следующая нода чуть ниже предыдущей, чтобы новые не ложились стопкой одна на другую.
    let x = snap(c.x - NODE_W / 2)
    let y = snap(c.y - NODE_H / 2)
    while (workflow.nodes.some((n) => n.x === x && n.y === y)) { x += 20; y += 20 }
    const res = addNode(workflow, type, x, y)
    onChange(res.workflow)
    onSelect({ kind: 'node', id: res.nodeId })
  }

  const zoomCenter = (factor: number): void => setView((v) => zoomAt(v, { x: size.w / 2, y: size.h / 2 }, factor))

  const shown = gesture?.kind === 'drag' ? moveNode(workflow, gesture.nodeId, gesture.pos.x, gesture.pos.y) : workflow
  const targets = issueTargets(issues)
  const connectSrc = gesture?.kind === 'connect' ? shown.nodes.find((n) => n.id === gesture.from) : undefined

  return (
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
          const cls = `wf-edge wf-edge--${edge.outcome}${selected ? ' selected' : ''}${issue ? ` wf-issue--${issue.level}` : ''}`
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
            isTarget && (targetOk ? 'drop-ok' : 'drop-bad')
          ].filter(Boolean).join(' ')
          const NodeIcon = WfNodeIcon[node.type]
          const sub = nodeSubtitle(node, t)
          return (
            <g key={node.id} className={cls} transform={`translate(${node.x} ${node.y})`}>
              <title>{[`${nodeTitle(node)} — ${WF_TYPE_TITLES[node.type]}`, ...(issue?.messages ?? [])].join('\n')}</title>
              <rect width={NODE_W} height={NODE_H} rx={10} className="wf-node-box" />
              <g className="wf-node-icon" transform={`translate(10 ${(NODE_H - 20) / 2})`}><NodeIcon /></g>
              <text x={38} y={sub ? 26 : 35} className="wf-node-title">{clip(nodeTitle(node), 13)}</text>
              {sub && <text x={38} y={43} className="wf-node-sub">{clip(sub, 19)}</text>}
              {node.type !== 'start' && <circle cx={0} cy={NODE_H / 2} r={4} className="wf-port-in" />}
              {WF_PORTS[node.type].map((outcome) => {
                const p = portPoint(node, outcome)
                const x = p.x - node.x
                const y = p.y - node.y
                return (
                  <g key={outcome} className={`wf-port wf-port--${outcome}`}>
                    <circle cx={x} cy={y} r={6} />
                    <text x={x + 9} y={y - 5} className="wf-port-label">{wfOutcomeLabel(node.type, outcome)}</text>
                  </g>
                )
              })}
            </g>
          )
        })}

        {gesture?.kind === 'connect' && connectSrc && (
          <path
            className={`wf-edge-draft wf-edge--${gesture.outcome}`}
            d={curvePath(edgeCurve(
              portPoint(connectSrc, gesture.outcome),
              gesture.target ? inputPoint(shown.nodes.find((n) => n.id === gesture.target)!) : gesture.pointer
            ))}
          />
        )}
      </svg>

      <div className="wf-toolbar">
        {WF_ADDABLE_TYPES.map((type) => {
          const NodeIcon = WfNodeIcon[type]
          return (
            <button
              key={type}
              type="button"
              className="icon-btn"
              title={`${t('config.wf.canvas.add', { type: WF_TYPE_TITLES[type] })}. ${WF_NODE_HELP[type].summary}`}
              aria-label={t('config.wf.canvas.add', { type: WF_TYPE_TITLES[type] })}
              aria-description={WF_NODE_HELP[type].summary}
              onClick={() => add(type)}
            >
              <NodeIcon />
            </button>
          )
        })}
        <span className="wf-toolbar-sep" />
        <button type="button" className="icon-btn" title={t('config.wf.canvas.zoomOut')} onClick={() => zoomCenter(1 / 1.2)}>−</button>
        <button type="button" className="icon-btn" title={t('config.wf.canvas.zoomIn')} onClick={() => zoomCenter(1.2)}><Icon.plus /></button>
        <button type="button" className="icon-btn" title={t('config.wf.canvas.fit')} onClick={() => setView(fitView(workflow, size.w, size.h))}>⤢</button>
        <button
          type="button"
          className="icon-btn"
          title={t('config.wf.canvas.layout')}
          onClick={() => {
            const laid = autoLayout(workflow)
            onChange(laid)
            setView(fitView(laid, size.w, size.h))
          }}
        >
          <Icon.columns />
        </button>
      </div>
    </div>
  )
}
