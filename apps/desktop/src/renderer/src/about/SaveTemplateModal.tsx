import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Project, TemplatesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import { writableTemplates } from '../projectType'

/** Что сохранить: новый шаблон (без `id`) или перезапись пользовательского; `adopt` — сделать его типом проекта. */
export interface SaveTemplateRequest {
  id?: string
  title: string
  description?: string
  adopt: boolean
}

interface Props {
  project: Project
  state: TemplatesState
  onClose(): void
  /** Сохранить; ошибка main остаётся в модалке. */
  onSave(req: SaveTemplateRequest): Promise<void>
}

/**
 * «Сохранить как шаблон…» вместо прежнего «Сделать дефолтом»: настройки проекта — в новый пользовательский
 * шаблон или поверх существующего пользовательского. Встроенные только читаются, их в списке нет.
 */
export function SaveTemplateModal({ project, state, onClose, onSave }: Props): React.JSX.Element {
  const writable = writableTemplates(state)
  const own = writable.find((t) => t.id === project.templateId)
  const [target, setTarget] = useState<string>('')
  const overwrite = writable.find((t) => t.id === target)
  const [title, setTitle] = useState(project.name)
  const [description, setDescription] = useState('')
  const [adopt, setAdopt] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

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

  /** Перезапись берёт название и описание выбранного шаблона — их можно поправить. */
  function pick(id: string): void {
    setTarget(id)
    const t = writable.find((x) => x.id === id)
    setTitle(t ? t.title : project.name)
    setDescription(t?.description ?? '')
  }

  const canSave = !busy && title.trim() !== ''

  async function submit(): Promise<void> {
    if (busyRef.current || !canSave) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const desc = description.trim()
      await onSave({ ...(overwrite ? { id: overwrite.id } : {}), title: title.trim(), ...(desc ? { description: desc } : {}), adopt })
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Сохранить как шаблон" onClick={(e) => e.stopPropagation()}>
        <h3>Сохранить как шаблон</h3>
        <p className="muted modal-sub" title={project.name}>
          Агенты, роли, колонки, воркфлоу, разрешения и правила доски проекта «{project.name}»
        </p>
        <label>
          Куда
          <select value={target} onChange={(e) => pick(e.target.value)}>
            <option value="">Новый шаблон</option>
            {writable.map((t) => (
              <option key={t.id} value={t.id}>
                Перезаписать «{t.title}»{t.id === own?.id ? ' · тип проекта' : ''}
              </option>
            ))}
          </select>
        </label>
        {overwrite && (
          <span className="muted">
            Настройки шаблона «{overwrite.title}» заменятся целиком. Проекты, созданные из него, не изменятся — у них своя копия.
          </span>
        )}
        <label>
          Название
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Описание <span className="muted">(необязательно, одна строка в выборе типа)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="tpl-check">
          <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
          Сделать этот шаблон типом проекта
        </label>
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>Отмена</button>
          <button className="btn-primary" disabled={!canSave} onClick={() => void submit()}>
            {busy ? 'Сохраняю…' : overwrite ? 'Перезаписать' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
