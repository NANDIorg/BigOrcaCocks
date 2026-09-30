import type React from 'react'
import { useId, useMemo, useState } from 'react'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { useT } from './i18n'
import { formatDateTime, formatPercent } from './i18n/format'
import { bannerView, cardStatus, isReleaseUrl, pendingText, releaseSummary, unsupportedText, updateProgress, versionLabel } from './updateState'
import type { UpdatesController } from './useUpdates'

/** Полная карточка версии в настройках. Заметки раскрываются здесь же, источник состояния — общий обновлятор. */
export function UpdateCard({ updates }: { updates: UpdatesController }): React.JSX.Element {
  const t = useT()
  const { state } = updates
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null)
  const notesId = useId()
  const summary = useMemo(() => releaseSummary(state?.releaseNotes ?? null), [state?.releaseNotes])
  const status = cardStatus(state, updates.checking)
  const found = Boolean(state?.availableVersion)
  const manual = status === 'unsupported' && found && state?.mode === 'manual-download'
  const kind = manual ? 'available' : status
  const busy = kind === 'checking' || kind === 'downloading' || kind === 'installing' || kind === 'loading'
  const positive = kind === 'ready' || kind === 'idle'
  const StatusIcon = busy ? Icon.spinner : positive ? Icon.done : kind === 'error' || kind === 'unsupported' ? Icon.info : Icon.download
  const heading = t(`settings.updates.card.${kind}`)
  const version = state ? versionLabel(state.availableVersion ?? state.currentVersion) : '—'
  const percent = updateProgress(state?.percent ?? null)
  const notes = found ? state?.releaseNotes?.trim() : ''
  const expanded = Boolean(found && expandedVersion === state?.availableVersion)
  const view = bannerView(state)
  const primary = kind === 'checking' || kind === 'loading' ? undefined : view?.primary
  const releaseUrl = state?.releaseUrl
  const detail = kind === 'ready'
    ? (pendingText(state?.installPending ?? null) ?? t('settings.updates.card.readyHint'))
    : kind === 'error'
      ? (state?.error ?? t('settings.updates.status.errorNoText'))
      : kind === 'unsupported' || manual
        ? unsupportedText(state?.unsupportedReason ?? null)
        : kind === 'idle'
          ? t(updates.lastCheckedAt ? 'settings.updates.card.upToDateHint' : 'settings.updates.card.idleHint')
          : kind === 'installing'
            ? t('settings.updates.card.installingHint')
            : kind === 'checking'
              ? t('settings.updates.status.checking')
              : ''

  return (
    <article className={`updates-card ${kind}`} aria-labelledby={`${notesId}-version`}>
      <div className="updates-card-head">
        <div className={`updates-card-icon ${busy ? 'busy' : ''}`} aria-hidden="true"><StatusIcon /></div>
        <div className="updates-card-heading">
          <span className="updates-card-eyebrow" role="status">{heading}</span>
          <h3 id={`${notesId}-version`}>{version}</h3>
        </div>
        {kind === 'available' || kind === 'ready' || kind === 'idle' ? (
          <span className="updates-card-badge"><span aria-hidden="true" />{t(`settings.updates.card.badge.${kind}`)}</span>
        ) : null}
      </div>

      {found && state && <p className="updates-card-from">{t('settings.updates.card.from', { version: versionLabel(state.currentVersion) })}</p>}
      {found && <p className="updates-card-summary">{summary || t('settings.updates.card.noNotes')}</p>}
      {detail && <p className={`updates-card-detail ${kind === 'error' ? 'problem' : ''}`} role={kind === 'error' ? 'alert' : undefined}>{detail}</p>}

      {kind === 'downloading' && (
        <div className="updates-card-download">
          <div className="updates-card-progress-label"><span>{t('settings.updates.card.downloadLabel')}</span><b>{percent === null ? t('settings.updates.card.unknownSize') : formatPercent(percent)}</b></div>
          <div className={`update-progress ${percent === null ? 'indeterminate' : ''}`} role="progressbar"
            aria-label={t('settings.updates.card.downloadLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <div style={{ width: `${percent ?? 40}%` }} />
          </div>
          <p>{t('settings.updates.card.downloadHint')}</p>
        </div>
      )}

      {(notes || primary) && (
        <div className="updates-card-actions">
          {notes && <button type="button" className="updates-notes-toggle" aria-expanded={expanded} aria-controls={notesId}
            onClick={() => setExpandedVersion(expanded ? null : state?.availableVersion ?? null)}>
            {expanded ? <Icon.up /> : <Icon.down />}{t(expanded ? 'settings.updates.card.collapse' : 'settings.updates.card.expand')}
          </button>}
          <div className="updates-card-buttons">
            {kind === 'ready' && state?.installPending && <button type="button" className="btn-sm" onClick={updates.cancelPending}>{t('shell.update.cancel')}</button>}
            {primary === 'openRelease' ? (
              isReleaseUrl(releaseUrl) && <a className="btn-sm primary" href={releaseUrl} target="_blank" rel="noreferrer"><Icon.external />{t('settings.updates.card.downloadExternal')}</a>
            ) : primary === 'download' ? (
              <button type="button" className="btn-sm primary" onClick={updates.download}><Icon.download />{t('shell.update.download')}</button>
            ) : primary === 'install' ? (
              <button type="button" className="btn-sm primary" onClick={() => updates.install('now')}><Icon.refresh />{t('shell.update.restart')}</button>
            ) : primary === 'retry' ? (
              <button type="button" className="btn-sm primary" onClick={updates.check}><Icon.refresh />{t('shell.update.retry')}</button>
            ) : null}
          </div>
        </div>
      )}
      {notes && <div className="updates-card-notes" id={notesId} hidden={!expanded}>
        <Markdown text={notes} />
        {isReleaseUrl(releaseUrl) && <a className="updates-release-link" href={releaseUrl} target="_blank" rel="noreferrer">{t('shell.update.notes.open')}<Icon.external /></a>}
      </div>}
      {updates.lastCheckedAt && <p className="updates-card-checked">{t('settings.updates.card.checked', { time: formatDateTime(updates.lastCheckedAt, { hour: '2-digit', minute: '2-digit' }) })}</p>}
    </article>
  )
}
