import type React from 'react'
import { useState } from 'react'
import type { AgentInfo, AgentKind, Task } from '@orca-board/core'

interface Props {
  tasks: Task[]
  /** Все агенты проекта; в выбор попадают только включённые. */
  agents: AgentInfo[]
  onClose(): void
  onCreate(input: { title: string; spec: string; deps: string[]; agent: AgentKind }): void
}

export function NewTaskModal({ tasks, agents, onClose, onCreate }: Props): React.JSX.Element {
  const enabled = agents.filter((a) => a.enabled)
  const noAgents = enabled.length === 0
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  // По умолчанию Claude Code, если он включён, иначе первый включённый агент.
  const [agent, setAgent] = useState<AgentKind>(
    () => enabled.find((a) => a.id === 'claude')?.id ?? enabled[0]?.id ?? 'claude'
  )
  const [deps, setDeps] = useState<string[]>([])

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
          Агент
          <select value={agent} disabled={noAgents} onChange={(e) => setAgent(e.target.value as AgentKind)}>
            {enabled.map((a) => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </select>
          {noAgents && <span>Нет включённых агентов — включите во вкладке „О проекте“</span>}
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
            disabled={!title.trim() || noAgents}
            onClick={() => onCreate({ title: title.trim(), spec, deps, agent })}
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}
