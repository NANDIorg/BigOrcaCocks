import type React from 'react'
import { effortOptions, modelHints, type AgentInfo, type AgentKind, type Role } from '@orca-board/core'
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
  if (!next.effort) delete next.effort
  return next
}

/** Раздел «Роли» («О проекте» и дефолт для новых проектов): название, агент, модель, усилие; сохраняется автоматически. */
export function RolesEditor({ storageKey, roles: initial, agents, onSave }: Props): React.JSX.Element {
  const { draft: roles, error, update } = useAutoSave<Role[]>(storageKey, initial, onSave)
  const enabled = agents.filter((a) => a.enabled)
  const canDelete = roles.length > 1

  function patch(i: number, p: Partial<Role>, debounce = false): void {
    update(roles.map((r, j) => (j === i ? withPatch(r, p) : r)), debounce)
  }

  /** Смена агента: effort, которого нет у нового агента, сбрасывается. */
  function changeAgent(i: number, agent: AgentKind): void {
    const effort = roles[i].effort
    patch(i, { agent, effort: effort && effortOptions(agent).includes(effort) ? effort : undefined })
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
          const baseHints = modelHints(r.agent)
          // Модель из конфига агента (codex) — первой подсказкой, если её нет в списке.
          const hints =
            defaults?.model && !baseHints.some((h) => h.value === defaults.model)
              ? [{ value: defaults.model, label: 'по умолчанию' }, ...baseHints]
              : baseHints
          const efforts = effortOptions(r.agent)
          const listId = `models-${storageKey}-${r.id}`
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
                <input
                  value={r.model ?? ''}
                  placeholder={defaults?.model ? `по умолчанию: ${defaults.model}` : 'по умолчанию агента'}
                  list={hints.length ? listId : undefined}
                  onChange={(e) => patch(i, { model: e.target.value }, true)}
                />
                {hints.length > 0 && (
                  <datalist id={listId}>
                    {hints.map((m) => <option key={m.value} value={m.value} label={m.label} />)}
                  </datalist>
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
