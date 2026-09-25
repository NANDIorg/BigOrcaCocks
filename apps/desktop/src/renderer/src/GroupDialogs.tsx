import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'
import { ipcErrorMessage } from './ipcError'
import { normalizeGroupName } from './projectGroups'

/** Esc закрывает диалог, пока он не занят запросом; перехват в capture — раньше глобальных горячих клавиш. */
function useEscape(close: () => void): void {
  const ref = useRef(close)
  ref.current = close
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        ref.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

interface NameProps {
  /** Задан — переименование этой группы, нет — создание. */
  initialName?: string
  /** Создание вместе с переносом проекта: имя проекта для пояснения. */
  forProject?: string
  onClose(): void
  /** Ошибка (в том числе «перезапустите приложение») остаётся в диалоге. */
  onSubmit(name: string): Promise<void>
}

/** Имя новой или переименованной группы. Пустое имя не отправляется — main всё равно бросил бы `groupNameEmpty`. */
export function GroupNameModal({ initialName, forProject, onClose, onSubmit }: NameProps): React.JSX.Element {
  const t = useT()
  const renaming = initialName !== undefined
  const [name, setName] = useState(initialName ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const normalized = normalizeGroupName(name)
  const title = renaming ? t('shell.projects.groupDialog.renameTitle') : t('shell.projects.groupDialog.createTitle')

  const close = (): void => {
    if (!busyRef.current) onClose()
  }
  useEscape(close)

  const submit = async (): Promise<void> => {
    if (busyRef.current || normalized === undefined) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onSubmit(normalized)
    } catch (e) {
      setError(ipcErrorMessage(e))
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        className="modal group-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h3>{title}</h3>
        {forProject && <p className="muted modal-sub">{t('shell.projects.groupDialog.createFor', { name: forProject })}</p>}
        <label>
          {t('shell.projects.groupDialog.name')}
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder={t('shell.projects.groupDialog.placeholder')}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        {error && <span className="error-text" role="alert">{error}</span>}
        <div className="row">
          <button type="button" className="btn-text" onClick={close} disabled={busy}>{t('shell.cancel')}</button>
          <button type="submit" className="btn-primary" disabled={busy || normalized === undefined}>
            {renaming ? t('shell.projects.groupDialog.save') : t('shell.projects.groupDialog.create')}
          </button>
        </div>
      </form>
    </div>
  )
}

interface ConfirmProps {
  title: string
  text: string
  confirmLabel: string
  onClose(): void
  onConfirm(): Promise<void>
}

/** Подтверждение разрушающего действия внутри приложения (не `window.confirm`). Фокус — на «Отмена»: Enter ничего не удалит. */
export function ConfirmModal({ title, text, confirmLabel, onClose, onConfirm }: ConfirmProps): React.JSX.Element {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  const close = (): void => {
    if (!busyRef.current) onClose()
  }
  useEscape(close)

  const confirm = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      setError(ipcErrorMessage(e))
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal group-modal" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="muted modal-sub">{text}</p>
        {error && <span className="error-text" role="alert">{error}</span>}
        <div className="row">
          <button type="button" className="btn-text" autoFocus onClick={close} disabled={busy}>{t('shell.cancel')}</button>
          <button type="button" className="btn-primary danger" onClick={() => void confirm()} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
