import type React from 'react'
import { wfNodeTitle, wfPorts, type AgentInfo, type BoardColumn, type Role, type WfIssue, type WfNode, type WfPort, type WfValidation, type Workflow } from '@orca-board/core'
import { Icon, WfNodeIcon } from './icons'
import { issueTargets, removeSelected, wfPortClass, wfPortLabel, type WfSelection } from './workflowEdit'
import type { WfScope } from './workflowNav'
import { WF_NODE_HELP } from './workflowHelp'
import { WF_TYPE_TITLES, nodeOptionLabel, stageRoles } from './workflowForm'
import { nodeCardIssues, shortIssueText, type WfCardId, type WfCardIssues } from './workflowEditorView'
import { wfIssueText } from './defaultTitles'
import { useT, type TKey } from './i18n'
import { IssueDot, WfCard } from './WorkflowCard'
import { MainFields, PortSelect, WhatFields, WhoFields, hasWhatCard, hasWhoCard, whatTitle, whoTitle } from './WorkflowNodeFields'
import { SubflowCard } from './WorkflowSubflowCard'
import { WorkflowTemplateBlock } from './WorkflowTemplateBlock'
import { canBeTemplate, type NodeTemplatesHook } from './nodeTemplates'

interface Props {
  workflow: Workflow
  selection: WfSelection
  onChange(wf: Workflow): void
  onSelect(sel: WfSelection): void
  /** Все роли проекта: в выбор попадают роли для задач, неизвестная текущая — с пометкой. */
  roles: readonly Role[]
  columns: readonly BoardColumn[]
  issues?: WfValidation
  /** Граф типа (`'run'`, по умолчанию) или путь подзадачи (`'subtask'`): в пути нет `ask` и вложенного пути. */
  scope?: WfScope
  /** Открыть путь подзадачи ноды «Работа» (только из графа типа). Нет — кнопки «Открыть» нет. */
  onOpenPath?(nodeId: string): void
  /** Агенты для состояния ролей в «Кто выполняет»; нет (старый main) — состояние неизвестно, без предупреждений. */
  agents?: readonly AgentInfo[]
  /** Библиотека своих нод: карточка «Своя нода» (сохранить, обновить из шаблона). Нет — карточки нет. */
  library?: NodeTemplatesHook
}

/**
 * Текст проблемы в карточке: без «нода «X»:» — нода и так выбрана. У проблемы пути подзадачи оставляем название ноды
 * пути: в карточке «Путь подзадачи» без него непонятно, о какой ноде речь.
 */
function cardIssueText(issue: WfIssue): string {
  return issue.subflowOf ? wfIssueText({ ...issue, subflowOf: undefined }) : shortIssueText(wfIssueText(issue))
}

/**
 * Инспектор воркфлоу (правая колонка редактора) — карточки выбранной ноды или перехода, все раскрыты. Каждый порт ноды —
 * select «куда ведёт», поэтому весь граф можно собрать с клавиатуры, не трогая холст; без выделения — список нод.
 * Поля карточек — WorkflowNodeFields.tsx, путь подзадачи — WorkflowSubflowCard.tsx.
 */
