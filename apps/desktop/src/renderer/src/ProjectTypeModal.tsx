import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TaskType } from '@orca-board/core'
import type { TaskTypeDetection } from '../../shared/ipc'
import { ipcErrorMessage } from './useAutoSave'
import { useT } from './i18n'
import { builtinText } from './defaultTitles'

interface Props {
  detection: TaskTypeDetection
  types: TaskType[]
  /** Тип библиотеки по умолчанию — бейдж «по умолчанию». */
  defaultTypeId: string
  /** Предвыбор: угаданный по файлам тип или тип библиотеки по умолчанию. */
  selected: string
  onClose(): void
  /** Добавить проект с этим типом задач по умолчанию. Ошибка остаётся в модалке. */
  onSubmit(typeId: string): Promise<void>
}

/**
 * Тип задач по умолчанию для нового проекта (после выбора папки). Копии настроек нет: проект ссылается на тип
 * из библиотеки, а тип конкретной глобальной задачи выбирается при её создании.
 */
export function ProjectTypeModal({ detection, types, defaultTypeId, selected: initial, onClose, onSubmit }: Props): React.JSX.Element {
  const t = useT()
  const [selected, setSelected] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const detected = detection.reason ? types.find((type) => type.id === detection.typeId) : undefined

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
      <div className="modal project-type-modal" role="dialog" aria-modal="true" aria-label={t('config.projectType.title')} onClick={(e) => e.stopPropagation()}>
        <h3>{t('config.projectType.title')}</h3>
        <p className="muted modal-sub" title={detection.path}>{detection.path}</p>
        <span className="muted project-type-hint">
          {detected && detection.reason ? t('config.projectType.detected', { title: detected.title, reason: detection.reason }) : null}
          {t('config.projectType.hint')}
        </span>
        <div className="project-type-list" role="radiogroup" aria-label={t('config.projectType.listAria')}>
          {types.map((type) => (
            <button
              key={type.id}
              type="button"
              role="radio"
              aria-checked={type.id === selected}
              className={`project-type-card${type.id === selected ? ' selected' : ''}`}
              autoFocus={type.id === initial}
              disabled={busy}
              onClick={() => setSelected(type.id)}
              onDoubleClick={() => void submit(type.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submit(type.id)
                }
              }}
            >
              <span className="project-type-title">
                {builtinText(type.title)}
                {type.id === defaultTypeId && <span className="project-type-badge">{t('config.projectType.default')}</span>}
                {type.id === detected?.id && <span className="project-type-badge accent">{t('config.projectType.matches')}</span>}
              </span>
              {type.description && <span className="project-type-desc">{builtinText(type.description)}</span>}
            </button>
          ))}
        </div>
        {error && <span className="error-text">{error}</span>}
        <div className="row">
          <button className="btn-text" onClick={close} disabled={busy}>{t('config.projectType.cancel')}</button>
          <button className="btn-primary" disabled={busy || !selected} onClick={() => void submit()}>
            {busy ? t('config.projectType.adding') : t('config.projectType.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
