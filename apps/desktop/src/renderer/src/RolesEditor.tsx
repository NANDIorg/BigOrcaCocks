import type React from 'react'
import { useEffect, useState } from 'react'
import {
  COORDINATOR_ROLE_ID,
  DEFAULT_ROLES,
  builtinPromptKind,
  coordinatorPrompt,
  defaultRoleDescription,
  effortOptions,
  effortOptionsFor,
  getAgent,
  modelLabel,
  modelOptions,
  promptChannel,
  workerTaskPrompt,
  type AgentInfo,
  type BuiltinPromptKind,
  type BuiltinPrompts,
  type AgentKind,
  type Role
} from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
import { Icon } from './icons'
import { useAutoSave } from './useAutoSave'

interface Props {
  /** Ключ черновика (id проекта или 'defaults'): при смене черновик переинициализируется. */
  storageKey: string
  /** Начальные роли (берутся при монтировании и при смене storageKey). */
  roles: Role[]
  /** Все агенты проекта: в выбор попадают включённые, выключенный текущий — с пометкой. */
  agents: AgentInfo[]
  /** Число задач проекта по id роли; нет — счётчики не показываются (дефолты для новых проектов). */
  taskCounts?: Readonly<Record<string, number>>
  onSave(roles: Role[]): Promise<void>
}

/** Системные роли (из DEFAULT_ROLES): их нельзя удалить, у пустого назначения есть значение по умолчанию. */
const SYSTEM_ROLE_IDS: ReadonlySet<string> = new Set(DEFAULT_ROLES.map((r) => r.id))