export function WorkflowInspector({ workflow, selection, onChange, onSelect, roles, columns, issues, scope = 'run', onOpenPath, agents, library }: Props): React.JSX.Element {
  const t = useT()
  const targets = issueTargets(issues)
  const node = selection?.kind === 'node' ? workflow.nodes.find((n) => n.id === selection.id) : undefined
  const edge = selection?.kind === 'edge' ? workflow.edges.find((e) => e.id === selection.id) : undefined

  const remove = (): void => {
    onChange(removeSelected(workflow, selection))
    onSelect(null)
  }

  if (node) {
    const taskRoles = stageRoles(roles)
    const ports = wfPorts(node)
    const cards: WfCardId[] = [
      'main',
      ...(hasWhoCard(node.type) ? ['who' as const] : []),
      ...(hasWhatCard(node.type) ? ['what' as const] : []),
      ...(node.type === 'work' && scope === 'run' ? ['path' as const] : []),
      ...(ports.length > 0 ? ['out' as const] : []),
      ...(library && canBeTemplate(node.type) ? ['tpl' as const] : [])
    ]
    const byCard = nodeCardIssues(issues, node.id, cards, cardIssueText)
    return (
      <aside className="wf-insp" aria-label={t('config.wf.insp.nodeAria', { title: wfNodeTitle(node) })}>
        <WfCard id="head">
          <NodeHead node={node} scope={scope} onRemove={remove} />
        </WfCard>
        <WfCard id="main" title={t('config.wf.card.main')} issue={byCard.get('main')}>
          <MainFields node={node} workflow={workflow} onChange={onChange} scope={scope} columns={columns} />
        </WfCard>
        {cards.includes('who') && (
          <WfCard id="who" title={t(whoTitle(node.type))} issue={byCard.get('who')}>
            <WhoFields node={node} workflow={workflow} onChange={onChange} scope={scope} roles={taskRoles} allRoles={roles} agents={agents} invalid={byCard.get('who')?.level === 'error'} />
          </WfCard>
        )}
        {cards.includes('what') && (
          <WfCard id="what" title={t(whatTitle(node.type))} issue={byCard.get('what')}>
            <WhatFields node={node} workflow={workflow} onChange={onChange} scope={scope} roles={taskRoles} />
          </WfCard>
        )}
        {node.type === 'work' && cards.includes('path') && (
          <SubflowCard node={node} workflow={workflow} onChange={onChange} onOpenPath={onOpenPath} issue={byCard.get('path')} />
        )}
        {cards.includes('out') && (
          <WfCard id="out" title={t('config.wf.insp.ports')} issue={byCard.get('out')}>
            {ports.map((outcome) => (
              <PortSelect key={outcome} workflow={workflow} node={node} outcome={outcome} onChange={onChange} />
            ))}
          </WfCard>
        )}
        {library && cards.includes('tpl') && (
          <WorkflowTemplateBlock key={node.id} node={node} workflow={workflow} onChange={onChange} library={library} scope={scope} issue={byCard.get('tpl')} />
        )}
      </aside>
    )
  }

  if (edge) {
    const from = workflow.nodes.find((n) => n.id === edge.from)
    const issue = targets.edges.get(edge.id)
    // Ребро из удалённой ноды (в графе из файла) подписываем как у «Работы»: исход `next` понятен и без ноды.
    const fromNode: WfNode = from ?? { id: edge.from, type: 'work', x: 0, y: 0 }
    const edgeIssue: WfCardIssues | undefined = issue && { level: issue.level, messages: issue.messages.map(shortIssueText) }
    return (
      <aside className="wf-insp" aria-label={t('config.wf.insp.edge')}>
        <WfCard id="head">
          <div className="wf-insp-head">
            <span className={`wf-insp-icon wf-help-port wf-port--${wfPortClass(fromNode.type, edge.outcome)}`}><Icon.subflow /></span>
            <span className="wf-insp-name">
              <b>{t('config.wf.insp.edgeTitle', { outcome: wfPortLabel(fromNode, edge.outcome) })}</b>
              <small className="chip mono">{edge.id}</small>
            </span>
            <button type="button" className="icon-btn" title={t('config.wf.insp.removeEdge')} aria-label={t('config.wf.insp.removeEdge')} onClick={remove}>
              <Icon.trash />
            </button>
          </div>
        </WfCard>
        <WfCard id="edge" title={t('config.wf.insp.ports')} issue={edgeIssue}>
          <div className="wf-field">
            <span>{t('config.wf.insp.from')}</span>
            <button type="button" className="wf-node-link" onClick={() => onSelect({ kind: 'node', id: edge.from })}>
              {from ? nodeOptionLabel(from) : edge.from}
            </button>
          </div>
          <PortSelect workflow={workflow} node={fromNode} outcome={edge.outcome} onChange={onChange} />
        </WfCard>
      </aside>
    )
  }

  return (
    <aside className="wf-insp" aria-label={t('config.wf.insp.nodesAria')}>
      <WfCard id="nodes" title={t('config.wf.insp.nodes')}>
        <p className="hint wf-insp-hint">{t('config.wf.insp.nodesHint')}</p>
        <ul className="wf-node-list">
          {workflow.nodes.map((n) => {
            const NodeIcon = WfNodeIcon[n.type]
            const issue = targets.nodes.get(n.id)
            return (
              <li key={n.id}>
                <button
                  type="button"
                  className={`wf-node-link${issue ? ` wf-issue--${issue.level}` : ''}`}
                  title={issue?.messages.join('\n')}
                  onClick={() => onSelect({ kind: 'node', id: n.id })}
                >
                  <span className={`wf-insp-icon wf-node--${n.type}`}><NodeIcon /></span>
                  <span className="wf-node-link-text">{nodeOptionLabel(n)}</span>
                  {issue && <IssueDot level={issue.level} />}
                </button>
              </li>
            )
          })}
        </ul>
      </WfCard>
    </aside>
  )
}

