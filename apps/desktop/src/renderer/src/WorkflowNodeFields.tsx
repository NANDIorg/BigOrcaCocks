import type React from 'react'
import {
  WF_DECISION_MAX_OPTIONS, WF_DECISION_MIN_OPTIONS, WF_FORK_MAX_BRANCHES, WF_FORK_MIN_BRANCHES,
  type AgentInfo, type BoardColumn, type Role, type WfCondition, type WfNode, type WfPort, type Workflow
} from '@orca-board/core'
import { Icon } from './icons'
import { WF_SUBTASK_FORBIDDEN_TYPES, wfPortClass, wfPortLabel } from './workflowEdit'
import type { WfScope } from './workflowNav'
import {
  GIT_OPERATIONS, gitFieldsFor, gitOperationTitle, isGitOperation, isUnavailableGitOperation, gitPlaceholdersHint, gitPreview, type WfGitNode, type WfGitPatch
} from './workflowGit'
import {
  WF_TYPE_ORDER, WF_TYPE_TITLES, addDecisionOption, addForkBranch, addJoinFor, changeNodeType, conditionOfKind, forkJoins, forkOptions,
  hasColumn, moveDecisionOption, moveForkBranch, nodeOptionLabel, patchDecisionOption, patchNode, portTarget, removeDecisionOption,
  removeForkBranch, renameForkBranch, resetDecisionOptions, setJoinFork, setPortTarget, targetOptions, type WfNodePatch
} from './workflowForm'
import { useT, type TKey } from './i18n'
import { RoleBrief, WorkRolesField } from './WorkflowRoleFields'
import { roleAgentState } from './stageRoles'
import { agentTitle, roleTitle } from './defaultTitles'

// Поля ноды воркфлоу по карточкам инспектора (WorkflowInspector.tsx): «Основное», «Кто выполняет», «Что сделать» —
// отдельный компонент на тип ноды. Правки — только через функции workflowForm.ts / workflowGit.ts.

interface NodeProps<N extends WfNode = WfNode> {
  node: N
  workflow: Workflow
  onChange(wf: Workflow): void
}

type NodeOf<T extends WfNode['type']> = Extract<WfNode, { type: T }>

/** Правка полей ноды одним изменением графа. */
function usePatch(workflow: Workflow, nodeId: string, onChange: (wf: Workflow) => void): (p: WfNodePatch) => void {
  return (p) => onChange(patchNode(workflow, nodeId, p))
}

/** «Основное»: тип, название, колонка на доске; у «Конца» — пришли ли со слитой веткой. */
export function MainFields({ node, workflow, onChange, scope, columns }: NodeProps & {
  scope: WfScope
  columns: readonly BoardColumn[]
}): React.JSX.Element {
  const t = useT()
  const patch = usePatch(workflow, node.id, onChange)
  return (
    <>
      <label className="wf-field">
        <span>{t('config.wf.insp.type')}</span>
        <select value={node.type} onChange={(e) => onChange(changeNodeType(workflow, node.id, e.target.value as WfNode['type']))}>
          {/* В пути подзадачи «Вопрос человеку» недоступен; у уже стоящей там ноды тип остаётся виден (её подсветит валидация). */}
          {WF_TYPE_ORDER.filter((type) => scope === 'run' || !WF_SUBTASK_FORBIDDEN_TYPES.includes(type) || type === node.type).map((type) => (
            <option key={type} value={type}>{WF_TYPE_TITLES[type]}</option>
          ))}
        </select>
      </label>
      <label className="wf-field">
        <span>{t('config.wf.insp.title')}</span>
        <input value={node.title ?? ''} placeholder={WF_TYPE_TITLES[node.type]} onChange={(e) => patch({ title: e.target.value })} />
      </label>
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
      {node.type === 'work' && (scope === 'run' || node.runOnly) && (
        <label className="wf-check" title={t('config.wf.insp.runOnlyHint')}>
          <input type="checkbox" checked={node.runOnly ?? false} onChange={(e) => patch({ runOnly: e.target.checked })} />
          <span>{t('config.wf.insp.runOnly')}</span>
        </label>
      )}
      {node.type === 'end' && (
        <label className="wf-check">
          <input type="checkbox" checked={node.merged ?? false} onChange={(e) => patch({ merged: e.target.checked })} />
          <span>{t('config.wf.insp.merged')}</span>
        </label>
      )}
    </>
  )
}

