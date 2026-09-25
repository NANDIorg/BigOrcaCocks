import type React from 'react'
import { useEffect, useState } from 'react'
import {
  ASSISTANT_START_PROMPT,
  builtinPromptKind,
  coordinatorPrompt,
  defaultRoleDescription,
  effortOptions,
  effortOptionsFor,
  getAgent,
  isTaskRole,
  modelLabel,
  modelOptions,
  promptChannel,
  workerTaskPrompt,
  type AgentInfo,
  type BuiltinPromptKind,
  type BuiltinPrompts,
  type AgentKind,
  type Role,
  type Workflow
} from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { isSystemRole, missingSystemRoles, removalConsequences, removeBlocker, restoreSystemRoles } from './roleRemoval'
import { useAutoSave } from './useAutoSave'
import { agentChangePatch, withPatch } from './roleEdit'
import { useT, type TFunction, type TKey } from './i18n'
import { withCode } from './about/parts'

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
  /** Только просмотр: роли можно выбирать и читать, правки не сохраняются. */
  readOnly?: boolean
  /** Роли типа задачи: в последствиях удаления — незакрытые глобальные задачи этого типа. */
  ofTaskType?: boolean
  onSave(roles: Role[]): Promise<void>
}

/** Уровни effort роли: по модели агента, если агент известен, иначе общий список из реестра. */
function effortsOf(info: AgentInfo | undefined, agent: string, model: string | undefined): readonly string[] {
  return info ? effortOptionsFor(info, model) : effortOptions(agent)
}

/** Состояние агента роли для точки статуса и предупреждений. */
type AgentState = 'on' | 'off' | 'unknown'

function agentState(info: AgentInfo | undefined): AgentState {
  if (!info) return 'unknown'
  return info.enabled ? 'on' : 'off'
}

const AGENT_STATE_TEXT: Record<AgentState, TKey> = {
  on: 'config.roles.agentState.on',
  off: 'config.roles.agentState.off',
  unknown: 'config.roles.agentState.unknown'
}

function newRoleId(): string {
  return `role_${Date.now().toString(36)}`
}

