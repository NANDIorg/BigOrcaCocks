import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  AGENT_TITLES, DEFAULT_ROLE_ID, DEFAULT_TASK_PRIORITY, isTaskPriority, isTaskRole, modelLabel,
  type AgentInfo, type Role, type Task, type TaskPriority
} from '@orca-board/core'
import { AgentLogo } from './AgentLogo'
import { PriorityOptions } from './Priority'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'

interface Props {
  /** Глобальная задача, куда попадёт подзадача, — для заголовка. */
  globalTitle?: string
  /** Кандидаты в зависимости: подзадачи той же глобальной задачи. */
  tasks: Task[]
  /** Роли типа глобальной задачи (`rolesForRun`); в выбор попадают только те, чей агент включён в проекте. */
  roles: Role[]
  /** Все агенты проекта — чтобы отсеять роли с выключенным агентом. */
  agents: AgentInfo[]
  onClose(): void
  /** Ошибка (reject) показывается в форме, введённое не теряется. */
  onCreate(input: { title: string; spec: string; deps: string[]; roleId: string; priority: TaskPriority; answerFor?: 'human' }): Promise<void>
}

export function NewTaskModal({ globalTitle, tasks, roles, agents, onClose, onCreate }: Props): React.JSX.Element {
  const t = useT()
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
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY)
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
      await onCreate({ title: title.trim(), spec, deps, roleId, priority, ...(answer ? { answerFor: 'human' as const } : {}) })
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('board.newTask.title')} onClick={(e) => e.stopPropagation()}>
        <h3>{t('board.newTask.title')}</h3>
        {globalTitle && <p className="muted modal-sub" title={globalTitle}>{t('board.newTask.in', { title: globalTitle })}</p>}
        <label>
          {t('board.newTask.name')}
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('board.newTask.namePlaceholder')} />
        </label>
        <label>
          {t('board.task.spec')}
          <textarea value={spec} onChange={(e) => setSpec(e.target.value)} placeholder={t('board.task.specPlaceholder')} />
        </label>
        <label>
          {t('board.task.role')}
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
          {noRoles && <span>{t('board.newTask.noRoles')}</span>}
        </label>
        <label>
          {t('board.task.priority')}
          <select value={priority} onChange={(e) => isTaskPriority(e.target.value) && setPriority(e.target.value)}>
            <PriorityOptions />
          </select>
        </label>
        <label>
          {t('board.task.result')}
          <select value={answer ? 'answer' : 'code'} onChange={(e) => setAnswer(e.target.value === 'answer')}>
            <option value="code">{t('board.newTask.resultCode')}</option>
            <option value="answer">{t('board.newTask.resultAnswer')}</option>
          </select>
        </label>
        {tasks.length > 0 && (
        <label>
          {t('board.newTask.deps')}
          <select
            multiple
            value={deps}
            onChange={(e) => setDeps([...e.target.selectedOptions].map((o) => o.value))}
          >
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>{task.title}</option>
            ))}
          </select>
        </label>
        )}
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>{t('board.cancel')}</button>
          <button
            className="btn-primary"
            disabled={!title.trim() || noRoles || busy}
            onClick={() => void create()}
          >
            {t('board.newTask.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
