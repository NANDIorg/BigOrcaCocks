import type React from 'react'
import { useState } from 'react'
import {
  builtinPromptKind,
  coordinatorPrompt,
  defaultRoleDescription,
  isTaskRole,
  modelLabel,
  workerTaskPrompt,
  type AgentInfo,
  type AgentKind,
  type Role,
  type Workflow
} from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { isSystemRole, missingSystemRoles, removalConsequences, removeBlocker, restoreSystemRoles } from './roleRemoval'
import { useAutoSave } from './useAutoSave'
import { agentChangePatch, duplicatedRole, modelChangePatch, rolesForSave, withPatch } from './roleEdit'
import { useT, type TFunction, type TKey } from './i18n'
import { withCode } from './about/parts'
import { agentTitle, builtinText, modelTitle, roleTitle } from './defaultTitles'
import {
  ExecutorFields, InstructionTabs, commandPreview, effortsOf, useBuiltinPrompts, type BuiltinState
} from './RoleParts'
import { AGENT_STATE_TEXT, roleAgentState } from './stageRoles'
import type { PermissionMode } from '../shared/ipc'

interface Props {
  /** Ключ черновика (id проекта или 'defaults'): при смене черновик переинициализируется. */
  storageKey: string
  /** Начальные роли (берутся при монтировании и при смене storageKey). */
  roles: Role[]
  /** Все агенты проекта: в выбор попадают включённые, выключенный текущий — с пометкой. */
  agents: AgentInfo[]
  /** Число задач проекта по id роли; нет — счётчики не показываются (дефолты для новых проектов). */
  taskCounts?: Readonly<Record<string, number>>
  /** Свой воркфлоу (проекта или дефолта): роль, занятая в графе, — в последствиях удаления. */
  workflow?: Workflow
  /** Режим типа задачи для точного превью аргументов запуска. */
  permissionMode?: PermissionMode
  /** Только просмотр: роли можно выбирать и читать, правки не сохраняются. */
  readOnly?: boolean
  /** Роли типа задачи: в последствиях удаления — незакрытые глобальные задачи этого типа. */
  ofTaskType?: boolean
  onSave(roles: Role[]): Promise<void>
}

/**
 * Вид служебной инструкции роли типа: координаторская или воркерская. Ассистент ролью типа больше не бывает
 * (`AppSettings.assistant`, раздел «Настройки → Ассистент»); роль с его id из старых данных показываем как воркерскую.
 */
type RoleKind = 'coordinator' | 'worker'

function roleKind(roleId: string): RoleKind {
  return builtinPromptKind(roleId) === 'coordinator' ? 'coordinator' : 'worker'
}

function newRoleId(): string {
  return `role_${Date.now().toString(36)}`
}

