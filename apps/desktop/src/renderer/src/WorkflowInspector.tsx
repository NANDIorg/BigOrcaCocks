import type React from 'react'
import {
  WF_PORTS, wfNodeTitle,
  type BoardColumn, type Role, type WfCondition, type WfNode, type WfOutcome, type WfValidation, type Workflow
} from '@orca-board/core'
import { Icon, WfNodeIcon } from './icons'
import { issueTargets, removeSelected, wfOutcomeLabel, type WfSelection } from './workflowEdit'
import { WF_NODE_HELP } from './workflowHelp'
import {
  GIT_OPERATIONS, gitFieldsFor, gitOperationTitle, gitPlaceholdersHint, gitPreview, type WfGitNode, type WfGitPatch
} from './workflowGit'
import {
  WF_TYPE_ORDER, WF_TYPE_TITLES, changeNodeType, conditionOfKind, hasColumn, nodeOptionLabel, patchNode, portTarget,
  setPortTarget, stageRoles, targetOptions, type WfNodePatch
} from './workflowForm'
import { useT, type TKey } from './i18n'

interface Props {
  workflow: Workflow
  selection: WfSelection
  onChange(wf: Workflow): void
  onSelect(sel: WfSelection): void
  /** Все роли проекта: в выбор попадают роли для задач, неизвестная текущая — с пометкой. */
  roles: readonly Role[]
  columns: readonly BoardColumn[]
  issues?: WfValidation
}

/**
 * Инспектор воркфлоу — форма выбранной ноды или перехода. Каждый порт ноды — select «куда ведёт», поэтому
 * весь граф можно собрать с клавиатуры, не трогая холст; без выделения — список нод для выбора.
 */
export function WorkflowInspector({ workflow, selection, onChange, onSelect, roles, columns, issues }: Props): React.JSX.Element {
  const t = useT()
  const targets = issueTargets(issues)
  const node = selection?.kind === 'node' ? workflow.nodes.find((n) => n.id === selection.id) : undefined
  const edge = selection?.kind === 'edge' ? workflow.edges.find((e) => e.id === selection.id) : undefined

  const remove = (): void => {
    onChange(removeSelected(workflow, selection))
    onSelect(null)
  }

  if (node) {
    const issue = targets.nodes.get(node.id)
    return (
      <aside className="wf-insp" aria-label={t('config.wf.insp.nodeAria', { title: wfNodeTitle(node) })}>
        <NodeHead node={node} />
        <NodeHelp type={node.type} />
        <NodeForm node={node} workflow={workflow} roles={roles} columns={columns} onChange={onChange} />
        {WF_PORTS[node.type].length > 0 && (
          <fieldset className="wf-ports">
            <legend>{t('config.wf.insp.ports')}</legend>
            {WF_PORTS[node.type].map((outcome) => (
              <PortSelect key={outcome} workflow={workflow} nodeId={node.id} nodeType={node.type} outcome={outcome} onChange={onChange} />
            ))}
          </fieldset>
        )}
        {issue && <IssueList level={issue.level} messages={issue.messages} />}
        <div className="wf-insp-foot">
          <button type="button" className="btn-sm danger" onClick={remove}><Icon.trash /> {t('config.wf.insp.removeNode')}</button>
        </div>
      </aside>
    )
  }

  if (edge) {
    const from = workflow.nodes.find((n) => n.id === edge.from)
    const issue = targets.edges.get(edge.id)
    return (
      <aside className="wf-insp" aria-label={t('config.wf.insp.edge')}>
        <div className="wf-insp-head">
          <b>{t('config.wf.insp.edgeTitle', { outcome: wfOutcomeLabel(from?.type ?? 'work', edge.outcome) })}</b>
          <span className="chip mono">{edge.id}</span>
        </div>
        <div className="wf-field">
          <span>{t('config.wf.insp.from')}</span>
          <button type="button" className="wf-node-link" onClick={() => onSelect({ kind: 'node', id: edge.from })}>
            {from ? nodeOptionLabel(from) : edge.from}
          </button>
        </div>
        <PortSelect workflow={workflow} nodeId={edge.from} nodeType={from?.type ?? 'work'} outcome={edge.outcome} onChange={onChange} />
        {issue && <IssueList level={issue.level} messages={issue.messages} />}
        <div className="wf-insp-foot">
          <button type="button" className="btn-sm danger" onClick={remove}><Icon.trash /> {t('config.wf.insp.removeEdge')}</button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="wf-insp" aria-label={t('config.wf.insp.nodesAria')}>
      <div className="wf-insp-head"><b>{t('config.wf.insp.nodes')}</b></div>
      <p className="hint wf-insp-hint">
        {t('config.wf.insp.nodesHint')}
      </p>
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
                <NodeIcon />
                <span>{nodeOptionLabel(n)}</span>
                {issue && <span className="wf-dot" aria-label={issue.level === 'error' ? t('config.wf.insp.error') : t('config.wf.insp.warning')} />}
              </button>
            </li>
          )
        })}
      </ul>
      <details className="wf-help">
        <summary>{t('config.wf.insp.legend')}</summary>
        <dl className="wf-legend">
          {WF_TYPE_ORDER.map((type) => {
            const NodeIcon = WfNodeIcon[type]
            const help = WF_NODE_HELP[type]
            return (
              <div key={type}>
                <dt><span className={`wf-insp-icon wf-node--${type}`}><NodeIcon /></span>{WF_TYPE_TITLES[type]}</dt>
                <dd>{help.summary}<br /><i>{t('config.wf.insp.who', { actor: help.actor })}</i></dd>
              </div>
            )
          })}
        </dl>
      </details>
    </aside>
  )
}

