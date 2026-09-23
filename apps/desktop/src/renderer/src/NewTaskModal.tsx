import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { AGENT_TITLES, DEFAULT_ROLE_ID, isTaskRole, modelLabel, type AgentInfo, type Role, type Task } from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
import { ipcErrorMessage } from './useAutoSave'

interface Props {
  /** Глобальная задача, куда попадёт подзадача, — для заголовка. */
  globalTitle?: string
  /** Кандидаты в зависимости: подзадачи той же глобальной задачи. */
  tasks: Task[]
  /** Роли проекта; в выбор попадают только те, чей агент включён. */
  roles: Role[]
  /** Все агенты проекта — чтобы отсеять роли с выключенным агентом. */
  agents: AgentInfo[]
  onClose(): void
  /** Ошибка (reject) показывается в форме, введённое не теряется. */
  onCreate(input: { title: string; spec: string; deps: string[]; roleId: string; answerFor?: 'human' }): Promise<void>
}

export function NewTaskModal({ globalTitle, tasks, roles, agents, onClose, onCreate }: Props): React.JSX.Element {
  const enabledAgents = new Set(agents.filter((a) => a.enabled).map((a) => a.id))
  // Служебные роли (координатор, ассистент) задачам не назначаются.
  const available = roles.filter((r) => isTaskRole(r.id) && enabledAgents.has(r.agent))
  const noRoles = available.length === 0
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  // По умолчанию «Программист», если он есть и его агент включён, иначе первая доступная роль.
  const [roleId, setRoleId] = useState<string>(
    () => available.find((r) => r.id === DEFAULT_ROLE_ID)?.id ?? available[0]?.id ?? ''
  )
  const [deps, setDeps] = useState<string[]>([])
  /** Результат — ответ для человека («посмотри», «предложи»), а не изменения в коде. */
  const [answer, setAnswer] = useState(false)
  const selectedRole = available.find((r) => r.id === roleId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const create = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onCreate({ title: title.trim(), spec, deps, roleId, ...(answer ? { answerFor: 'human' as const } : {}) })
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Новая подзадача" onClick={(e) => e.stopPropagation()}>
        <h3>Новая подзадача</h3>
        {globalTitle && <p className="muted modal-sub" title={globalTitle}>в «{globalTitle}»</p>}
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
          Результат
          <select value={answer ? 'answer' : 'code'} onChange={(e) => setAnswer(e.target.value === 'answer')}>
            <option value="code">Изменения в коде — ревью и слияние ветки</option>
            <option value="answer">Ответ для меня — посмотреть, разобраться, предложить</option>
          </select>
        </label>
        {tasks.length > 0 && (
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
        )}
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>Отмена</button>
          <button
            className="btn-primary"
            disabled={!title.trim() || noRoles || busy}
            onClick={() => void create()}
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}
