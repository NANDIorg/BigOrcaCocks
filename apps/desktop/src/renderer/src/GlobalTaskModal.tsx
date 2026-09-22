import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BoardColumn, GlobalTask } from '@orca-board/core'
import { ipcErrorMessage } from './useAutoSave'

interface Props {
  /** Правка существующей; без неё — создание новой. */
  global?: GlobalTask
  /** Колонки проекта — выбор начального статуса при создании. */
  columns: BoardColumn[]
  onClose(): void
  onSave(input: { title: string; description: string; status?: string }): Promise<void>
}

/** Создание и правка глобальной задачи: название, описание и (при создании) колонка. */
export function GlobalTaskModal({ global, columns, onClose, onSave }: Props): React.JSX.Element {
  const [title, setTitle] = useState(global?.title ?? '')
  const [description, setDescription] = useState(global?.description ?? '')
  const [status, setStatus] = useState(() => columns.find((c) => c.kind === 'backlog')?.id ?? columns[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const editing = global !== undefined
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
      await onSave({ title: title.trim(), description: description.trim(), status: editing ? undefined : status })
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