/**
 * Назначение выбранной ноды: одна фраза видна всегда, остальное — в раскрывашке, чтобы не вытеснять форму.
 * `<details>` раскрывается с клавиатуры и не зависит от наведения мыши.
 */
function NodeHelp({ type }: { type: WfNode['type'] }): React.JSX.Element {
  const t = useT()
  const help = WF_NODE_HELP[type]
  const ports = WF_PORTS[type]
  return (
    <div className="wf-help">
      <p className="wf-help-summary">{help.summary}</p>
      <details>
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
                {ports.map((o) => <li key={o}><b className={`wf-help-port wf-port--${o}`}>{wfOutcomeLabel(type, o)}</b> — {help.outcomes[o]}</li>)}
              </ul>
            )}
          </dd>
          <dt>{t('config.wf.insp.settings')}</dt>
          <dd><ul>{help.fields.map((f) => <li key={f}>{f}</li>)}</ul></dd>
        </dl>
      </details>
    </div>
  )
}

function NodeHead({ node }: { node: WfNode }): React.JSX.Element {
  const t = useT()
  const NodeIcon = WfNodeIcon[node.type]
  return (
    <div className="wf-insp-head">
      <span className={`wf-insp-icon wf-node--${node.type}`}><NodeIcon /></span>
      <b>{wfNodeTitle(node)}</b>
      <span className="chip mono" title={t('config.wf.insp.nodeId')}>{node.id}</span>
    </div>
  )
}

