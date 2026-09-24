import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  AGENT_TITLES, PRIORITY_TITLES, isTaskPriority,
  type AgentInfo, type BoardColumn, type ColumnKind, type GlobalTask, type TaskPriority, type TaskType
} from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'
import { GlobalDuration } from './GlobalBoard'
import { GlobalReturns } from './GlobalOverview'
import { globalTaskActions } from './globalReview'
import { formatStamp } from './boardSort'
import { PriorityOptions } from './Priority'
import { STALE_PRIORITY_MESSAGE, taskPriorityOf } from './taskPriority'
import { rolesWithDisabledAgent } from './taskTypes'
import { typeChangeOptions } from './globalTypeChange'
import { StatusHistoryBlock } from './StatusHistoryBlock'

interface Props {
  /** Правка существующей; без неё — создание новой. */
  global?: GlobalTask
  /** Колонки проекта — выбор начального статуса при создании. */
  columns: BoardColumn[]
  /**
   * Типы задач, доступные проекту, — выбор типа при создании. Нет — старый main без типов: выбора нет,
   * задача создаётся как раньше (main подставит тип проекта по умолчанию).
   */
  types?: TaskType[]
  /** Предвыбранный тип — тип проекта по умолчанию. */
  defaultTypeId?: string
  /** Агенты активного проекта: предупреждение, если у роли выбранного типа агент выключен. */
  agents?: AgentInfo[]
  /**
   * Название типа правимой задачи. Пока задача не начата (`typeChangeOptions`) тип при правке — селект из `types`,
   * после — только бейдж.
   */
  typeTitle?: string
  /** main знает приоритет глобальных задач (`runsKnowPriority`); старый main его не сохранит — выбор не даём. */
  priorityEditable: boolean
  /** Вид колонки глобального канбана, где сейчас задача, и живой ли координатор — действия «Проверки». */
  statusKind?: ColumnKind
  live?: boolean
  /** «Подтвердить» на «Проверке». */
  onAccept?(): void
  /** «Вернуть в работу…» на «Проверке» — модалка с уточнением (эта закрывается). */
  onReturn?(): void
  onClose(): void
  /** priority — только если main его знает; при правке App отправляет его, только если он изменился. */
  onSave(input: { title: string; description: string; status?: string; priority?: TaskPriority; typeId?: string }): Promise<void>
}