/** Есть ли у ноды карточка «Кто выполняет». */
export function hasWhoCard(type: WfNode['type']): boolean {
  return type === 'work' || type === 'ask' || type === 'gate' || type === 'decision'
}

/** Есть ли у ноды карточка «Что сделать». */
export function hasWhatCard(type: WfNode['type']): boolean {
  return type !== 'start' && type !== 'end' && type !== 'merge'
}

/** Заголовок карточки «Кто выполняет» по типу ноды. */
export function whoTitle(type: WfNode['type']): TKey {
  return type === 'gate' ? 'config.wf.card.whoGate' : type === 'decision' ? 'config.wf.card.whoDecision' : 'config.wf.card.who'
}

/** Заголовок карточки «Что сделать» по типу ноды. */
export function whatTitle(type: WfNode['type']): TKey {
  switch (type) {
    case 'ask': return 'config.wf.card.whatAsk'
    case 'gate': return 'config.wf.card.whatGate'
    case 'human': return 'config.wf.card.whatHuman'
    case 'decision': return 'config.wf.card.whatDecision'
    case 'condition': return 'config.wf.card.whatCondition'
    case 'git': return 'config.wf.card.whatGit'
    case 'fork': return 'config.wf.card.whatFork'
    case 'join': return 'config.wf.card.whatJoin'
    default: return 'config.wf.card.what'
  }
}

/**
 * «Кто выполняет»: роли этапа у «Работы» (WorkflowRoleFields.tsx), роль агента у вопроса, проверки и решения —
 * select и краткая карточка роли под ним. `invalid` — у карточки ошибка.
 */
export function WhoFields({ node, workflow, onChange, scope, roles, allRoles, agents, invalid }: NodeProps & {
  scope: WfScope
  /** Роли для задач (`stageRoles`): из них выбирают. */
  roles: readonly Role[]
  /** Все роли типа, со служебными: по ним «Работа» отличает служебную роль в выборе от удалённой. */
  allRoles: readonly Role[]
  /** Агенты для состояния ролей; нет (старый main) — состояние неизвестно, без предупреждений. */
  agents?: readonly AgentInfo[]
  invalid: boolean
}): React.JSX.Element | null {
  const t = useT()
  const patch = usePatch(workflow, node.id, onChange)
  const single = (label: TKey, value: string, empty: string, briefEmpty?: string): React.JSX.Element => (
    <>
      <label className="wf-field">
        <span>{t(label)}</span>
        <RoleSelect value={value} roles={roles} agents={agents} empty={empty} invalid={invalid} onChange={(roleId) => patch({ roleId })} />
      </label>
      <RoleBrief roles={allRoles} roleId={value || undefined} agents={agents} empty={briefEmpty} />
    </>
  )
  switch (node.type) {
    case 'work':
      return (
        <WorkRolesField
          key={`${node.id}/${scope}`}
          node={node}
          workflow={workflow}
          scope={scope}
          roles={allRoles}
          agents={agents}
          onChange={(roleIds) => patch({ roleIds })}
        />
      )
    case 'ask':
      return single('config.wf.insp.role', node.roleId ?? '', t('config.wf.insp.askRoleEmpty'))
    case 'gate':
      return single('config.wf.insp.reviewerRole', node.roleId, t('config.wf.insp.pickRole'))
    case 'decision':
      return single('config.wf.insp.decisionRole', node.roleId ?? '', t('config.wf.insp.pickRole'), t('config.wf.roles.brief.empty'))
    default:
      return null
  }
}

