import type React from 'react'
import { useState } from 'react'
import { AGENT_TITLES, DEFAULT_ROLE_ID, modelLabel, type AgentInfo, type Role, type Task } from '@orca-board/core'
import { AgentLogo } from './AgentLogo'

interface Props {
  tasks: Task[]
  /** Роли проекта; в выбор попадают только те, чей агент включён. */
  roles: Role[]
  /** Все агенты проекта — чтобы отсеять роли с выключенным агентом. */
  agents: AgentInfo[]
  onClose(): void
  onCreate(input: { title: string; spec: string; deps: string[]; roleId: string }): void
}

export function NewTaskModal({ tasks, roles, agents, onClose, onCreate }: Props): React.JSX.Element {
  const enabledAgents = new Set(agents.filter((a) => a.enabled).map((a) => a.id))
  const available = roles.filter((r) => enabledAgents.has(r.agent))
  const noRoles = available.length === 0
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  // По умолчанию «Программист», если он есть и его агент включён, иначе первая доступная роль.
  const [roleId, setRoleId] = useState<string>(
    () => available.find((r) => r.id === DEFAULT_ROLE_ID)?.id ?? available[0]?.id ?? ''
  )
  const [deps, setDeps] = useState<string[]>([])
  const selectedRole = available.find((r) => r.id === roleId)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Новая задача</h3>
        <label>
          Название
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что нужно сделать" />
        </label>
        <label>
          Задание для агента
          <textarea value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="Подробное описание, критерии готовности" />
        </label>
        <label>
          Роль
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {selectedRole && <AgentLogo agent={selectedRole.agent} size={20} />}
            <select
              value={roleId}
              disabled={noRoles}
              style={{ flex: 1, minWidth: 0 }}
              onChange={(e) => setRoleId(e.target.value)}
            >
              {available.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} · {AGENT_TITLES[r.agent]}{r.model ? ` (${modelLabel(agents.find((a) => a.id === r.agent), r.model)})` : ''}
                </option>
              ))}
            </select>
          </div>
          {noRoles && <span>Нет ролей с включённым агентом — настройте во вкладке „О проекте“</span>}
        </label>
        <label>
          Зависит от
          <select
            multiple
            value={deps}
            onChange={(e) => setDeps([...e.target.selectedOptions].map((o) => o.value))}
          >
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </label>
        <div className="row">
          <button className="btn-text" onClick={onClose}>Отмена</button>
          <button
            className="btn-primary"
            disabled={!title.trim() || noRoles}
            onClick={() => onCreate({ title: title.trim(), spec, deps, roleId })}
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}