/** Создание и правка глобальной задачи: название, описание, приоритет, тип (при правке — пока не начата) и колонка (при создании). */
export function GlobalTaskModal(props: Props): React.JSX.Element {
  const { global, columns, types, defaultTypeId, agents = [], typeTitle, priorityEditable, statusKind, live = false, onAccept, onReturn, onClose, onSave } = props
  const [title, setTitle] = useState(global?.title ?? '')
  const [description, setDescription] = useState(global?.description ?? '')
  // Новая — «обычный»; у карточки от старого main поля нет — тоже normal.
  const [priority, setPriority] = useState<TaskPriority>(() => taskPriorityOf(global ?? {}))
  const [status, setStatus] = useState(() => columns.find((c) => c.kind === 'backlog')?.id ?? columns[0]?.id ?? '')
  // Выбор человека; пока его нет (или типы догрузились позже) — тип проекта по умолчанию, иначе первый.
  const [pickedTypeId, setTypeId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const editing = global !== undefined
  const actions = global ? globalTaskActions(global, statusKind, live) : undefined
  const selectedType = editing ? undefined
    : types?.find((t) => t.id === pickedTypeId) ?? types?.find((t) => t.id === defaultTypeId) ?? types?.[0]
  // Правка: варианты смены типа, пока задача не начата; undefined — тип только бейджем.
  const editTypes = global ? typeChangeOptions(global, statusKind, types, typeTitle) : undefined
  const editTypeId = pickedTypeId ?? global?.typeId ?? defaultTypeId ?? editTypes?.[0]?.id
  const editType = editTypes ? types?.find((t) => t.id === editTypeId) : undefined
  const offAgentRoles = selectedType ? rolesWithDisabledAgent(selectedType, agents) : []
  // У «Входящих» название фиксированное и описания нет — правится только то, что задано явно.
  const canSave = !busy && (title.trim() !== '' || (!editing && description.trim() !== ''))

  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const save = async (): Promise<void> => {
    if (busyRef.current || !canSave) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onSave({
        title: title.trim(),
        description: description.trim(),
        status: editing ? undefined : status,
        ...(selectedType ? { typeId: selectedType.id } : {}),
        // Только явный выбор человека: у прогона без typeId подставленный по умолчанию тип не должен записаться сам.
        ...(editTypes && pickedTypeId !== null ? { typeId: pickedTypeId } : {}),
        ...(priorityEditable ? { priority } : {})
      })
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={editing ? 'Глобальная задача' : 'Новая глобальная задача'} onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? 'Глобальная задача' : 'Новая глобальная задача'}</h3>
        {global && !global.inbox && (
          <p className="muted modal-sub">
            Создана {formatStamp(global.createdAt)}
            {global.closedAt !== undefined && <> · закрыта {formatStamp(global.closedAt)}</>} · <GlobalDuration global={global} variant="line" />
          </p>
        )}
        {global && typeTitle && !editTypes && (
          <p className="muted modal-sub task-type-line">Тип задачи: <span className="task-type-badge">{typeTitle}</span></p>
        )}
        {global && <GlobalReturns global={global} />}
        {global && !global.inbox && (
          <details className="g-modal-history">
            <summary>История статуса{global.statusHistory ? ` (${global.statusHistory.length})` : ''}</summary>
            <StatusHistoryBlock history={global.statusHistory} columns={columns} status={global.status} />
          </details>
        )}
        {actions && (actions.accept || actions.returnToWork) && (
          <div className="g-modal-review">
            <span className="muted">На проверке</span>
            {actions.accept && onAccept && (
              <button type="button" className="btn-sm primary" disabled={busy} onClick={onAccept}>Подтвердить</button>
            )}
            {actions.returnToWork && onReturn && (
              <button type="button" className="btn-sm" disabled={busy} title="Написать, что доделать, и перезапустить координатора" onClick={onReturn}>
                Вернуть в работу…
              </button>
            )}
          </div>
        )}
        <label>
          Название
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
            placeholder="Например: экспорт отчётов в PDF"
          />
        </label>
        <label>
          Описание
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Цель, контекст и критерии готовности — по нему координатор разобьёт задачу на подзадачи"
          />
        </label>
        {!global?.inbox && (
          <label>
            Приоритет
            {priorityEditable ? (
              <select value={priority} onChange={(e) => isTaskPriority(e.target.value) && setPriority(e.target.value)}>
                <PriorityOptions />
              </select>
            ) : (
              // main старый: приоритет не сохранится — показываем текущий и просим перезапустить.
              <span className="muted" title={STALE_PRIORITY_MESSAGE}>{PRIORITY_TITLES[priority]} · перезапустите приложение, чтобы менять</span>
            )}
          </label>
        )}
        {!editing && types && types.length > 0 && (
          <label>
            Тип задачи
            <select value={selectedType?.id ?? ''} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>{t.title}{t.id === defaultTypeId ? ' (по умолчанию)' : ''}</option>
              ))}
            </select>
            <span className="muted task-type-hint">
              {selectedType?.description ? `${selectedType.description}. ` : ''}Тип задаёт роли, воркфлоу и правила агентов этой задачи; сменить его можно, пока задача не была «В работе».
            </span>
            {offAgentRoles.length > 0 && (
              <span className="task-type-warn" role="status">
                В проекте выключен агент у ролей: {offAgentRoles.map((r) => `${r.title} (${AGENT_TITLES[r.agent] ?? r.agent})`).join(', ')} —
                их подзадачи не запустятся. Включите агента в «О проекте → Агенты» или выберите другой тип.
              </span>
            )}
          </label>
        )}
        {editTypes && (
          <label>
            Тип задачи
            <select value={editTypeId ?? ''} onChange={(e) => setTypeId(e.target.value)}>
              {editTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.title}{t.id === defaultTypeId ? ' (по умолчанию)' : ''}</option>
              ))}
            </select>
            <span className="muted task-type-hint">
              {editType?.description ? `${editType.description}. ` : ''}Тип можно сменить, пока задача не была «В работе»: после запуска он фиксируется.
            </span>
            {editType && rolesWithDisabledAgent(editType, agents).length > 0 && (
              <span className="task-type-warn" role="status">
                В проекте выключен агент у ролей: {rolesWithDisabledAgent(editType, agents).map((r) => `${r.title} (${AGENT_TITLES[r.agent] ?? r.agent})`).join(', ')} —
                их подзадачи не запустятся. Включите агента в «О проекте → Агенты» или выберите другой тип.
              </span>
            )}
          </label>
        )}
        {!editing && (
          <label>
            Колонка
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          </label>
        )}
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>Отмена</button>
          <button className="btn-primary" disabled={!canSave} onClick={() => void save()}>
            {editing ? 'Сохранить' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  )
}