/** Поля ноды по её типу. */
function NodeForm({ node, workflow, roles, columns, onChange }: {
  node: WfNode
  workflow: Workflow
  roles: readonly Role[]
  columns: readonly BoardColumn[]
  onChange(wf: Workflow): void
}): React.JSX.Element {
  const t = useT()
  const patch = (p: WfNodePatch): void => onChange(patchNode(workflow, node.id, p))
  const taskRoles = stageRoles(roles)

  return (
    <>
      <label className="wf-field">
        <span>{t('config.wf.insp.type')}</span>
        <select value={node.type} onChange={(e) => onChange(changeNodeType(workflow, node.id, e.target.value as WfNode['type']))}>
          {WF_TYPE_ORDER.map((type) => <option key={type} value={type}>{WF_TYPE_TITLES[type]}</option>)}
        </select>
      </label>
      <label className="wf-field">
        <span>{t('config.wf.insp.title')}</span>
        <input value={node.title ?? ''} placeholder={WF_TYPE_TITLES[node.type]} onChange={(e) => patch({ title: e.target.value })} />
      </label>

      {node.type === 'work' && (
        <>
          <label className="wf-field">
            <span>{t('config.wf.insp.role')}</span>
            <RoleSelect value={node.roleId ?? ''} roles={taskRoles} empty={t('config.wf.insp.roleOfTask')} onChange={(roleId) => patch({ roleId })} />
          </label>
          <label className="wf-field">
            <span>{t('config.wf.insp.instructions')}</span>
            <textarea
              rows={3}
              value={node.instructions ?? ''}
              placeholder={t('config.wf.insp.instructionsPlaceholder')}
              onChange={(e) => patch({ instructions: e.target.value })}
            />
          </label>
          <label className="wf-field">
            <span>{t('config.wf.insp.showcase')}</span>
            <textarea
              rows={3}
              value={node.showcase?.what ?? ''}
              placeholder={t('config.wf.insp.showcasePlaceholder')}
              onChange={(e) => patch({ showcase: { what: e.target.value } })}
            />
          </label>
          <label className="wf-check" title={t('config.wf.insp.showcaseRequiredHint')}>
            <input
              type="checkbox"
              checked={node.showcase?.required ?? false}
              onChange={(e) => patch({ showcase: { required: e.target.checked } })}
            />
            <span>{t('config.wf.insp.showcaseRequired')}</span>
          </label>
        </>
      )}
      {node.type === 'ask' && (
        <>
          <label className="wf-field">
            <span>{t('config.wf.insp.role')}</span>
            <RoleSelect value={node.roleId ?? ''} roles={taskRoles} empty={t('config.wf.insp.askRoleEmpty')} onChange={(roleId) => patch({ roleId })} />
          </label>
          <label className="wf-field">
            <span>{t('config.wf.insp.askInstructions')}</span>
            <textarea
              rows={4}
              value={node.instructions}
              placeholder={t('config.wf.insp.askPlaceholder')}
              onChange={(e) => patch({ instructions: e.target.value })}
            />
          </label>
        </>
      )}
      {node.type === 'gate' && (
        <label className="wf-field">
          <span>{t('config.wf.insp.reviewerRole')}</span>
          <RoleSelect value={node.roleId} roles={taskRoles} empty={t('config.wf.insp.pickRole')} onChange={(roleId) => patch({ roleId })} />
        </label>
      )}
      {(node.type === 'gate' || node.type === 'human') && (
        <label className="wf-field">
          <span>{node.type === 'gate' ? t('config.wf.insp.gateInstructions') : t('config.wf.insp.humanInstructions')}</span>
          <textarea
            rows={4}
            value={node.instructions ?? ''}
            placeholder={node.type === 'gate' ? t('config.wf.insp.gatePlaceholder') : t('config.wf.insp.humanPlaceholder')}
            onChange={(e) => patch({ instructions: e.target.value })}
          />
        </label>
      )}
      {node.type === 'condition' && <ConditionFields node={node} workflow={workflow} roles={taskRoles} onChange={(test) => patch({ test })} />}
      {node.type === 'git' && <GitFields node={node} onChange={(git) => patch({ git })} />}
      {node.type === 'end' && (
        <label className="wf-check">
          <input type="checkbox" checked={node.merged ?? false} onChange={(e) => patch({ merged: e.target.checked })} />
          <span>{t('config.wf.insp.merged')}</span>
        </label>
      )}
      {hasColumn(node.type) && (
        <label className="wf-field">
          <span>{t('config.wf.insp.column')}</span>
          <select value={node.column ?? ''} onChange={(e) => patch({ column: e.target.value })}>
            <option value="">{t('config.wf.insp.columnDefault')}</option>
            {columns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            {node.column && !columns.some((c) => c.id === node.column) && (
              <option value={node.column}>{t('config.wf.insp.columnMissing', { column: node.column })}</option>
            )}
          </select>
        </label>
      )}
    </>
  )
}

/**
 * Поля ноды «Git»: операция и только её параметры (`gitFieldsFor`). Для имени ветки и сообщения под полем —
 * подстановки и превью на образцовой задаче: красный текст — имя недопустимо для git.
 */
function GitFields({ node, onChange }: { node: WfGitNode; onChange(patch: WfGitPatch): void }): React.JSX.Element {
  const t = useT()
  return (
    <>
      <label className="wf-field">
        <span>{t('config.wf.git.operation')}</span>
        <select value={node.operation} onChange={(e) => onChange({ operation: e.target.value as WfGitNode['operation'] })}>
          {GIT_OPERATIONS.map((op) => <option key={op} value={op}>{gitOperationTitle(op)}</option>)}
          {!GIT_OPERATIONS.includes(node.operation) && <option value={node.operation}>{String(node.operation)}</option>}
        </select>
      </label>
      {gitFieldsFor(node.operation).map(({ field, required }) => {
        const value = node[field] ?? ''
        const hint = gitPlaceholdersHint(field)
        const preview = field === 'branch' || field === 'message' ? gitPreview(field, value) : null
        const label = t(`config.wf.git.field.${field}` as TKey)
        return (
          <label key={field} className="wf-field">
            <span>{required ? label : `${label} ${t('config.wf.git.optional')}`}</span>
            <input
              value={value}
              className="mono"
              placeholder={t(`config.wf.git.placeholder.${field}` as TKey)}
              onChange={(e) => onChange({ [field]: e.target.value })}
            />
            {hint && <small className="hint">{hint}</small>}
            {preview && (
              <small className={`wf-git-preview${preview.valid ? '' : ' bad'}`}>
                {t('config.wf.git.preview', { text: preview.text })}
                {!preview.valid && ` — ${t('config.wf.git.previewBad')}`}
              </small>
            )}
          </label>
        )
      })}
    </>
  )
}

function RoleSelect({ value, roles, empty, onChange }: {
  value: string
  roles: readonly Role[]
  empty: string
  onChange(roleId: string): void
}): React.JSX.Element {
  const t = useT()
  const unknown = value && !roles.some((r) => r.id === value)
  return (
    <select value={value} className={unknown ? 'off' : undefined} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {roles.map((r) => <option key={r.id} value={r.id}>{r.title} ({r.id})</option>)}
      {unknown && <option value={value}>{t('config.wf.insp.roleMissing', { role: value })}</option>}
    </select>
  )
}

function ConditionFields({ node, workflow, roles, onChange }: {
  node: Extract<WfNode, { type: 'condition' }>
  workflow: Workflow
  roles: readonly Role[]
  onChange(test: WfCondition): void
}): React.JSX.Element {
  const t = useT()
  const c = node.test
  return (
    <>
      <label className="wf-field">
        <span>{t('config.wf.insp.condition')}</span>
        <select value={c.kind} onChange={(e) => onChange(conditionOfKind(workflow, e.target.value as 'attempts' | 'role'))}>
          <option value="attempts">{t('config.wf.insp.condAttempts')}</option>
          <option value="role">{t('config.wf.insp.condRole')}</option>
          {c.kind === 'files' && <option value="files" disabled>{t('config.wf.insp.condFiles')}</option>}
        </select>
      </label>
      {c.kind === 'attempts' && (
        <div className="wf-row">
          <label className="wf-field">
            <span>{t('config.wf.insp.attemptsIn')}</span>
            <select value={c.node} onChange={(e) => onChange({ ...c, node: e.target.value })}>
              <option value="">{t('config.wf.insp.pickNode')}</option>
              {workflow.nodes.filter((n) => n.type !== 'start' && n.type !== 'condition').map((n) => (
                <option key={n.id} value={n.id}>{nodeOptionLabel(n)}</option>
              ))}
            </select>
          </label>
          <label className="wf-field wf-num">
            <span>{t('config.wf.insp.atLeast')}</span>
            <input
              type="number"
              min={1}
              value={Number.isFinite(c.atLeast) ? c.atLeast : ''}
              onChange={(e) => onChange({ ...c, atLeast: e.target.value === '' ? 0 : Math.trunc(Number(e.target.value)) })}
            />
          </label>
        </div>
      )}
      {c.kind === 'role' && (
        <fieldset className="wf-roles">
          <legend>{t('config.wf.insp.rolesLegend')}</legend>
          {roles.map((r) => (
            <label key={r.id} className="wf-check">
              <input
                type="checkbox"
                checked={c.roleIds.includes(r.id)}
                onChange={(e) => onChange({ ...c, roleIds: e.target.checked ? [...c.roleIds, r.id] : c.roleIds.filter((x) => x !== r.id) })}
              />
              <span>{r.title}</span>
            </label>
          ))}
        </fieldset>
      )}
    </>
  )
}

/** Select «куда ведёт» одного порта; пустое значение — перехода нет (это ошибка валидации). */
function PortSelect({ workflow, nodeId, nodeType, outcome, onChange }: {
  workflow: Workflow
  nodeId: string
  nodeType: WfNode['type']
  outcome: WfOutcome
  onChange(wf: Workflow): void
}): React.JSX.Element {
  const t = useT()
  const to = portTarget(workflow, nodeId, outcome) ?? ''
  return (
    <label className={`wf-field wf-port-field wf-port--${outcome}`}>
      <span>{wfOutcomeLabel(nodeType, outcome)}</span>
      <select value={to} onChange={(e) => onChange(setPortTarget(workflow, nodeId, outcome, e.target.value || null))}>
        <option value="">{t('config.wf.insp.noTarget')}</option>
        {targetOptions(workflow).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  )
}

function IssueList({ level, messages }: { level: 'error' | 'warning'; messages: string[] }): React.JSX.Element {
  return (
    <ul className={`wf-issues wf-issues--${level}`}>
      {messages.map((m, i) => <li key={i}>{m}</li>)}
    </ul>
  )
}
