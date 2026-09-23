import type React from 'react'
import {
  WF_PORTS, wfNodeTitle,
  type BoardColumn, type Role, type WfCondition, type WfNode, type WfOutcome, type WfValidation, type Workflow
} from '@orca-board/core'
import { Icon, WfNodeIcon } from './icons'
import { WF_OUTCOME_LABELS, issueTargets, removeSelected, type WfSelection } from './workflowEdit'
import {
  WF_TYPE_ORDER, WF_TYPE_TITLES, changeNodeType, conditionOfKind, hasColumn, nodeOptionLabel, patchNode, portTarget,
  setPortTarget, stageRoles, targetOptions, type WfNodePatch
} from './workflowForm'

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
      <aside className="wf-insp" aria-label={`Нода «${wfNodeTitle(node)}»`}>
        <NodeHead node={node} />
        <NodeForm node={node} workflow={workflow} roles={roles} columns={columns} onChange={onChange} />
        {WF_PORTS[node.type].length > 0 && (
          <fieldset className="wf-ports">
            <legend>Куда ведёт</legend>
            {WF_PORTS[node.type].map((outcome) => (
              <PortSelect key={outcome} workflow={workflow} nodeId={node.id} outcome={outcome} onChange={onChange} />
            ))}
          </fieldset>
        )}
        {issue && <IssueList level={issue.level} messages={issue.messages} />}
        <div className="wf-insp-foot">
          <button type="button" className="btn-sm danger" onClick={remove}><Icon.trash /> Удалить ноду</button>
        </div>
      </aside>
    )
  }

  if (edge) {
    const from = workflow.nodes.find((n) => n.id === edge.from)
    const issue = targets.edges.get(edge.id)
    return (
      <aside className="wf-insp" aria-label="Переход">
        <div className="wf-insp-head">
          <b>Переход «{WF_OUTCOME_LABELS[edge.outcome]}»</b>
          <span className="chip mono">{edge.id}</span>
        </div>
        <div className="wf-field">
          <span>Откуда</span>
          <button type="button" className="wf-node-link" onClick={() => onSelect({ kind: 'node', id: edge.from })}>
            {from ? nodeOptionLabel(from) : edge.from}
          </button>
        </div>
        <PortSelect workflow={workflow} nodeId={edge.from} outcome={edge.outcome} onChange={onChange} />
        {issue && <IssueList level={issue.level} messages={issue.messages} />}
        <div className="wf-insp-foot">
          <button type="button" className="btn-sm danger" onClick={remove}><Icon.trash /> Удалить переход</button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="wf-insp" aria-label="Ноды воркфлоу">
      <div className="wf-insp-head"><b>Ноды</b></div>
      <p className="hint wf-insp-hint">
        Выберите ноду на холсте или в списке. Переходы можно тянуть мышью от кружков-портов или выбирать
        в поле «Куда ведёт».
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
                {issue && <span className="wf-dot" aria-label={issue.level === 'error' ? 'ошибка' : 'предупреждение'} />}
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function NodeHead({ node }: { node: WfNode }): React.JSX.Element {
  const NodeIcon = WfNodeIcon[node.type]
  return (
    <div className="wf-insp-head">
      <span className={`wf-insp-icon wf-node--${node.type}`}><NodeIcon /></span>
      <b>{wfNodeTitle(node)}</b>
      <span className="chip mono" title="id ноды">{node.id}</span>
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
  const patch = (p: WfNodePatch): void => onChange(patchNode(workflow, node.id, p))
  const taskRoles = stageRoles(roles)

  return (
    <>
      <label className="wf-field">
        <span>Тип</span>
        <select value={node.type} onChange={(e) => onChange(changeNodeType(workflow, node.id, e.target.value as WfNode['type']))}>
          {WF_TYPE_ORDER.map((t) => <option key={t} value={t}>{WF_TYPE_TITLES[t]}</option>)}
        </select>
      </label>
      <label className="wf-field">
        <span>Название</span>
        <input value={node.title ?? ''} placeholder={WF_TYPE_TITLES[node.type]} onChange={(e) => patch({ title: e.target.value })} />
      </label>

      {node.type === 'work' && (
        <label className="wf-field">
          <span>Роль</span>
          <RoleSelect value={node.roleId ?? ''} roles={taskRoles} empty="Роль задачи (выбрал координатор)" onChange={(roleId) => patch({ roleId })} />
        </label>
      )}
      {node.type === 'gate' && (
        <label className="wf-field">
          <span>Роль проверяющего</span>
          <RoleSelect value={node.roleId} roles={taskRoles} empty="— выберите роль —" onChange={(roleId) => patch({ roleId })} />
        </label>
      )}
      {(node.type === 'gate' || node.type === 'human') && (
        <label className="wf-field">
          <span>{node.type === 'gate' ? 'Как проверять' : 'Что решить человеку'}</span>
          <textarea
            rows={4}
            value={node.instructions ?? ''}
            placeholder={node.type === 'gate' ? 'Критерии и команды проверки для этого проекта' : 'Что посмотреть перед решением'}
            onChange={(e) => patch({ instructions: e.target.value })}
          />
        </label>
      )}
      {node.type === 'condition' && <ConditionFields node={node} workflow={workflow} roles={taskRoles} onChange={(test) => patch({ test })} />}
      {node.type === 'end' && (
        <label className="wf-check">
          <input type="checkbox" checked={node.merged ?? false} onChange={(e) => patch({ merged: e.target.checked })} />
          <span>Сюда приходят со слитой веткой</span>
        </label>
      )}
      {hasColumn(node.type) && (
        <label className="wf-field">
          <span>Колонка на доске</span>
          <select value={node.column ?? ''} onChange={(e) => patch({ column: e.target.value })}>
            <option value="">По умолчанию для этапа</option>
            {columns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            {node.column && !columns.some((c) => c.id === node.column) && (
              <option value={node.column}>{node.column} (нет на доске)</option>
            )}
          </select>
        </label>
      )}
    </>
  )
}

function RoleSelect({ value, roles, empty, onChange }: {
  value: string
  roles: readonly Role[]
  empty: string
  onChange(roleId: string): void
}): React.JSX.Element {
  const unknown = value && !roles.some((r) => r.id === value)
  return (
    <select value={value} className={unknown ? 'off' : undefined} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {roles.map((r) => <option key={r.id} value={r.id}>{r.title} ({r.id})</option>)}
      {unknown && <option value={value}>{value} (нет в проекте)</option>}
    </select>
  )
}

function ConditionFields({ node, workflow, roles, onChange }: {
  node: Extract<WfNode, { type: 'condition' }>
  workflow: Workflow
  roles: readonly Role[]
  onChange(test: WfCondition): void
}): React.JSX.Element {
  const t = node.test
  return (
    <>
      <label className="wf-field">
        <span>Условие</span>
        <select value={t.kind} onChange={(e) => onChange(conditionOfKind(workflow, e.target.value as 'attempts' | 'role'))}>
          <option value="attempts">Число заходов в ноду</option>
          <option value="role">Роль рабочей задачи</option>
          {t.kind === 'files' && <option value="files" disabled>Файлы ветки (пока не поддерживается)</option>}
        </select>
      </label>
      {t.kind === 'attempts' && (
        <div className="wf-row">
          <label className="wf-field">
            <span>Заходов в</span>
            <select value={t.node} onChange={(e) => onChange({ ...t, node: e.target.value })}>
              <option value="">— нода —</option>
              {workflow.nodes.filter((n) => n.type !== 'start' && n.type !== 'condition').map((n) => (
                <option key={n.id} value={n.id}>{nodeOptionLabel(n)}</option>
              ))}
            </select>
          </label>
          <label className="wf-field wf-num">
            <span>не меньше</span>
            <input
              type="number"
              min={1}
              value={Number.isFinite(t.atLeast) ? t.atLeast : ''}
              onChange={(e) => onChange({ ...t, atLeast: e.target.value === '' ? 0 : Math.trunc(Number(e.target.value)) })}
            />
          </label>
        </div>
      )}
      {t.kind === 'role' && (
        <fieldset className="wf-roles">
          <legend>Да — если роль задачи одна из:</legend>
          {roles.map((r) => (
            <label key={r.id} className="wf-check">
              <input
                type="checkbox"
                checked={t.roleIds.includes(r.id)}
                onChange={(e) => onChange({ ...t, roleIds: e.target.checked ? [...t.roleIds, r.id] : t.roleIds.filter((x) => x !== r.id) })}
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
function PortSelect({ workflow, nodeId, outcome, onChange }: {
  workflow: Workflow
  nodeId: string
  outcome: WfOutcome
  onChange(wf: Workflow): void
}): React.JSX.Element {
  const to = portTarget(workflow, nodeId, outcome) ?? ''
  return (
    <label className={`wf-field wf-port-field wf-port--${outcome}`}>
      <span>{WF_OUTCOME_LABELS[outcome]}</span>
      <select value={to} onChange={(e) => onChange(setPortTarget(workflow, nodeId, outcome, e.target.value || null))}>
        <option value="">— нет перехода —</option>
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
