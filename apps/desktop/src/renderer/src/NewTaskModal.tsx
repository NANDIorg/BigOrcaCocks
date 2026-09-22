import type React from 'react'
import { useState } from 'react'
import type { AgentKind, Task } from '@orca-board/core'

interface Props {
  tasks: Task[]
  onClose(): void
  onCreate(input: { title: string; spec: string; deps: string[]; agent: AgentKind }): void
}

export function NewTaskModal({ tasks, onClose, onCreate }: Props): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [deps, setDeps] = useState<string[]>([])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Новая задача</h3>
        <label>
          Название
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Спека (промпт для агента)
          <textarea value={spec} onChange={(e) => setSpec(e.target.value)} />
        </label>
        <label>
          Агент
          <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="opencode">opencode</option>
            <option value="shell">shell (без агента)</option>
          </select>
        </label>
        <label>
          Зависит от
          <select
            multiple
            value={deps}
            onChange={(e) => setDeps([...e.target.selectedOptions].map((o) => o.value))}
          >
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button onClick={onClose}>Отмена</button>
          <button
            className="primary"
            disabled={!title.trim()}
            onClick={() => onCreate({ title: title.trim(), spec, deps, agent })}
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}
