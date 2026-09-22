import type React from 'react'
import {
  effortOptions,
  effortOptionsFor,
  modelLabel,
  modelOptions,
  type AgentInfo,
  type AgentKind,
  type Role
} from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
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

/** Роль с новыми полями; пустые model/effort не сохраняем вовсе (undefined — «по умолчанию у агента»). */
function withPatch(r: Role, p: Partial<Role>): Role {
  const next: Role = { ...r, ...p }
  if (!next.model) delete next.model
  if (!next.effort) delete next.effort
  return next
}

/** Уровни effort роли: по модели агента, если агент известен, иначе общий список из реестра. */
function effortsOf(info: AgentInfo | undefined, agent: string, model: string | undefined): readonly string[] {
  return info ? effortOptionsFor(info, model) : effortOptions(agent)
}

/** Раздел «Роли» («О проекте» и дефолт для новых проектов): название, агент, модель, усилие; сохраняется автоматически. */
export function RolesEditor({ storageKey, roles: initial, agents, onSave }: Props): React.JSX.Element {
  const { draft: roles, error, update } = useAutoSave<Role[]>(storageKey, initial, onSave)
  const enabled = agents.filter((a) => a.enabled)
  const canDelete = roles.length > 1

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
          return (
            <div key={r.id} className="editor-row">
              <div>
                <input
                  value={r.title}
                  placeholder="Название роли"
                  onChange={(e) => patch(i, { title: e.target.value }, true)}
                />
                <div className="editor-id">{r.id}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <AgentLogo agent={r.agent} size={18} />
                <select
                  value={r.agent}
                  className={currentOff ? 'off' : ''}
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
                  <select value={r.model ?? ''} onChange={(e) => changeModel(i, e.target.value)}>
                    <option value="">{defaultModel ? `по умолчанию: ${defaultModel}` : 'по умолчанию агента'}</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    {customModel && <option value={customModel}>{customModel} (нестандартная)</option>}
                  </select>
                ) : (
                  <input
                    value={r.model ?? ''}
                    placeholder={defaults?.model ? `по умолчанию: ${defaults.model}` : 'по умолчанию агента'}
                    onChange={(e) => changeModel(i, e.target.value, true)}
                  />
                )}
              </div>
              <div>
                {efforts.length > 0 ? (
                  <select value={r.effort ?? ''} onChange={(e) => patch(i, { effort: e.target.value })}>
                    <option value="">{defaults?.effort ? `по умолчанию: ${defaults.effort}` : 'по умолчанию'}</option>
                    {efforts.map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                    {r.effort && !efforts.includes(r.effort) && (
                      <option value={r.effort} disabled>{r.effort} (не поддерживается)</option>
                    )}
                  </select>
                ) : (
                  <select value="" disabled title="Агент не поддерживает выбор усилия">
                    <option value="">—</option>
                  </select>
                )}
              </div>
              <button
                className="btn-sm danger"
                disabled={!canDelete}
                title={canDelete ? 'Удалить роль' : 'Нельзя удалить последнюю роль'}
                onClick={() => update(roles.filter((_, j) => j !== i))}
              >
                Удалить
              </button>
            </div>
          )
        })}
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="editor-actions">
        <button className="btn-sm" onClick={add}>Добавить роль</button>
      </div>
      <p className="editor-hint">
        Роль задаёт агента, модель и усилие (уровень рассуждений). Координатор запускается ролью <code>coordinator</code>; в задачах роль
        выбирается при создании (для CLI — <code>--role &lt;id&gt;</code>).
      </p>
    </div>
  )
}
