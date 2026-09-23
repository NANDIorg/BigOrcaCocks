import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ProjectTemplate } from '@orca-board/core'
import type { TemplateDetection } from '../../shared/ipc'
import { ipcErrorMessage } from './useAutoSave'

interface Props {
  detection: TemplateDetection
  templates: ProjectTemplate[]
  defaultTemplateId: string
  /** Предвыбор: угаданный по файлам тип или шаблон по умолчанию. */
  selected: string
  onClose(): void
  /** Добавить проект с копией шаблона. Ошибка остаётся в модалке. */
  onSubmit(templateId: string): Promise<void>
}

/** «Тип проекта» после выбора папки: проект получит копию настроек выбранного шаблона. */
export function ProjectTypeModal({ detection, templates, defaultTemplateId, selected: initial, onClose, onSubmit }: Props): React.JSX.Element {
  const [selected, setSelected] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const detected = detection.reason ? templates.find((t) => t.id === detection.templateId) : undefined

  const close = (): void => {
    if (!busyRef.current) onClose()
  }

  const submit = async (id = selected): Promise<void> => {
    if (busyRef.current || !id) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onSubmit(id)
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
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

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal project-type-modal" role="dialog" aria-modal="true" aria-label="Тип проекта" onClick={(e) => e.stopPropagation()}>
        <h3>Тип проекта</h3>
        <p className="muted modal-sub" title={detection.path}>{detection.path}</p>
        <span className="muted project-type-hint">
          {detected
            ? <>Похоже на «{detected.title}»: {detection.reason}. </>
            : null}
          Проект получит копию ролей, колонок, воркфлоу и правил шаблона — потом их можно менять в «О проекте».
        </span>
        <div className="project-type-list" role="radiogroup" aria-label="Шаблон">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === selected}
              className={`project-type-card${t.id === selected ? ' selected' : ''}`}
              autoFocus={t.id === initial}
              disabled={busy}
              onClick={() => setSelected(t.id)}
              onDoubleClick={() => void submit(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submit(t.id)
                }
              }}
            >
              <span className="project-type-title">
                {t.title}
                {t.id === defaultTemplateId && <span className="project-type-badge">по умолчанию</span>}
                {t.id === detected?.id && <span className="project-type-badge accent">подходит</span>}
                {!t.builtin && <span className="project-type-badge">свой</span>}
              </span>
              {t.description && <span className="project-type-desc">{t.description}</span>}
            </button>
          ))}
        </div>
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>Отмена</button>
          <button className="btn-primary" disabled={busy || !selected} onClick={() => void submit()}>
            {busy ? 'Добавляю…' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>
  )
}