/** Вкладка «Роли» типа задачи («Настройки» → «Типы задач»): список ролей слева, панель выбранной роли справа; сохраняется автоматически. */
export function RolesEditor({
  storageKey, roles: initial, agents, taskCounts, workflow, readOnly = false, ofTaskType = false, onSave
}: Props): React.JSX.Element {
  const t = useT()
  const { draft: roles, error, update: save } = useAutoSave<Role[]>(storageKey, initial, onSave)
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

  /** Смена агента: модель и effort сбрасываются — `agentChangePatch`. */
  function changeAgent(i: number, agent: AgentKind): void {
    patch(i, agentChangePatch(agent))
  }

  /** Смена модели: effort, которого нет у новой модели, сбрасывается. */
  function changeModel(i: number, model: string, debounce = false): void {
    const r = roles[i]
    const efforts = effortsOf(agents.find((a) => a.id === r.agent), r.agent, model || undefined)
    const effort = r.effort && efforts.includes(r.effort) ? r.effort : undefined
    patch(i, { model, effort }, debounce)
  }

  function add(): void {
    const agent: AgentKind = enabled[0]?.id ?? agents[0]?.id ?? 'claude'
    const role: Role = { id: newRoleId(), title: t('config.roles.newRole'), agent }
    update([...roles, role])
    setSelectedId(role.id)
  }

  function duplicate(i: number): void {
    const role: Role = { ...roles[i], id: newRoleId(), title: t('config.roles.copyTitle', { title: roles[i].title }) }
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
    const state = agentState(info)
    const isService = !isTaskRole(r.id)
    const summary = [
      info?.title ?? r.agent,
      state === 'on' ? modelLabel(info, r.model) : state === 'off' ? t('config.roles.summaryOff') : t('config.roles.summaryUnknown'),
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
            <span className="roles-name">{r.title || t('config.roles.untitled')}</span>
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
          <span className="chip sys" title={t('config.roles.serviceChipTitle', { service: t(SERVICE_TEXT[builtinPromptKind(r.id)]) })}>{t('config.roles.serviceChip')}</span>
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

type RoleTab = 'prompt' | 'builtin' | 'start'

/** Панель выбранной роли: название, назначение, исполнитель, превью запуска, инструкции вкладками, действия. */
function RolePanel({
  role: r, agents, enabled, count, workflow, ofTaskType, deleteBlocker, builtin, readOnly, onPatch, onAgent, onModel, onDuplicate, onRemove
}: PanelProps): React.JSX.Element {
  const t = useT()
  const locked = readOnly
  const [tab, setTab] = useState<RoleTab>('prompt')
  /** Открыто подтверждение удаления: что сломается без роли. */
  const [confirming, setConfirming] = useState(false)
  const current = agents.find((a) => a.id === r.agent)
  const state = agentState(current)
  const defaults = current?.defaults
  const models = current ? modelOptions(current) : []
  const customModel = r.model && !models.some((m) => m.id === r.model) ? r.model : undefined
  const defaultModel = modelLabel(current, defaults?.model)
  const efforts = effortsOf(current, r.agent, r.model)
  const isSystem = isSystemRole(r.id)
  const isService = !isTaskRole(r.id)
  const defaultDescription = defaultRoleDescription(r.id)
  const kind = builtinPromptKind(r.id)
  const builtinText = builtin && 'prompts' in builtin ? builtin.prompts[kind] : undefined
  const losses = removalConsequences(r.id, count, workflow, ofTaskType)
  const tabs: { id: RoleTab; label: string }[] = [
    { id: 'prompt', label: r.systemPrompt ? t('config.roles.tab.promptSet') : t('config.roles.tab.prompt') },
    {
      id: 'builtin',
      label: builtinText ? t('config.roles.tab.builtinLines', { count: lineCount(builtinText) }) : t('config.roles.tab.builtin')
    },
    { id: 'start', label: t('config.roles.tab.start') }
  ]

  return (
    <section className="roles-panel" aria-label={t('config.roles.panelAria', { title: r.title })}>
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
            ? t('config.roles.warnOff', { agent: current?.title ?? r.agent })
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

      <div className="roles-sec">
        <div className="roles-sec-head"><span>{t('config.roles.executor')}</span></div>
        <div className="roles-grid3">
          <div className="roles-field">
            <span className="roles-label">{t('config.roles.agent')}</span>
            <div className="roles-agent">
              <AgentLogo agent={r.agent} size={18} />
              <select
                value={r.agent}
                className={state !== 'on' ? 'off' : ''}
                aria-label={t('config.roles.agent')}
                onChange={(e) => onAgent(e.target.value as AgentKind)}
              >
                {enabled.map((a) => (
                  <option key={a.id} value={a.id}>{a.title}</option>
                ))}
                {state === 'off' && current && <option value={current.id} disabled>{t('config.roles.agentOffOption', { agent: current.title })}</option>}
                {state === 'unknown' && <option value={r.agent} disabled>{t('config.roles.agentUnknownOption', { agent: r.agent })}</option>}
              </select>
            </div>
          </div>
          <div className="roles-field">
            <span className="roles-label">{t('config.roles.model')}</span>
            {models.length > 0 ? (
              <select value={r.model ?? ''} aria-label={t('config.roles.model')} onChange={(e) => onModel(e.target.value)}>
                <option value="">{defaultModel ? t('config.roles.modelDefaultOf', { model: defaultModel }) : t('config.roles.modelDefault')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
                {customModel && <option value={customModel}>{t('config.roles.modelCustom', { model: customModel })}</option>}
              </select>
            ) : (
              <input
                value={r.model ?? ''}
                aria-label={t('config.roles.model')}
                placeholder={defaults?.model ? t('config.roles.modelDefaultOf', { model: defaults.model }) : t('config.roles.modelDefault')}
                onChange={(e) => onModel(e.target.value, true)}
              />
            )}
          </div>
          <div className="roles-field">
            <span className="roles-label">
              <span>{t('config.roles.effort')}</span>
              {defaults?.effort && <span>{t('config.roles.effortDefault', { effort: defaults.effort })}</span>}
            </span>
            {efforts.length > 0 ? (
              <div className="roles-effort" role="radiogroup" aria-label={t('config.roles.effort')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!r.effort}
                  className={!r.effort ? 'on' : ''}
                  title={t('config.roles.effortAutoTitle')}
                  onClick={() => onPatch({ effort: undefined })}
                >
                  {t('config.roles.effortAuto')}
                </button>
                {efforts.map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={r.effort === e}
                    className={`${r.effort === e ? 'on' : ''}${defaults?.effort === e ? ' def' : ''}`}
                    title={defaults?.effort === e ? t('config.roles.effortIsDefault', { effort: e }) : e}
                    onClick={() => onPatch({ effort: e })}
                  >
                    {e}
                  </button>
                ))}
                {r.effort && !efforts.includes(r.effort) && (
                  <button type="button" role="radio" aria-checked className="on bad" disabled title={t('config.roles.effortUnsupported')}>
                    {r.effort}
                  </button>
                )}
              </div>
            ) : (
              <div className="roles-hint roles-effort-none">{t('config.roles.effortNone')}</div>
            )}
          </div>
        </div>
        <pre className="roles-preview" aria-label={t('config.roles.commandAria')}>
          <span className="k">$</span> {commandPreview(t, r, kind)}
        </pre>
      </div>
      </fieldset>

      <div className="roles-sec">
        <div className="roles-tabs" role="tablist" aria-label={t('config.roles.tabsAria')}>
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              id={`role-tab-${r.id}-${x.id}`}
              aria-selected={tab === x.id}
              aria-controls={`role-tabpanel-${r.id}`}
              className={tab === x.id ? 'on' : ''}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div id={`role-tabpanel-${r.id}`} role="tabpanel" aria-labelledby={`role-tab-${r.id}-${tab}`} className="roles-tabpanel">
          {tab === 'prompt' && (
            <>
              <textarea
                value={r.systemPrompt ?? ''}
                placeholder={t('config.roles.promptPlaceholder')}
                rows={5}
                readOnly={readOnly}
                aria-label={t('config.roles.tab.prompt')}
                onChange={(e) => onPatch({ systemPrompt: e.target.value }, true)}
              />
              <div className="roles-hint">
                {t('config.roles.promptHint', { title: r.title })}
              </div>
            </>
          )}
          {tab === 'builtin' && (
            <>
              <div className="roles-hint">{t('config.roles.builtinSource', { kind })}</div>
              {builtinText !== undefined ? (
                <pre className="role-text" tabIndex={0} aria-label={t('config.roles.tab.builtin')}>{builtinText.trimEnd()}</pre>
              ) : (
                <div className="roles-hint">
                  {builtin && 'error' in builtin ? t('config.roles.loadFailed', { error: builtin.error }) : t('common.loading')}
                </div>
              )}
              {kind === 'coordinator' && (
                <div className="roles-hint">
                  {withCode(t('config.roles.coordinatorHint'), 'coordinator', 'code')}
                </div>
              )}
            </>
          )}
          {tab === 'start' && (
            <>
              <div className="roles-hint">
                {t('config.roles.startLead', { agent: current?.title ?? r.agent, channel: t(CHANNEL_TEXT[promptChannel(getAgent(r.agent))]) })}{' '}
                {t(START_TEXT[kind])}
              </div>
              <pre className="role-text short">{startTemplate(t, kind)}</pre>
            </>
          )}
        </div>
      </div>

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

function lineCount(text: string): number {
  return text.trimEnd().split('\n').length
}

/** Аргумент для превью команды: плейсхолдеры ‹…› как есть, остальное со спецсимволами — в кавычках. */
function shellArg(arg: string): string {
  const flat = arg.replace(/\s*\n\s*/g, ' ')
  if (flat.includes('‹') || !/[\s'"*()$&|;<>]/.test(flat)) return flat
  return `'${flat.replace(/'/g, `'\\''`)}'`
}

/** Строка запуска агента роли — из того же `invoke` реестра, что и реальный запуск; тексты — плейсхолдерами. */
function commandPreview(t: TFunction, r: Role, kind: BuiltinPromptKind): string {
  const spec = getAgent(r.agent)
  if (!spec) return t('config.roles.agentUnknownCmd', { agent: r.agent })
  const system = t(r.systemPrompt ? 'config.roles.ph.systemWithRole' : 'config.roles.ph.system', { kind })
  const prompt = kind === 'coordinator' ? t('config.roles.ph.goal') : kind === 'assistant' ? ASSISTANT_START_PROMPT : t('config.roles.ph.task')
  const { command, args } = spec.invoke(system, prompt, {
    permissionMode: t('config.roles.ph.permission'), shell: '$SHELL', model: r.model, effort: r.effort
  })
  return [command, ...args].map(shellArg).join(' ')
}

type BuiltinState = { prompts: BuiltinPrompts } | { error: string } | undefined

/** Служебные инструкции Orca из main-процесса — тот же текст, что агенты получают при запуске. */
function useBuiltinPrompts(): BuiltinState {
  const [state, setState] = useState<BuiltinState>()
  useEffect(() => {
    let alive = true
    window.orca.prompts.builtin().then(
      (prompts) => alive && setState({ prompts }),
      (e: unknown) => alive && setState({ error: (e as Error).message ?? String(e) })
    )
    return () => {
      alive = false
    }
  }, [])
  return state
}

/** Стартовое сообщение с ‹плейсхолдерами› — собирается теми же функциями, что и при запуске. */
function startTemplate(t: TFunction, kind: BuiltinPromptKind): string {
  if (kind === 'coordinator') return coordinatorPrompt(t('config.roles.ph.goal'))
  if (kind === 'assistant') return ASSISTANT_START_PROMPT
  return workerTaskPrompt({ title: t('config.roles.ph.taskTitle'), spec: t('config.roles.ph.taskSpec') })
}

/** Что запускает служебная роль (у воркерской kind — не используется). */
const SERVICE_TEXT: Record<BuiltinPromptKind, TKey> = {
  coordinator: 'config.roles.service.coordinator',
  assistant: 'config.roles.service.assistant',
  worker: 'config.roles.service.worker'
}

/** Как передаётся промпт агенту (`promptChannel`). */
const CHANNEL_TEXT: Record<ReturnType<typeof promptChannel>, TKey> = {
  system: 'config.roles.channel.system',
  combined: 'config.roles.channel.combined',
  none: 'config.roles.channel.none'
}

/** Что подставляется в ‹…› стартового сообщения. */
const START_TEXT: Record<BuiltinPromptKind, TKey> = {
  coordinator: 'config.roles.start.coordinator',
  assistant: 'config.roles.start.assistant',
  worker: 'config.roles.start.worker'
}