/**
 * Шапка выбранной ноды: значок и цвет типа, название, тип и одна фраза о нём, удаление. Подробности — в раскрывашке:
 * `<details>` раскрывается с клавиатуры и не зависит от наведения мыши.
 */
function NodeHead({ node, scope, onRemove }: { node: WfNode; scope: WfScope; onRemove(): void }): React.JSX.Element {
  const t = useT()
  const NodeIcon = WfNodeIcon[node.type]
  const type = node.type
  const help = WF_NODE_HELP[type]
  const ports = wfPorts(node)
  // У фиксированных портов смысл исхода — из справки типа; у вариантов «Решения ИИ» — пояснение самого варианта,
  // у путей разветвления — общая фраза (название пути уже в подписи).
  const outcomeText = (port: WfPort): string => {
    if (node.type === 'fork') return t('config.wf.help.fork.outcome')
    if (node.type !== 'decision') return help.outcomes[port as keyof typeof help.outcomes] ?? ''
    const option = Array.isArray(node.options) ? node.options.find((o) => o.id === port) : undefined
    return option?.description?.trim() || t('config.wf.help.decision.outcome')
  }
  // Справка типа написана для графа глобальной задачи; в пути подзадачи у части нод другой смысл — говорим об этом отдельно.
  const noteKey = `config.wf.path.note.${type}` as TKey
  const note = scope === 'subtask' ? t(noteKey) : ''
  return (
    <>
      <div className="wf-insp-head">
        <span className={`wf-insp-icon wf-insp-icon--box wf-node--${type}`}><NodeIcon /></span>
        <span className="wf-insp-name">
          <b>{wfNodeTitle(node)}</b>
          <small>{WF_TYPE_TITLES[type]}</small>
        </span>
        <span className="chip mono" title={t('config.wf.insp.nodeId')}>{node.id}</span>
        <button type="button" className="icon-btn" title={t('config.wf.insp.removeNode')} aria-label={t('config.wf.insp.removeNode')} onClick={onRemove}>
          <Icon.trash />
        </button>
      </div>
      <p className="wf-help-summary">{help.summary}</p>
      {note && note !== noteKey && <p className="hint wf-path-note">{note}</p>}
      <details className="wf-help">
        <summary>{t('config.wf.insp.howItWorks')}</summary>
        <dl className="wf-help-body">
          <dt>{t('config.wf.insp.actor')}</dt>
          <dd>{help.actor}</dd>
          <dt>{t('config.wf.insp.details')}</dt>
          <dd>{help.details}</dd>
          <dt>{t('config.wf.insp.outcomes')}</dt>
          <dd>
            {ports.length === 0 ? t('config.wf.insp.noOutcomes') : (
              <ul>
                {ports.map((o) => (
                  <li key={o}><b className={`wf-help-port wf-port--${wfPortClass(type, o)}`}>{wfPortLabel(node, o)}</b> — {outcomeText(o)}</li>
                ))}
              </ul>
            )}
          </dd>
          <dt>{t('config.wf.insp.settings')}</dt>
          <dd><ul>{help.fields.map((f) => <li key={f}>{f}</li>)}</ul></dd>
        </dl>
      </details>
    </>
  )
}