/** Вкладка «Роли» типа задачи («Настройки» → «Типы задач»): список ролей слева, панель выбранной роли справа; сохраняется автоматически. */
export function RolesEditor({
  storageKey, roles: initial, agents, taskCounts, workflow, permissionMode, readOnly = false, ofTaskType = false, onSave
}: Props): React.JSX.Element {
  const t = useT()
  // Негодные флаги запуска в main не уходят (`rolesForSave`): он отверг бы тип целиком вместе с правками соседних полей.
  const { draft: roles, error, update: save } = useAutoSave<Role[]>(storageKey, initial, onSave, rolesForSave)
  /** Состав и порядок ролей в просмотре заблокированы. */
  const locked = readOnly
  const update: typeof save = locked ? () => undefined : save
  const enabled = agents.filter((a) => a.enabled)
  const builtin = useBuiltinPrompts()
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => (initial.find((r) => isTaskRole(r.id)) ?? initial[0])?.id
  )
  /** Id перетаскиваемой роли (drag-ручка в списке). */
  const [dragId, setDragId] = useState<string | undefined>()
  const index = Math.max(0, roles.findIndex((r) => r.id === selectedId))
  const selected: Role | undefined = roles[index]

  function patch(i: number, p: Partial<Role>, debounce = false): void {
    if (readOnly) return
    save(roles.map((r, j) => (j === i ? withPatch(r, p) : r)), debounce)
  }

  /** Смена агента: модель, effort и флаги запуска сбрасываются — `agentChangePatch`. */
  function changeAgent(i: number, agent: AgentKind): void {
    patch(i, agentChangePatch(agent))
  }

  /** Смена модели: effort, которого нет у новой модели, сбрасывается. */
  function changeModel(i: number, model: string, debounce = false): void {
    const r = roles[i]
    patch(i, modelChangePatch(r.effort, model, effortsOf(agents.find((a) => a.id === r.agent), r.agent, model || undefined)), debounce)
  }

  function add(): void {
    const agent: AgentKind = enabled[0]?.id ?? agents[0]?.id ?? 'claude'
    const role: Role = { id: newRoleId(), title: t('config.roles.newRole'), agent }
    update([...roles, role])
    setSelectedId(role.id)
  }

  function duplicate(i: number): void {
    const role = duplicatedRole(roles[i], newRoleId(), t('config.roles.copyTitle', { title: roles[i].title }))
    update([...roles.slice(0, i + 1), role, ...roles.slice(i + 1)])
    setSelectedId(role.id)
  }

  function remove(i: number): void {
    const next = roles.filter((_, j) => j !== i)
    update(next)
    setSelectedId(next[Math.min(i, next.length - 1)]?.id)
  }

  /** Вернуть удалённые системные роли с настройками по умолчанию; выбранной становится первая возвращённая. */
  function restore(): void {
    const back = missingSystemRoles(roles)
    if (back.length === 0) return
    update(restoreSystemRoles(roles))
    setSelectedId(back[0].id)
  }

  /** Переставить роль `id` на место роли `targetId` (порядок массива = порядок в «Новой задаче»). */
  function move(id: string, targetId: string): void {
    const from = roles.findIndex((r) => r.id === id)
    const to = roles.findIndex((r) => r.id === targetId)
    if (from < 0 || to < 0 || from === to) return
    const next = [...roles]
    const [role] = next.splice(from, 1)
    next.splice(to, 0, role)
    update(next)
  }

  /** Сдвиг роли с клавиатуры (Alt+↑/↓) — альтернатива перетаскиванию; служебные роли в списке задач не участвуют. */
  function shift(id: string, delta: -1 | 1): void {
    const list = roles.filter((r) => isTaskRole(r.id))
    const target = list[list.findIndex((r) => r.id === id) + delta]
    if (target) move(id, target.id)
  }

  const system = roles.filter((r) => !isTaskRole(r.id))
  const taskRoles = roles.filter((r) => isTaskRole(r.id))
  const missing = missingSystemRoles(roles)

  function item(r: Role): React.JSX.Element {
    const info = agents.find((a) => a.id === r.agent)
    const state = roleAgentState(info)
    const isService = !isTaskRole(r.id)
    const summary = [
      agentTitle(r.agent),
      state === 'on' ? modelTitle(modelLabel(info, r.model)) : state === 'off' ? t('config.roles.summaryOff') : t('config.roles.summaryUnknown'),
      state === 'on' ? r.effort : undefined
    ].filter(Boolean).join(' · ')
    const count = taskCounts?.[r.id]
    return (
      <li
        key={r.id}
        className={`roles-item${r.id === selected?.id ? ' active' : ''}${dragId === r.id ? ' dragging' : ''}`}
        onDragOver={isService || !dragId ? undefined : (e) => e.preventDefault()}
        onDrop={isService || !dragId ? undefined : (e) => {
          e.preventDefault()
          move(dragId, r.id)
          setDragId(undefined)
        }}
      >
        {isService ? (
          <span className={`roles-dot ${state}`} role="img" aria-label={t(AGENT_STATE_TEXT[state])} title={t(AGENT_STATE_TEXT[state])} />
        ) : locked ? null : (
          <span
            className="roles-handle"
            draggable
            title={t('config.roles.dragHint')}
            aria-hidden="true"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', r.id)
              setDragId(r.id)
            }}
            onDragEnd={() => setDragId(undefined)}
          >
            <Icon.grip />
          </span>
        )}
        <button
          type="button"
          className="roles-pick"
          aria-current={r.id === selected?.id ? 'true' : undefined}
          onClick={() => setSelectedId(r.id)}
          onKeyDown={(e) => {
            if (isService || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
            e.preventDefault()
            shift(r.id, e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <span className="roles-title">
            <span className="roles-name">{r.title ? builtinText(r.title) : t('config.roles.untitled')}</span>
            {!isService && state !== 'on' && (
              <span className={`roles-dot ${state}`} role="img" aria-label={t(AGENT_STATE_TEXT[state])} title={t(AGENT_STATE_TEXT[state])} />
            )}
          </span>
          <span className="roles-sub">
            <AgentLogo agent={r.agent} size={14} />
            <span className="roles-name">{summary}</span>
          </span>
        </button>
        {isService ? (
          <span className="chip sys" title={t('config.roles.serviceChipTitle', { service: t(SERVICE_TEXT[roleKind(r.id)]) })}>{t('config.roles.serviceChip')}</span>
        ) : state !== 'on' ? (
          <span className="chip warn" title={t(AGENT_STATE_TEXT[state])}>!</span>
        ) : count !== undefined ? (
          <span className="chip mono" title={t('config.roles.taskCountTitle', { n: count })}>{count}</span>
        ) : null}
      </li>
    )
  }

  return (
    <div className="editor roles-editor">
      <div className="roles-md">
        <aside className="roles-list" aria-label={t('config.roles.listAria')}>
          {system.length > 0 && (
            <>
              <div className="roles-group">{t('config.roles.groupSystem')}</div>
              <ul>{system.map(item)}</ul>
            </>
          )}
          <div className="roles-group">{t('config.roles.groupTask')}</div>
          <ul>{taskRoles.map(item)}</ul>
          {!locked && <button type="button" className="btn-sm roles-add" onClick={add}>{t('config.roles.add')}</button>}
          <div className="roles-hint">
            {t('config.roles.orderHint')}{taskCounts ? ` ${t('config.roles.countHint')}` : ''}
          </div>
          {missing.length > 0 && !locked && (
            <div className="roles-hint">
              {t('config.roles.missing', { ids: missing.map((r) => r.id).join(', ') })}{' '}
              <button type="button" className="roles-link" onClick={restore}>{t('config.roles.restore')}</button>
            </div>
          )}
        </aside>
        {selected ? (
          <RolePanel
            key={selected.id}
            role={selected}
            agents={agents}
            enabled={enabled}
            count={taskCounts?.[selected.id]}
            workflow={workflow}
            permissionMode={permissionMode}
            ofTaskType={ofTaskType}
            deleteBlocker={removeBlocker(roles)}
            builtin={builtin}
            readOnly={readOnly}
            onPatch={(p, debounce) => patch(index, p, debounce)}
            onAgent={(agent) => changeAgent(index, agent)}
            onModel={(model, debounce) => changeModel(index, model, debounce)}
            onDuplicate={() => duplicate(index)}
            onRemove={() => remove(index)}
          />
        ) : (
          <section className="roles-panel roles-empty">{t('config.roles.empty')}</section>
        )}
      </div>
      {error && <div className="editor-error">{error}</div>}
    </div>
  )
}

interface PanelProps {
  role: Role
  agents: AgentInfo[]
  enabled: AgentInfo[]
  count: number | undefined
  workflow: Workflow | undefined
  permissionMode?: PermissionMode
  ofTaskType: boolean
  /** Почему удалить нельзя (последняя роль); undefined — можно. */
  deleteBlocker: string | undefined
  builtin: BuiltinState
  readOnly: boolean
  onPatch(p: Partial<Role>, debounce?: boolean): void
  onAgent(agent: AgentKind): void
  onModel(model: string, debounce?: boolean): void
  onDuplicate(): void
  onRemove(): void
}

/** Панель выбранной роли: название, назначение, исполнитель, превью запуска, инструкции вкладками, действия. */
function RolePanel({
  role: r, agents, enabled, count, workflow, permissionMode, ofTaskType, deleteBlocker, builtin, readOnly, onPatch, onAgent, onModel, onDuplicate, onRemove
}: PanelProps): React.JSX.Element {
  const t = useT()
  const locked = readOnly
  /** Открыто подтверждение удаления: что сломается без роли. */
  const [confirming, setConfirming] = useState(false)
  const current = agents.find((a) => a.id === r.agent)
  const state = roleAgentState(current)
  const isSystem = isSystemRole(r.id)
  const isService = !isTaskRole(r.id)
  const defaultDescription = defaultRoleDescription(r.id)
  const kind = roleKind(r.id)
  const losses = removalConsequences(r.id, count, workflow, ofTaskType)

  return (
    <section className="roles-panel" aria-label={t('config.roles.panelAria', { title: roleTitle(r) })}>
      {/* Только чтение — поля недоступны, а вкладки инструкций ниже остаются кликабельными. */}
      <fieldset className="roles-fields" disabled={readOnly}>
      <div className="roles-head">
        <div className="roles-head-main">
          <input
            className="roles-title-input"
            value={r.title}
            placeholder={t('config.roles.titlePlaceholder')}
            aria-label={t('config.roles.titlePlaceholder')}
            onChange={(e) => onPatch({ title: e.target.value }, true)}
          />
          <div className="roles-meta">
            <span className="chip mono" title={t('config.roles.idTitle')}>{r.id}</span>
            {isSystem && <span className="chip sys" title={t('config.roles.systemChipTitle')}>{t('config.roles.systemChip')}</span>}
            {isService
              ? <span className="chip sys">{t('config.roles.serviceBadge', { service: t(SERVICE_TEXT[kind]).toLowerCase() })}</span>
              : <span className="chip ok">{t('config.roles.assignable')}</span>}
          </div>
        </div>
        {!locked && <button type="button" className="btn-sm" onClick={onDuplicate}>{t('config.roles.duplicate')}</button>}
      </div>

      {state !== 'on' && (
        <div className="roles-warn" role="alert">
          {state === 'off'
            ? t('config.roles.warnOff', { agent: agentTitle(r.agent) })
            : t('config.roles.warnUnknown', { agent: r.agent })}
        </div>
      )}

      <div className="roles-sec">
        <div className="roles-sec-head">
          <span>{t('config.roles.purpose')}</span>
          <span className="roles-hint">{t('config.roles.purposeHint')}</span>
        </div>
        <textarea
          className="roles-description"
          value={r.description ?? ''}
          rows={3}
          placeholder={defaultDescription ?? t('config.roles.purposePlaceholder')}
          aria-label={t('config.roles.purposeAria')}
          onChange={(e) => onPatch({ description: e.target.value }, true)}
        />
        {defaultDescription ? (
          <div className="roles-hint">
            {withCode(t('config.roles.purposeDefault'), r.id, 'id')}{' '}
            {r.description !== defaultDescription && !locked && (
              <button type="button" className="roles-link" onClick={() => onPatch({ description: defaultDescription })}>
                {t('config.roles.resetDefault')}
              </button>
            )}
          </div>
        ) : !r.description?.trim() && (
          <div className="roles-warn">{t('config.roles.noPurpose')}</div>
        )}
      </div>

      <ExecutorFields
        exec={r}
        agents={agents}
        enabled={enabled}
        preview={commandPreview(t, r, kind, kind === 'coordinator' ? t('config.roles.ph.goal') : t('config.roles.ph.task'), permissionMode)}
        onAgent={onAgent}
        onModel={onModel}
        onEffort={(effort) => onPatch({ effort })}
        onExtraArgs={(extraArgs, debounce) => onPatch({ extraArgs }, debounce)}
      />
      </fieldset>

      <InstructionTabs
        idPrefix={`role-${r.id}`}
        kind={kind}
        agent={r.agent}
        systemPrompt={r.systemPrompt}
        promptTab={{ empty: t('config.roles.tab.prompt'), set: t('config.roles.tab.promptSet') }}
        promptPlaceholder={t('config.roles.promptPlaceholder')}
        promptHint={t('config.roles.promptHint', { title: r.title })}
        builtin={builtin}
        readOnly={readOnly}
        onPrompt={(systemPrompt) => onPatch({ systemPrompt }, true)}
        startNote={t(START_TEXT[kind])}
        startText={startTemplate(t, kind)}
      />

      {!locked && <div className="roles-foot">
        {count !== undefined && (
          <span className="roles-hint">
            {count > 0 ? t('config.roles.usedIn', { n: count }) : t('config.roles.noTasks')}
          </span>
        )}
        <span className="grow" />
        <button
          type="button"
          className="btn-sm danger"
          disabled={deleteBlocker !== undefined || confirming}
          title={deleteBlocker ?? t('config.roles.delete')}
          onClick={() => (losses.length > 0 ? setConfirming(true) : onRemove())}
        >
          <Icon.trash /> {t('config.roles.delete')}
        </button>
      </div>}
      {confirming && (
        <div className="roles-confirm" role="alertdialog" aria-label={t('config.roles.confirmTitle', { title: r.title })}>
          <div className="roles-confirm-title">
            {t(isSystem ? 'config.roles.confirmTitleSystem' : 'config.roles.confirmTitle', { title: r.title || r.id })}
          </div>
          <ul>{losses.map((l) => <li key={l}>{l}</li>)}</ul>
          <div className="roles-confirm-btns">
            <button type="button" className="btn-sm" autoFocus onClick={() => setConfirming(false)}>{t('config.roles.cancel')}</button>
            <button type="button" className="btn-sm danger-fill" onClick={onRemove}>{t('config.roles.remove')}</button>
          </div>
        </div>
      )}
    </section>
  )
}

/** Стартовое сообщение с ‹плейсхолдерами› — собирается теми же функциями, что и при запуске. */
function startTemplate(t: TFunction, kind: RoleKind): string {
  if (kind === 'coordinator') return coordinatorPrompt(t('config.roles.ph.goal'))
  return workerTaskPrompt({ title: t('config.roles.ph.taskTitle'), spec: t('config.roles.ph.taskSpec') })
}

/** Что запускает служебная роль (у воркерской kind — не используется). */
const SERVICE_TEXT: Record<RoleKind, TKey> = {
  coordinator: 'config.roles.service.coordinator',
  worker: 'config.roles.service.worker'
}

/** Что подставляется в ‹…› стартового сообщения. */
const START_TEXT: Record<RoleKind, TKey> = {
  coordinator: 'config.roles.start.coordinator',
  worker: 'config.roles.start.worker'
}