/** «Что сделать»: инструкции и настройки этапа — свой компонент на тип ноды. */
export function WhatFields({ node, workflow, onChange, scope, roles }: NodeProps & {
  scope: WfScope
  roles: readonly Role[]
}): React.JSX.Element | null {
  const patch = usePatch(workflow, node.id, onChange)
  switch (node.type) {
    case 'work': return <WorkWhat node={node} patch={patch} />
    case 'ask': return <AskWhat node={node} patch={patch} />
    case 'gate':
    case 'human': return <InstructionsWhat node={node} patch={patch} />
    case 'decision': return <DecisionWhat node={node} workflow={workflow} onChange={onChange} />
    case 'condition': return <ConditionFields node={node} workflow={workflow} roles={roles} scope={scope} onChange={(test) => patch({ test })} />
    case 'git': return <GitFields node={node} onChange={(git) => patch({ git })} />
    case 'fork': return <ForkWhat node={node} workflow={workflow} onChange={onChange} />
    case 'join': return <JoinWhat node={node} workflow={workflow} onChange={onChange} />
    default: return null
  }
}

function WorkWhat({ node, patch }: { node: NodeOf<'work'>; patch(p: WfNodePatch): void }): React.JSX.Element {
  const t = useT()
  return (
    <>
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
  )
}

function AskWhat({ node, patch }: { node: NodeOf<'ask'>; patch(p: WfNodePatch): void }): React.JSX.Element {
  const t = useT()
  return (
    <label className="wf-field">
      <span>{t('config.wf.insp.askInstructions')}</span>
      <textarea
        rows={4}
        value={node.instructions}
        placeholder={t('config.wf.insp.askPlaceholder')}
        onChange={(e) => patch({ instructions: e.target.value })}
      />
    </label>
  )
}

/** Инструкции проверки агентом и решения человека: одно поле, подписи — по типу. */
function InstructionsWhat({ node, patch }: { node: NodeOf<'gate' | 'human'>; patch(p: WfNodePatch): void }): React.JSX.Element {
  const t = useT()
  const gate = node.type === 'gate'
  return (
    <label className="wf-field">
      <span>{gate ? t('config.wf.insp.gateInstructions') : t('config.wf.insp.humanInstructions')}</span>
      <textarea
        rows={4}
        value={node.instructions ?? ''}
        placeholder={gate ? t('config.wf.insp.gatePlaceholder') : t('config.wf.insp.humanPlaceholder')}
        onChange={(e) => patch({ instructions: e.target.value })}
      />
    </label>
  )
}