/** Роль с новыми полями; пустые description/model/effort/systemPrompt не сохраняем вовсе (undefined — «по умолчанию»). */
function withPatch(r: Role, p: Partial<Role>): Role {
  const next: Role = { ...r, ...p }
  if (!next.description?.trim()) delete next.description
  if (!next.model) delete next.model
  if (!next.effort) delete next.effort
  if (!next.systemPrompt?.trim()) delete next.systemPrompt
  return next
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

const AGENT_STATE_TEXT: Record<AgentState, string> = {
  on: 'Агент включён',
  off: 'Агент выключен — роль не запустится',
  unknown: 'Агент неизвестен — роль не запустится'
}

function newRoleId(): string {
  return `role_${Date.now().toString(36)}`
}

/** Раздел «Роли» («О проекте» и дефолт для новых проектов): список ролей слева, панель выбранной роли справа; сохраняется автоматически. */
export function RolesEditor({ storageKey, roles: initial, agents, taskCounts, onSave }: Props): React.JSX.Element {
  const { draft: roles, error, update } = useAutoSave<Role[]>(storageKey, initial, onSave)
  const enabled = agents.filter((a) => a.enabled)
  const builtin = useBuiltinPrompts()
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => (initial.find((r) => r.id !== COORDINATOR_ROLE_ID) ?? initial[0])?.id
  )
  /** Id перетаскиваемой роли (drag-ручка в списке). */
  const [dragId, setDragId] = useState<string | undefined>()
  const index = Math.max(0, roles.findIndex((r) => r.id === selectedId))
  const selected: Role | undefined = roles[index]

  function patch(i: number, p: Partial<Role>, debounce = false): void {
    update(roles.map((r, j) => (j === i ? withPatch(r, p) : r)), debounce)
  }

  /** Смена агента: модель и effort прошлого агента к новому не подходят — сбрасываются в «по умолчанию». */
  function changeAgent(i: number, agent: AgentKind): void {
    patch(i, { agent, model: undefined, effort: undefined })
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
    const role: Role = { id: newRoleId(), title: 'Новая роль', agent }
    update([...roles, role])
    setSelectedId(role.id)
  }

  function duplicate(i: number): void {
    const role: Role = { ...roles[i], id: newRoleId(), title: `${roles[i].title} (копия)` }
    update([...roles.slice(0, i + 1), role, ...roles.slice(i + 1)])
    setSelectedId(role.id)
  }

  function remove(i: number): void {
    const next = roles.filter((_, j) => j !== i)
    update(next)
    setSelectedId(next[Math.min(i, next.length - 1)]?.id)
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

  /** Сдвиг роли с клавиатуры (Alt+↑/↓) — альтернатива перетаскиванию; координатор в списке задач не участвует. */
  function shift(id: string, delta: -1 | 1): void {
    const list = roles.filter((r) => r.id !== COORDINATOR_ROLE_ID)
    const target = list[list.findIndex((r) => r.id === id) + delta]
    if (target) move(id, target.id)
  }

  const system = roles.filter((r) => r.id === COORDINATOR_ROLE_ID)
  const taskRoles = roles.filter((r) => r.id !== COORDINATOR_ROLE_ID)

  function item(r: Role): React.JSX.Element {
    const info = agents.find((a) => a.id === r.agent)
    const state = agentState(info)
    const isCoordinator = r.id === COORDINATOR_ROLE_ID
    const summary = [
      info?.title ?? r.agent,
      state === 'on' ? modelLabel(info, r.model) : state === 'off' ? 'выключен' : 'неизвестен',
      state === 'on' ? r.effort : undefined
    ].filter(Boolean).join(' · ')
    const count = taskCounts?.[r.id]
    return (
      <li
        key={r.id}
        className={`roles-item${r.id === selected?.id ? ' active' : ''}${dragId === r.id ? ' dragging' : ''}`}
        onDragOver={isCoordinator || !dragId ? undefined : (e) => e.preventDefault()}
        onDrop={isCoordinator || !dragId ? undefined : (e) => {
          e.preventDefault()
          move(dragId, r.id)
          setDragId(undefined)
        }}
      >
        {isCoordinator ? (
          <span className={`roles-dot ${state}`} role="img" aria-label={AGENT_STATE_TEXT[state]} title={AGENT_STATE_TEXT[state]} />
        ) : (
          <span
            className="roles-handle"
            draggable
            title="Перетащите, чтобы изменить порядок (или Alt+↑/↓)"
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
            if (isCoordinator || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
            e.preventDefault()
            shift(r.id, e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <span className="roles-title">
            <span className="roles-name">{r.title || 'Без названия'}</span>
            {!isCoordinator && state !== 'on' && (
              <span className={`roles-dot ${state}`} role="img" aria-label={AGENT_STATE_TEXT[state]} title={AGENT_STATE_TEXT[state]} />
            )}
          </span>
          <span className="roles-sub">
            <AgentLogo agent={r.agent} size={14} />
            <span className="roles-name">{summary}</span>
          </span>
        </button>
        {isCoordinator ? (
          <span className="chip sys" title="Запускает прогон, задачам не назначается">запуск</span>
        ) : state !== 'on' ? (
          <span className="chip warn" title={AGENT_STATE_TEXT[state]}>!</span>
        ) : count !== undefined ? (
          <span className="chip mono" title={`Задач на роли: ${count}`}>{count}</span>
        ) : null}
      </li>
    )
  }

  return (
    <div className="editor roles-editor">
      <h3 style={{ color: 'var(--text)', margin: '0 0 12px' }}>Роли</h3>
      <div className="roles-md">
        <aside className="roles-list" aria-label="Список ролей">
          {system.length > 0 && (
            <>
              <div className="roles-group">Системная</div>
              <ul>{system.map(item)}</ul>
            </>
          )}
          <div className="roles-group">Роли для задач</div>
          <ul>{taskRoles.map(item)}</ul>
          <button type="button" className="btn-sm roles-add" onClick={add}>＋ Новая роль</button>
          <div className="roles-hint">
            Порядок — как в «Новой задаче».{taskCounts ? ' Число — задач проекта на роли.' : ''}
          </div>
        </aside>
        {selected ? (
          <RolePanel
            key={selected.id}
            role={selected}
            agents={agents}
            enabled={enabled}
            count={taskCounts?.[selected.id]}
            canDelete={roles.length > 1}
            builtin={builtin}
            onPatch={(p, debounce) => patch(index, p, debounce)}
            onAgent={(agent) => changeAgent(index, agent)}
            onModel={(model, debounce) => changeModel(index, model, debounce)}
            onDuplicate={() => duplicate(index)}
            onRemove={() => remove(index)}
          />
        ) : (
          <section className="roles-panel roles-empty">Ролей нет — добавьте первую.</section>
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
  canDelete: boolean
  builtin: BuiltinState
  onPatch(p: Partial<Role>, debounce?: boolean): void
  onAgent(agent: AgentKind): void
  onModel(model: string, debounce?: boolean): void
  onDuplicate(): void
  onRemove(): void
}

type RoleTab = 'prompt' | 'builtin' | 'start'

/** Панель выбранной роли: название, назначение, исполнитель, превью запуска, инструкции вкладками, действия. */
function RolePanel({
  role: r, agents, enabled, count, canDelete, builtin, onPatch, onAgent, onModel, onDuplicate, onRemove
}: PanelProps): React.JSX.Element {
  const [tab, setTab] = useState<RoleTab>('prompt')
  const current = agents.find((a) => a.id === r.agent)
  const state = agentState(current)
  const defaults = current?.defaults
  const models = current ? modelOptions(current) : []
  const customModel = r.model && !models.some((m) => m.id === r.model) ? r.model : undefined
  const defaultModel = modelLabel(current, defaults?.model)
  const efforts = effortsOf(current, r.agent, r.model)
  const isSystem = SYSTEM_ROLE_IDS.has(r.id)
  const isCoordinator = r.id === COORDINATOR_ROLE_ID
  const defaultDescription = defaultRoleDescription(r.id)
  const kind = builtinPromptKind(r.id)
  const builtinText = builtin && 'prompts' in builtin ? builtin.prompts[kind] : undefined
  const deleteTitle = isSystem
    ? 'Системную роль удалить нельзя'
    : !canDelete ? 'Нельзя удалить последнюю роль' : 'Удалить роль'
  const tabs: { id: RoleTab; label: string }[] = [
    { id: 'prompt', label: r.systemPrompt ? 'Инструкции роли •' : 'Инструкции роли' },
    { id: 'builtin', label: `Встроенная инструкция Orca${builtinText ? ` · ${lineCount(builtinText)} строк` : ''}` },
    { id: 'start', label: 'Стартовое сообщение' }
  ]

  return (
    <section className="roles-panel" aria-label={`Роль «${r.title}»`}>
      <div className="roles-head">
        <div className="roles-head-main">
          <input
            className="roles-title-input"
            value={r.title}
            placeholder="Название роли"
            aria-label="Название роли"
            onChange={(e) => onPatch({ title: e.target.value }, true)}
          />
          <div className="roles-meta">
            <span className="chip mono" title="id роли (для CLI: --role)">{r.id}</span>
            {isSystem && <span className="chip sys">системная · нельзя удалить</span>}
            {isCoordinator
              ? <span className="chip sys">запускает прогон · задачам не назначается</span>
              : <span className="chip ok">назначается задачам</span>}
          </div>
        </div>
        <button type="button" className="btn-sm" onClick={onDuplicate}>Дублировать</button>
      </div>

      {state !== 'on' && (
        <div className="roles-warn" role="alert">
          {state === 'off'
            ? `Агент «${current?.title}» выключен — роль не запустится. Выберите другого агента или включите этого в списке агентов.`
            : `Агент «${r.agent}» неизвестен — роль не запустится. Выберите другого агента.`}
        </div>
      )}

      <div className="roles-sec">
        <div className="roles-sec-head">
          <span>Назначение</span>
          <span className="roles-hint">координатор выбирает роль по этому тексту</span>
        </div>
        <textarea
          className="roles-description"
          value={r.description ?? ''}
          rows={3}
          placeholder={defaultDescription ?? 'Что делает роль и когда её брать'}
          aria-label="Назначение роли"
          onChange={(e) => onPatch({ description: e.target.value }, true)}
        />
        {defaultDescription ? (
          <div className="roles-hint">
            Пусто — берётся назначение по умолчанию для <code>{r.id}</code>.{' '}
            {r.description !== defaultDescription && (
              <button type="button" className="roles-link" onClick={() => onPatch({ description: defaultDescription })}>
                Вернуть по умолчанию
              </button>
            )}
          </div>
        ) : !r.description?.trim() && (
          <div className="roles-warn">Нет назначения — координатор выберет роль только по id и названию.</div>
        )}
      </div>

      <div className="roles-sec">
        <div className="roles-sec-head"><span>Исполнитель</span></div>
        <div className="roles-grid3">
          <div className="roles-field">
            <span className="roles-label">Агент</span>
            <div className="roles-agent">
              <AgentLogo agent={r.agent} size={18} />
              <select
                value={r.agent}
                className={state !== 'on' ? 'off' : ''}
                aria-label="Агент"
                onChange={(e) => onAgent(e.target.value as AgentKind)}
              >
                {enabled.map((a) => (
                  <option key={a.id} value={a.id}>{a.title}</option>
                ))}
                {state === 'off' && current && <option value={current.id} disabled>{current.title} (выключен)</option>}
                {state === 'unknown' && <option value={r.agent} disabled>{r.agent} (неизвестен)</option>}
              </select>
            </div>
          </div>
          <div className="roles-field">
            <span className="roles-label">Модель</span>
            {models.length > 0 ? (
              <select value={r.model ?? ''} aria-label="Модель" onChange={(e) => onModel(e.target.value)}>
                <option value="">{defaultModel ? `по умолчанию агента: ${defaultModel}` : 'по умолчанию агента'}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
                {customModel && <option value={customModel}>{customModel} (нестандартная)</option>}
              </select>
            ) : (
              <input
                value={r.model ?? ''}
                aria-label="Модель"
                placeholder={defaults?.model ? `по умолчанию агента: ${defaults.model}` : 'по умолчанию агента'}
                onChange={(e) => onModel(e.target.value, true)}
              />
            )}
          </div>
          <div className="roles-field">
            <span className="roles-label">
              <span>Усилие</span>
              {defaults?.effort && <span>по умолчанию: {defaults.effort}</span>}
            </span>
            {efforts.length > 0 ? (
              <div className="roles-effort" role="radiogroup" aria-label="Усилие">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!r.effort}
                  className={!r.effort ? 'on' : ''}
                  title="По умолчанию агента"
                  onClick={() => onPatch({ effort: undefined })}
                >
                  авто
                </button>
                {efforts.map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={r.effort === e}
                    className={`${r.effort === e ? 'on' : ''}${defaults?.effort === e ? ' def' : ''}`}
                    title={defaults?.effort === e ? `${e} — по умолчанию агента` : e}
                    onClick={() => onPatch({ effort: e })}
                  >
                    {e}
                  </button>
                ))}
                {r.effort && !efforts.includes(r.effort) && (
                  <button type="button" role="radio" aria-checked className="on bad" disabled title="Модель не поддерживает этот уровень">
                    {r.effort}
                  </button>
                )}
              </div>
            ) : (
              <div className="roles-hint roles-effort-none">агент не поддерживает выбор усилия</div>
            )}
          </div>
        </div>
        <pre className="roles-preview" aria-label="Команда запуска">
          <span className="k">$</span> {commandPreview(r, kind)}
        </pre>
      </div>

      <div className="roles-sec">
        <div className="roles-tabs" role="tablist" aria-label="Инструкции">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`role-tab-${r.id}-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`role-tabpanel-${r.id}`}
              className={tab === t.id ? 'on' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id={`role-tabpanel-${r.id}`} role="tabpanel" aria-labelledby={`role-tab-${r.id}-${tab}`} className="roles-tabpanel">
          {tab === 'prompt' && (
            <>
              <textarea
                value={r.systemPrompt ?? ''}
                placeholder="Например: пиши тесты на каждое изменение. Встроенную инструкцию сюда копировать не нужно."
                rows={5}
                aria-label="Инструкции роли"
                onChange={(e) => onPatch({ systemPrompt: e.target.value }, true)}
              />
              <div className="roles-hint">
                Дописываются после встроенной инструкции блоком «# Инструкции роли «{r.title}»» и не заменяют её.
                Пусто — агент получает только встроенную.
              </div>
            </>
          )}
          {tab === 'builtin' && (
            <>
              <div className="roles-hint">skills/{kind}.md · только чтение</div>
              {builtinText !== undefined ? (
                <pre className="role-text" tabIndex={0} aria-label="Встроенная инструкция Orca">{builtinText.trimEnd()}</pre>
              ) : (
                <div className="roles-hint">
                  {builtin && 'error' in builtin ? `Не удалось загрузить: ${builtin.error}` : 'Загрузка…'}
                </div>
              )}
              {kind === 'coordinator' && (
                <div className="roles-hint">
                  С ней запускается координатор. Если назначить роль <code>coordinator</code> задаче, воркер получит воркерскую
                  инструкцию (skills/worker.md).
                </div>
              )}
            </>
          )}
          {tab === 'start' && (
            <>
              <div className="roles-hint">
                {current?.title ?? r.agent} {CHANNEL_TEXT[promptChannel(getAgent(r.agent))]}. В ‹…› подставляются данные{' '}
                {kind === 'coordinator'
                  ? 'прогона; если к цели приложены изображения, добавляется блок с путями к ним.'
                  : 'задачи; после возврата с ревью добавляется блок «Замечания после ревью».'}
              </div>
              <pre className="role-text short">{startTemplate(kind)}</pre>
            </>
          )}
        </div>
      </div>

      <div className="roles-foot">
        {count !== undefined && (
          <span className="roles-hint">
            {count > 0 ? `Используется в задачах проекта: ${count}` : 'Задач на этой роли нет'}
          </span>
        )}
        <span className="grow" />
        <button type="button" className="btn-sm danger" disabled={isSystem || !canDelete} title={deleteTitle} onClick={onRemove}>
          <Icon.trash /> Удалить роль
        </button>
      </div>
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
function commandPreview(r: Role, kind: BuiltinPromptKind): string {
  const spec = getAgent(r.agent)
  if (!spec) return `${r.agent}: агент неизвестен`
  const system = `‹skills/${kind}.md${r.systemPrompt ? ' + инструкции роли' : ''}›`
  const prompt = kind === 'coordinator' ? '‹цель прогона›' : '‹задание›'
  const { command, args } = spec.invoke(system, prompt, {
    permissionMode: '‹режим разрешений›', shell: '$SHELL', model: r.model, effort: r.effort
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
function startTemplate(kind: BuiltinPromptKind): string {
  return kind === 'coordinator'
    ? coordinatorPrompt('‹цель прогона›')
    : workerTaskPrompt({ title: '‹название задачи›', spec: '‹описание задачи›' })
}

const CHANNEL_TEXT = {
  system: 'получает встроенную и дополнительные инструкции как системный промпт (--append-system-prompt), а стартовое сообщение — отдельно',
  combined: 'не имеет отдельного системного промпта: инструкции идут в начале стартового сообщения, после разделителя «---» — задание',
  none: 'запускается без промпта: инструкции и задание не передаются'
} as const
