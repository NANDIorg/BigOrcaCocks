import type React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { useT } from './i18n'
import { formatPercent } from './i18n/format'
import { bannerView, isReleaseUrl, versionLabel, type UpdateAction } from './updateState'
import { updatesProblem, type UpdatesController } from './useUpdates'

/** «Что нового»: заметки релиза (markdown с GitHub) — только через Markdown.tsx, он санитизирует HTML. */
export function UpdateNotesModal({ version, notes, releaseUrl, onClose }: {
  version: string
  notes: string
  releaseUrl: string | null
  onClose(): void
}): React.JSX.Element {
  const t = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const title = t('shell.update.notes.title', { version: versionLabel(version) })
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal update-notes" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="update-notes-head">
          <h3>{title}</h3>
          <button className="icon-btn task-modal-close" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}>
            <Icon.close />
          </button>
        </div>
        <div className="update-notes-body">
          {notes.trim() ? <Markdown text={notes} /> : <p className="muted">{t('shell.update.notes.empty')}</p>}
        </div>
        {isReleaseUrl(releaseUrl) && (
          <div className="row">
            <a className="btn-sm" href={releaseUrl} target="_blank" rel="noreferrer">
              <Icon.external /> {t('shell.update.notes.open')}
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Плашка обновления внизу сайдбара: состояние берёт из `bannerView` (updateState.ts), здесь — только отрисовка и вызовы.
 * «Перезапустить и обновить» просто зовёт `install('now')`: при живых воркерах выбор «Сейчас / Когда агенты закончат / Отмена»
 * предлагает диалог main (`confirmInstall`), считая по своим воркерам, — второго вопроса в плашке нет.
 */
export function UpdateBanner({ updates }: { updates: UpdatesController }): React.JSX.Element | null {
  const t = useT()
  const [notesOpen, setNotesOpen] = useState(false)
  const { state } = updates
  const view = bannerView(state)

  const problem = updatesProblem(updates)
  if (!view) return problem ? <div className="update-banner error" role="alert"><div className="update-detail">{problem}</div></div> : null

  const releaseUrl = state?.releaseUrl ?? null

  function onAction(a: UpdateAction): void {
    switch (a) {
      case 'whatsNew': return setNotesOpen(true)
      case 'download': return updates.download()
      case 'retry': return updates.check()
      case 'cancelPending': return updates.cancelPending()
      case 'install': return updates.install('now')
      case 'openRelease': return
    }
  }

  const label: Record<UpdateAction, string> = {
    whatsNew: t('shell.update.whatsNew'),
    download: t('shell.update.download'),
    install: t('shell.update.restart'),
    retry: t('shell.update.retry'),
    openRelease: t('shell.update.download'),
    cancelPending: t('shell.update.cancel')
  }
  const primary = view.primary

  return (
    <div className={`update-banner ${view.kind}`} role="status" aria-label={t('shell.update.aria')}>
      <div className="update-title">
        {view.kind === 'error' ? <Icon.info /> : view.kind === 'downloading' || view.kind === 'installing' ? <span className="update-spin"><Icon.spinner /></span> : <Icon.download />}
        <span>{view.title}</span>
        {view.kind === 'downloading' && view.percent != null && <span className="update-percent">{formatPercent(view.percent)}</span>}
      </div>
      {view.kind === 'downloading' && (
        <div
          className={`update-progress ${view.percent == null ? 'indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent ?? undefined}
        >
          <div style={{ width: `${view.percent ?? 40}%` }} />
        </div>
      )}
      {view.detail && <div className="update-detail">{view.detail}</div>}
      {view.actions.length > 0 && (
        <div className="update-actions">
          {view.actions.map((a) =>
            a === 'openRelease' ? (
              isReleaseUrl(releaseUrl) && (
                <a key={a} className={`btn-sm ${a === primary ? 'primary' : ''}`} href={releaseUrl} target="_blank" rel="noreferrer">
                  {label[a]}
                </a>
              )
            ) : (
              <button key={a} type="button" className={`btn-sm ${a === primary ? 'primary' : ''}`} onClick={() => onAction(a)}>
                {label[a]}
              </button>
            )
          )}
        </div>
      )}
      {problem && <div className="update-detail update-problem">{problem}</div>}
      {notesOpen && state?.availableVersion && (
        <UpdateNotesModal
          version={state.availableVersion}
          notes={state.releaseNotes ?? ''}
          releaseUrl={releaseUrl}
          onClose={() => setNotesOpen(false)}
        />
      )}
    </div>
  )
}

const TOAST_MS = 10_000

/** Тост «Обновлено до X» после старта: main отдаёт версию один раз (`getJustUpdated`), поэтому запрос — один. */
export function UpdateToast(): React.JSX.Element | null {
  const t = useT()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    const api = window.orca.updates
    // Старый preload — тоста не будет, приложение не падает.
    if (typeof api?.getJustUpdated !== 'function') return
    api.getJustUpdated().then((v) => setVersion(v), () => undefined)
  }, [])

  useEffect(() => {
    if (!version) return
    const timer = window.setTimeout(() => setVersion(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [version])

  if (!version) return null
  return (
    <div className="toast" role="status">
      <Icon.done />
      <span>{t('shell.update.toast', { version: versionLabel(version) })}</span>
      <button type="button" className="icon-btn" title={t('shell.update.toastClose')} aria-label={t('shell.update.toastClose')} onClick={() => setVersion(null)}>
        <Icon.close />
      </button>
    </div>
  )
}
