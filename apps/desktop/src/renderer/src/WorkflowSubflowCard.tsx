import type React from 'react'
import { wfNodeTitle, type WfNode, type WfSubflow, type Workflow } from '@orca-board/core'
import { Icon, WfNodeIcon } from './icons'
import { NODE_W, curvePath, edgeCurveOf, graphBounds, nodeHeight } from './workflowGeometry'
import { wfPortClass } from './workflowEdit'
import { graphAt, isDefaultLike, resetSubflow, startCustomSubflow } from './workflowNav'
import { mainPath, type WfCardIssues } from './workflowEditorView'
import { nodeTitle } from './defaultTitles'
import { WfCard } from './WorkflowCard'
import { useT } from './i18n'

/**
 * Карточка «Путь подзадачи» ноды «Работа»: переключатель «По умолчанию / Свой путь», миниатюра пути и «Открыть путь».
 * «Свой путь» заводит копию пути по умолчанию и сразу открывает её; возврат к умолчанию удаляет собственный путь
 * (с подтверждением, если он чем-то отличается от умолчания).
 */
export function SubflowCard({ node, workflow, onChange, onOpenPath, issue }: {
  node: Extract<WfNode, { type: 'work' }>
  workflow: Workflow
  onChange(wf: Workflow): void
  onOpenPath?(nodeId: string): void
  issue?: WfCardIssues
}): React.JSX.Element {
  const t = useT()
  const own: WfSubflow | undefined = node.subflow
  const custom = own !== undefined
  // Свой путь или образец по умолчанию — то, что откроется на холсте.
  const graph = graphAt(workflow, [node.id])?.graph
  const steps = graph ? mainPath(graph).map(nodeTitle).join(' › ') : ''

  const setMode = (mode: 'default' | 'custom'): void => {
    if (mode === 'custom' && !custom) {
      onChange(startCustomSubflow(workflow, node.id))
      onOpenPath?.(node.id)
    } else if (mode === 'default' && custom) {
      if (!isDefaultLike(own) && !confirm(t('config.wf.path.resetConfirm', { title: wfNodeTitle(node) }))) return
      onChange(resetSubflow(workflow, node.id))
    }
  }

  return (
    <WfCard id="path" title={t('config.wf.path.legend')} issue={issue} accent>
      <div className="wf-seg" role="group" aria-label={t('config.wf.path.legend')}>
        <button type="button" aria-pressed={!custom} onClick={() => setMode('default')}>{t('config.wf.path.modeDefault')}</button>
        <button type="button" aria-pressed={custom} onClick={() => setMode('custom')}>{t('config.wf.path.modeCustom')}</button>
      </div>
      {graph && <SubflowMini graph={graph} label={t('config.wf.path.miniAria', { steps })} />}
      {steps && <p className="wf-mini-steps">{steps}</p>}
      <p className="hint">{custom ? t('config.wf.path.customHint', { steps }) : t('config.wf.path.defaultHint')}</p>
      {onOpenPath && (
        <button type="button" className="btn-sm wf-wide" onClick={() => onOpenPath(node.id)}>
          <Icon.subflow /> {custom ? t('config.wf.path.open') : t('config.wf.path.view')}
        </button>
      )}
    </WfCard>
  )
}

/**
 * Миниатюра пути: ноды и переходы в тех же координатах, что на холсте, вписанные в ширину карточки. Подписи на таком
 * масштабе не читаются — шаги основного пути идут текстом под миниатюрой.
 */
function SubflowMini({ graph, label }: { graph: Workflow; label: string }): React.JSX.Element | null {
  const b = graphBounds(graph)
  if (!b) return null
  return (
    <svg className="wf-mini" viewBox={`${b.x - 12} ${b.y - 12} ${b.w + 24} ${b.h}`} role="img" aria-label={label}>
      {graph.edges.map((edge) => {
        const curve = edgeCurveOf(graph, edge)
        const fromType = graph.nodes.find((n) => n.id === edge.from)?.type ?? 'work'
        return curve ? (
          <path key={edge.id} d={curvePath(curve)} className={`wf-mini-edge wf-edge wf-edge--${wfPortClass(fromType, edge.outcome)}`} />
        ) : null
      })}
      {graph.nodes.map((n) => {
        const NodeIcon = WfNodeIcon[n.type]
        const h = nodeHeight(n)
        return (
          <g key={n.id} className={`wf-node wf-node--${n.type}`} transform={`translate(${n.x} ${n.y})`}>
            <rect width={NODE_W} height={h} rx={12} className="wf-node-box" />
            <rect x={0} y={8} width={6} height={h - 16} rx={3} className="wf-node-strip" />
            <g className="wf-node-icon" transform={`translate(${NODE_W / 2 - 20} ${h / 2 - 20}) scale(2)`}><NodeIcon /></g>
          </g>
        )
      })}
    </svg>
  )
}
