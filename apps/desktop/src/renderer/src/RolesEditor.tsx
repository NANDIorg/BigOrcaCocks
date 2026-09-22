import type React from 'react'
import { DEFAULT_ROLES, modelHints, type AgentInfo, type AgentKind, type Role } from '@orca-board/core'
import type { Project } from '../../shared/ipc'
import { AgentLogo } from './AgentLogo'
import { useAutoSave } from './useAutoSave'

interface Props {
  active: Project
  /** Все агенты проекта: в выбор попадают включённые, выключенный текущий — с пометкой. */
  agents: AgentInfo[]
  onSave(roles: Role[]): Promise<void>
}

/** Раздел «Роли» вкладки «О проекте»: название, агент, модель; сохраняется автоматически. */
export function RolesEditor({ active, agents, onSave }: Props): React.JSX.Element {
  const { draft: roles, error, update } = useAutoSave<Role[]>(active.id, active.roles ?? DEFAULT_ROLES, onSave)
  const enabled = agents.filter((a) => a.enabled)
  const canDelete = roles.length > 1

  function patch(i: number, p: Partial<Role>, debounce = false): void {
    update(roles.map((r, j) => (j === i ? { ...r, ...p } : r)), debounce)
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
        <div className="editor-head" />
        {roles.map((r, i) => {
          const current = agents.find((a) => a.id === r.agent)
          const currentOff = current !== undefined && !current.enabled
          const hints = modelHints(r.agent)
          const listId = `models-${active.id}-${r.id}`
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
                  onChange={(e) => patch(i, { agent: e.target.value as AgentKind })}
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
                  placeholder="по умолчанию"
                  list={hints.length ? listId : undefined}
                  onChange={(e) => patch(i, { model: e.target.value }, true)}
                />
                {hints.length > 0 && (
                  <datalist id={listId}>
                    {hints.map((m) => <option key={m} value={m} />)}
                  </datalist>
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
        Роль задаёт агента и модель. Координатор запускается ролью <code>coordinator</code>; в задачах роль
        выбирается при создании (для CLI — <code>--role &lt;id&gt;</code>).
      </p>
    </div>
  )
}