function DecisionWhat({ node, workflow, onChange }: NodeProps<NodeOf<'decision'>>): React.JSX.Element {
  const t = useT()
  const patch = usePatch(workflow, node.id, onChange)
  return (
    <>
      <label className="wf-field">
        <span>{t('config.wf.insp.decisionQuestion')}</span>
        <textarea
          rows={2}
          value={node.question ?? ''}
          placeholder={t('config.wf.insp.decisionQuestionPlaceholder')}
          onChange={(e) => patch({ question: e.target.value })}
        />
      </label>
      <DecisionOptions node={node} workflow={workflow} onChange={onChange} />
      <label className="wf-field">
        <span>{t('config.wf.insp.decisionInstructions')}</span>
        <textarea
          rows={3}
          value={node.instructions ?? ''}
          placeholder={t('config.wf.insp.decisionInstructionsPlaceholder')}
          onChange={(e) => patch({ instructions: e.target.value })}
        />
      </label>
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
        <select value={node.operation ?? ''} onChange={(e) => onChange({ operation: e.target.value as WfGitNode['operation'] })}>
          {GIT_OPERATIONS.map((op) => <option key={op} value={op}>{gitOperationTitle(op)}</option>)}
          {isUnavailableGitOperation(node.operation) && (
            <option value={node.operation} disabled>{t('config.wf.git.opUnavailable', { op: gitOperationTitle(node.operation) })}</option>
          )}
          {!isGitOperation(node.operation) && <option value={node.operation ?? ''}>{gitOperationTitle(node.operation)}</option>}
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

/** Роль gate/decision/ask: «Название · Агент», у выключенного агента — пометка; неизвестная текущая — с пометкой. */
function RoleSelect({ value, roles, agents, empty, invalid, onChange }: {
  value: string
  roles: readonly Role[]
  agents?: readonly AgentInfo[]
  empty: string
  /** У карточки ошибка: рамка поля цвета ошибки, текст — под полем. */
  invalid: boolean
  onChange(roleId: string): void
}): React.JSX.Element {
  const t = useT()
  const unknown = value && !roles.some((r) => r.id === value)
  const cls = [unknown && 'off', invalid && 'bad'].filter(Boolean).join(' ')
  const label = (r: Role): string => {
    const off = roleAgentState(agents?.find((a) => a.id === r.agent)) === 'off'
    return `${roleTitle(r)} · ${agentTitle(r.agent)}${off ? ` — ${t('config.roles.summaryOff')}` : ''}`
  }
  return (
    <select value={value} className={cls || undefined} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {roles.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
      {unknown && <option value={value}>{t('config.wf.insp.roleMissing', { role: value })}</option>}
    </select>
  )
}

function ConditionFields({ node, workflow, roles, scope, onChange }: {
  node: NodeOf<'condition'>
  workflow: Workflow
  roles: readonly Role[]
  scope: WfScope
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
          {/* Условие по роли в воркфлоу глобальной задачи не работает: новое не предлагаем, старое (из файла) остаётся видно.
              В пути подзадачи у подзадачи роль есть — условие работает. */}
          {scope === 'subtask' && <option value="role">{t('config.wf.insp.condRole')}</option>}
          {scope === 'run' && c.kind === 'role' && <option value="role" disabled>{t('config.wf.insp.condRoleLegacy')}</option>}
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

/**
 * Варианты ноды «Решение ИИ»: метка и пояснение правятся, id показан и не меняется (на нём держатся переходы).
 * Порядок вариантов — порядок портов на холсте. Кнопки — с подписями для скринридера: вся правка идёт с клавиатуры.
 */
function DecisionOptions({ node, workflow, onChange }: NodeProps<NodeOf<'decision'>>): React.JSX.Element {
  const t = useT()
  const options = Array.isArray(node.options) ? node.options : []
  const full = options.length >= WF_DECISION_MAX_OPTIONS
  const isYesNo = options.length === 2 && options[0]?.id === 'yes' && options[1]?.id === 'no'

  const reset = (): void => {
    // Сброс удаляет переходы вариантов, кроме yes/no, — спрашиваем, если терять есть что.
    if (options.some((o) => o.id !== 'yes' && o.id !== 'no') && !confirm(t('config.wf.insp.decisionResetConfirm'))) return
    onChange(resetDecisionOptions(workflow, node.id))
  }

  return (
    <fieldset className="wf-opts">
      <legend>{t('config.wf.insp.decisionOptions', { count: options.length, max: WF_DECISION_MAX_OPTIONS })}</legend>
      <p className="hint">{t('config.wf.insp.decisionOptionsHint')}</p>
      <ol className="wf-opt-list">
        {options.map((o, i) => {
          const name = o.label.trim() || o.id
          return (
            <li key={o.id} className="wf-opt">
              <div className="wf-opt-row">
                <input
                  value={o.label}
                  aria-label={t('config.wf.insp.decisionOptionLabel', { n: i + 1 })}
                  placeholder={t('config.wf.insp.decisionOptionLabelPlaceholder')}
                  onChange={(e) => onChange(patchDecisionOption(workflow, node.id, o.id, { label: e.target.value }))}
                />
                <span className="chip mono" title={t('config.wf.insp.decisionOptionId')}>{o.id}</span>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={i === 0}
                  title={t('config.wf.insp.decisionOptionUp', { label: name })}
                  aria-label={t('config.wf.insp.decisionOptionUp', { label: name })}
                  onClick={() => onChange(moveDecisionOption(workflow, node.id, o.id, -1))}
                >
                  <Icon.up />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={i === options.length - 1}
                  title={t('config.wf.insp.decisionOptionDown', { label: name })}
                  aria-label={t('config.wf.insp.decisionOptionDown', { label: name })}
                  onClick={() => onChange(moveDecisionOption(workflow, node.id, o.id, 1))}
                >
                  <Icon.down />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={options.length <= WF_DECISION_MIN_OPTIONS}
                  title={options.length <= WF_DECISION_MIN_OPTIONS
                    ? t('config.wf.insp.decisionOptionMin', { min: WF_DECISION_MIN_OPTIONS })
                    : t('config.wf.insp.decisionOptionRemove', { label: name })}
                  aria-label={t('config.wf.insp.decisionOptionRemove', { label: name })}
                  onClick={() => onChange(removeDecisionOption(workflow, node.id, o.id))}
                >
                  <Icon.trash />
                </button>
              </div>
              <input
                className="wf-opt-desc"
                value={o.description ?? ''}
                aria-label={t('config.wf.insp.decisionOptionDescription', { n: i + 1 })}
                placeholder={t('config.wf.insp.decisionOptionDescriptionPlaceholder')}
                onChange={(e) => onChange(patchDecisionOption(workflow, node.id, o.id, { description: e.target.value }))}
              />
            </li>
          )
        })}
      </ol>
      <div className="wf-opt-actions">
        <button
          type="button"
          className="btn-sm"
          disabled={full}
          title={full ? t('config.wf.insp.decisionAddMax', { max: WF_DECISION_MAX_OPTIONS }) : undefined}
          onClick={() => onChange(addDecisionOption(workflow, node.id).workflow)}
        >
          <Icon.plus /> {t('config.wf.insp.decisionAdd')}
        </button>
        <button type="button" className="btn-sm" disabled={isYesNo} onClick={reset}>{t('config.wf.insp.decisionReset')}</button>
      </div>
    </fieldset>
  )
}

/**
 * Пути ноды «Разветвление»: название правится, id показан и не меняется (на нём держатся переход и позиция прогона),
 * порядок — порядок портов. Под списком — парное слияние: нет его — кнопка «Добавить слияние».
 */
function ForkWhat({ node, workflow, onChange }: NodeProps<NodeOf<'fork'>>): React.JSX.Element {
  const t = useT()
  const branches = Array.isArray(node.branches) ? node.branches : []
  const full = branches.length >= WF_FORK_MAX_BRANCHES
  const joins = forkJoins(workflow, node.id)
  return (
    <>
      <fieldset className="wf-opts">
        <legend>{t('config.wf.insp.forkBranches', { count: branches.length, max: WF_FORK_MAX_BRANCHES })}</legend>
        <p className="hint">{t('config.wf.insp.forkBranchesHint')}</p>
        <ol className="wf-opt-list">
          {branches.map((b, i) => {
            const name = (b.label ?? '').trim() || b.id
            return (
              <li key={b.id} className="wf-opt">
                <div className="wf-opt-row">
                  <input
                    value={b.label ?? ''}
                    aria-label={t('config.wf.insp.forkBranchLabel', { n: i + 1 })}
                    placeholder={t('config.wf.insp.forkBranchLabelPlaceholder')}
                    onChange={(e) => onChange(renameForkBranch(workflow, node.id, b.id, e.target.value))}
                  />
                  <span className="chip mono" title={t('config.wf.insp.forkBranchId')}>{b.id}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={i === 0}
                    title={t('config.wf.insp.forkBranchUp', { label: name })}
                    aria-label={t('config.wf.insp.forkBranchUp', { label: name })}
                    onClick={() => onChange(moveForkBranch(workflow, node.id, b.id, -1))}
                  >
                    <Icon.up />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={i === branches.length - 1}
                    title={t('config.wf.insp.forkBranchDown', { label: name })}
                    aria-label={t('config.wf.insp.forkBranchDown', { label: name })}
                    onClick={() => onChange(moveForkBranch(workflow, node.id, b.id, 1))}
                  >
                    <Icon.down />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={branches.length <= WF_FORK_MIN_BRANCHES}
                    title={branches.length <= WF_FORK_MIN_BRANCHES
                      ? t('config.wf.insp.forkBranchMin', { min: WF_FORK_MIN_BRANCHES })
                      : t('config.wf.insp.forkBranchRemove', { label: name })}
                    aria-label={t('config.wf.insp.forkBranchRemove', { label: name })}
                    onClick={() => onChange(removeForkBranch(workflow, node.id, b.id))}
                  >
                    <Icon.trash />
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
        <div className="wf-opt-actions">
          <button
            type="button"
            className="btn-sm"
            disabled={full}
            title={full ? t('config.wf.insp.forkAddMax', { max: WF_FORK_MAX_BRANCHES }) : undefined}
            onClick={() => onChange(addForkBranch(workflow, node.id).workflow)}
          >
            <Icon.plus /> {t('config.wf.insp.forkAdd')}
          </button>
        </div>
      </fieldset>
      <div className="wf-field">
        <span>{t('config.wf.insp.forkJoin')}</span>
        {joins.length === 1 && <span className="wf-fork-join">{nodeOptionLabel(joins[0])}</span>}
        {joins.length > 1 && <p className="hint">{t('config.wf.insp.forkJoinMany', { joins: joins.map(nodeOptionLabel).join(', ') })}</p>}
        {joins.length === 0 && (
          <>
            <p className="hint">{t('config.wf.insp.forkJoinNone')}</p>
            <div className="wf-opt-actions">
              <button type="button" className="btn-sm" onClick={() => onChange(addJoinFor(workflow, node.id).workflow)}>
                <Icon.plus /> {t('config.wf.insp.forkAddJoin')}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

/** Парное разветвление ноды «Слияние»: select по разветвлениям графа; уже занятые другим слиянием — с пометкой. */
function JoinWhat({ node, workflow, onChange }: NodeProps<NodeOf<'join'>>): React.JSX.Element {
  const t = useT()
  const forkId = typeof node.forkId === 'string' ? node.forkId : ''
  const forks = forkOptions(workflow)
  const missing = forkId !== '' && !forks.some((f) => f.id === forkId)
  const paired = (id: string): boolean => forkJoins(workflow, id).some((j) => j.id !== node.id)
  return (
    <label className="wf-field">
      <span>{t('config.wf.insp.joinFork')}</span>
      <select value={forkId} onChange={(e) => onChange(setJoinFork(workflow, node.id, e.target.value))}>
        <option value="">{t('config.wf.insp.joinForkPick')}</option>
        {forks.map((f) => (
          <option key={f.id} value={f.id}>{paired(f.id) ? t('config.wf.insp.joinForkPaired', { label: f.label }) : f.label}</option>
        ))}
        {missing && <option value={forkId}>{t('config.wf.insp.joinForkMissing', { fork: forkId })}</option>}
      </select>
      <small className="hint">{forks.length === 0 ? t('config.wf.insp.joinNoForks') : t('config.wf.insp.joinForkHint')}</small>
    </label>
  )
}

/** Select «куда ведёт» одного порта; пустое значение — перехода нет (это ошибка валидации). */
export function PortSelect({ workflow, node, outcome, onChange }: NodeProps & { outcome: WfPort }): React.JSX.Element {
  const t = useT()
  const to = portTarget(workflow, node.id, outcome) ?? ''
  return (
    <label className={`wf-field wf-port-field wf-port--${wfPortClass(node.type, outcome)}`}>
      <span>{wfPortLabel(node, outcome)}</span>
      <select value={to} onChange={(e) => onChange(setPortTarget(workflow, node.id, outcome, e.target.value || null))}>
        <option value="">{t('config.wf.insp.noTarget')}</option>
        {targetOptions(workflow).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  )
}
