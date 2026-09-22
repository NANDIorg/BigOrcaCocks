import type React from 'react'
import { useEffect, useState } from 'react'
import {
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
  onSave(roles: Role[]): Promise<void>
}

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

/** Раздел «Роли» («О проекте» и дефолт для новых проектов): название, назначение, агент, модель, усилие; сохраняется автоматически. */
export function RolesEditor({ storageKey, roles: initial, agents, onSave }: Props): React.JSX.Element {
  const { draft: roles, error, update } = useAutoSave<Role[]>(storageKey, initial, onSave)
  const enabled = agents.filter((a) => a.enabled)
  const canDelete = roles.length > 1
  const builtin = useBuiltinPrompts()
  /** Роли с раскрытыми инструкциями; по умолчанию все свёрнуты. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())

  function toggle(id: string): void {
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

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
    update([...roles, { id: `role_${Date.now().toString(36)}`, title: 'Новая роль', agent }])
  }

  return (
    <div className="editor">
      <h3 style={{ color: 'var(--text)', margin: '0 0 12px' }}>Роли</h3>
      <div className="editor-table roles">
        <div className="editor-head">Название</div>
        <div className="editor-head">Агент</div>
        <div className="editor-head">Модель</div>
        <div className="editor-head">Усилие</div>
        <div className="editor-head" />
        {roles.map((r, i) => {
          const current = agents.find((a) => a.id === r.agent)
          const currentOff = current !== undefined && !current.enabled
          const defaults = current?.defaults
          const models = current ? modelOptions(current) : []
          const customModel = r.model && !models.some((m) => m.id === r.model) ? r.model : undefined
          const defaultModel = modelLabel(current, defaults?.model)
          const efforts = effortsOf(current, r.agent, r.model)
          const isOpen = open.has(r.id)
          const detailsId = `role-instructions-${r.id}`
          return (
            <div key={r.id} className="editor-row">
              <div>
                <input
                  value={r.title}
                  placeholder="Название роли"
                  aria-label="Название роли"
                  onChange={(e) => patch(i, { title: e.target.value }, true)}
                />
                <div className="editor-id">{r.id}</div>
                <textarea
                  className="role-description"
                  value={r.description ?? ''}
                  rows={2}
                  placeholder={defaultRoleDescription(r.id) ?? 'Назначение: что делает роль и когда её брать'}
                  aria-label="Назначение роли"
                  title="По назначению координатор выбирает роль для задач (orca-board roles list)"
                  onChange={(e) => patch(i, { description: e.target.value }, true)}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <AgentLogo agent={r.agent} size={18} />
                <select
                  value={r.agent}
                  className={currentOff ? 'off' : ''}
                  aria-label="Агент"
                  style={{ flex: 1, minWidth: 0 }}
                  onChange={(e) => changeAgent(i, e.target.value as AgentKind)}
                >
                  {enabled.map((a) => (
                    <option key={a.id} value={a.id}>{a.title}</option>
                  ))}
                  {currentOff && (
                    <option value={current.id} disabled>{current.title} (выключен)</option>
                  )}
                  {!current && <option value={r.agent} disabled>{r.agent} (неизвестен)</option>}
                </select>
              </div>
              <div>
                {models.length > 0 ? (
                  <select value={r.model ?? ''} aria-label="Модель" onChange={(e) => changeModel(i, e.target.value)}>
                    <option value="">{defaultModel ? `по умолчанию: ${defaultModel}` : 'по умолчанию агента'}</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    {customModel && <option value={customModel}>{customModel} (нестандартная)</option>}
                  </select>
                ) : (
                  <input
                    value={r.model ?? ''}
                    aria-label="Модель"
                    placeholder={defaults?.model ? `по умолчанию: ${defaults.model}` : 'по умолчанию агента'}
                    onChange={(e) => changeModel(i, e.target.value, true)}
                  />
                )}
              </div>
              <div>
                {efforts.length > 0 ? (
                  <select value={r.effort ?? ''} aria-label="Усилие" onChange={(e) => patch(i, { effort: e.target.value })}>
                    <option value="">{defaults?.effort ? `по умолчанию: ${defaults.effort}` : 'по умолчанию'}</option>
                    {efforts.map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                    {r.effort && !efforts.includes(r.effort) && (
                      <option value={r.effort} disabled>{r.effort} (не поддерживается)</option>
                    )}
                  </select>
                ) : (
                  <select value="" disabled aria-label="Усилие" title="Агент не поддерживает выбор усилия">
                    <option value="">—</option>
                  </select>
                )}
              </div>
              <div className="role-actions">
                <button
                  type="button"
                  className={`btn-sm role-toggle${isOpen ? ' open' : ''}`}
                  aria-expanded={isOpen}
                  aria-controls={detailsId}
                  title={
                    (isOpen ? 'Свернуть инструкции' : 'Показать встроенную инструкцию и дополнения роли') +
                    (r.systemPrompt ? ' (есть дополнительные инструкции)' : '')
                  }
                  onClick={() => toggle(r.id)}
                >
                  <span className="role-chevron" aria-hidden="true">▸</span>
                  Инструкции
                  {r.systemPrompt && <span className="role-dot" role="img" aria-label="есть дополнительные инструкции" />}
                </button>
                <button
                  type="button"
                  className="card-tool danger"
                  disabled={!canDelete}
                  aria-label={`Удалить роль «${r.title}»`}
                  title={canDelete ? 'Удалить роль' : 'Нельзя удалить последнюю роль'}
                  onClick={() => update(roles.filter((_, j) => j !== i))}
                >
                  <Icon.trash />
                </button>
              </div>
              {isOpen && (
                <RoleInstructions
                  id={detailsId}
                  role={r}
                  agentTitle={current?.title ?? r.agent}
                  builtin={builtin}
                  onChange={(systemPrompt) => patch(i, { systemPrompt }, true)}
                />
              )}
            </div>
          )
        })}
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="editor-actions">
        <button className="btn-sm" onClick={add}>Добавить роль</button>
      </div>
      <p className="editor-hint">
        Роль задаёт агента, модель и усилие (уровень рассуждений). «Назначение» видит координатор: по нему он выбирает,
        какой роли отдать задачу; без назначения он ориентируется только на id и название. У системных ролей
        (<code>coordinator</code>, <code>developer</code>, <code>reviewer</code>, <code>qa</code>) пустое назначение
        заменяется назначением по умолчанию. «Инструкции» показывают встроенную инструкцию Orca,
        которую агент роли получает при запуске, и дополнительные инструкции роли — они дописываются после встроенной
        при следующем запуске и не заменяют её. Координатор запускается ролью <code>coordinator</code>; в задачах роль
        выбирается при создании (для CLI — <code>--role &lt;id&gt;</code>).
      </p>
    </div>
  )
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

interface InstructionsProps {
  id: string
  role: Role
  agentTitle: string
  builtin: BuiltinState
  onChange(systemPrompt: string): void
}

/** Раскрытые инструкции роли: встроенная (только чтение), дополнительные (редактируются), шаблон стартового сообщения. */
function RoleInstructions({ id, role, agentTitle, builtin, onChange }: InstructionsProps): React.JSX.Element {
  const kind = builtinPromptKind(role.id)
  const text = builtin && 'prompts' in builtin ? builtin.prompts[kind] : undefined
  return (
    <div id={id} className="role-details" role="region" aria-label={`Инструкции роли «${role.title}»`}>
      <section className="role-section">
        <div className="role-section-head">
          <span>Встроенная инструкция Orca</span>
          <span className="role-meta">
            skills/{kind}.md · только чтение{text ? ` · ${text.trimEnd().split('\n').length} строк` : ''}
          </span>
        </div>
        {text !== undefined ? (
          <pre className="role-text" tabIndex={0} aria-label="Встроенная инструкция Orca">{text.trimEnd()}</pre>
        ) : (
          <div className="role-meta">
            {builtin && 'error' in builtin ? `Не удалось загрузить: ${builtin.error}` : 'Загрузка…'}
          </div>
        )}
        {kind === 'coordinator' && (
          <div className="role-meta">
            С ней запускается координатор. Если назначить роль <code>coordinator</code> задаче, воркер получит воркерскую
            инструкцию (skills/worker.md).
          </div>
        )}
      </section>
      <label className="role-section">
        <span className="role-section-head">
          <span>Дополнительные инструкции роли</span>
          <span className="role-meta">необязательно</span>
        </span>
        <textarea
          value={role.systemPrompt ?? ''}
          placeholder="Например: пиши тесты на каждое изменение. Встроенную инструкцию сюда копировать не нужно."
          rows={4}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="role-meta">
          Дописываются после встроенной блоком «# Инструкции роли «{role.title}»». Пусто — агент получает только встроенную.
        </span>
      </label>
      <section className="role-section">
        <div className="role-section-head">
          <span>Стартовое сообщение</span>
          <span className="role-meta">зависит от {kind === 'coordinator' ? 'прогона' : 'задачи'}</span>
        </div>
        <div className="role-meta">
          {agentTitle} {CHANNEL_TEXT[promptChannel(getAgent(role.agent))]}. В ‹…› подставляются данные{' '}
          {kind === 'coordinator'
            ? 'прогона; если к цели приложены изображения, добавляется блок с путями к ним.'
            : 'задачи; после возврата с ревью добавляется блок «Замечания после ревью».'}
        </div>
        <pre className="role-text short">{startTemplate(kind)}</pre>
      </section>
    </div>
  )
}
