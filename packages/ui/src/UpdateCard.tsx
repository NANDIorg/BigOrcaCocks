import { getUiRelease } from './host'
import type React from 'react'
import { useId, useMemo, useState } from 'react'
import appLogo from '../assets/icon.svg'
import { Icon } from './icons'
import { Markdown } from './Markdown'
import { useT } from './i18n'
import { formatDateTime, formatPercent } from './i18n/format'
import { bannerView, cardRelease, cardStatus, isReleaseUrl, pendingText, releaseSummary, unsupportedText, updateProgress, versionLabel } from './updateState'
import type { UpdatesController } from './useUpdates'

/** Полная карточка версии в настройках. Заметки раскрываются здесь же, источник состояния — общий обновлятор. */
export function UpdateCard({ updates }: { updates: UpdatesController }): React.JSX.Element {
  const t = useT()
  const { state } = updates
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null)
  const notesId = useId()
  const release = cardRelease(state, getUiRelease(), state?.mode === 'server' || state?.unsupportedReason === 'server-unmanaged' ? 'web' : 'desktop')
  const notes = release?.releaseNotes ?? ''
  const summary = useMemo(() => releaseSummary(notes), [notes])
  const status = cardStatus(state, updates.checking)
  const found = Boolean(state?.availableVersion)
  const server = state?.mode === 'server'
  const manual = status === 'unsupported' && found && state?.mode === 'manual-download'
  const kind = manual ? 'available' : status
  const busy = kind === 'checking' || kind === 'downloading' || kind === 'installing' || kind === 'loading'
  const heading = t(`settings.updates.card.${kind}`)
  const version = release ? versionLabel(release.version) : '—'
  const percent = updateProgress(state?.percent ?? null)
  const expanded = Boolean(release && expandedVersion === release.version)
  const view = bannerView(state)
  const primary = kind === 'checking' || kind === 'loading' ? undefined : view?.primary
  const releaseUrl = release?.releaseUrl
  const detail = kind === 'ready'
    ? (pendingText(state?.installPending ?? null) ?? t(server ? 'shell.web.updateReady' : 'settings.updates.card.readyHint'))
    : kind === 'error'
      ? (state?.error ?? t('settings.updates.status.errorNoText'))
      : kind === 'unsupported' || manual
        ? unsupportedText(state?.unsupportedReason ?? null)
        : kind === 'idle'
          ? t(updates.lastCheckedAt ? 'settings.updates.card.upToDateHint' : 'settings.updates.card.idleHint')
          : kind === 'installing'
            ? t(server ? 'shell.web.updateInstalling' : 'settings.updates.card.installingHint')
            : kind === 'checking'
              ? t('settings.updates.status.checking')
              : ''

  return (
    <article className={`updates-card ${kind}`} aria-labelledby={`${notesId}-version`}>
      <div className="updates-card-head">
        <div className="updates-card-icon" aria-hidden="true"><img src={appLogo} alt="" width={52} height={52} /></div>
        <div className="updates-card-heading">
          <span className="updates-card-eyebrow" role="status">{busy && <span className="update-spin" aria-hidden="true"><Icon.spinner /></span>}{heading}</span>
          <h3 id={`${notesId}-version`}>{version}</h3>
        </div>
        {kind === 'available' || kind === 'ready' || kind === 'idle' ? (
          <span className="updates-card-badge"><span aria-hidden="true" />{t(`settings.updates.card.badge.${kind}`)}</span>
        ) : null}
      </div>

      {found && state && <p className="updates-card-from">{t('settings.updates.card.from', { version: versionLabel(state.currentVersion) })}</p>}
      {(summary || found) && <p className="updates-card-summary">{summary || t('settings.updates.card.noNotes')}</p>}
      {detail && <p className={`updates-card-detail ${kind === 'error' ? 'problem' : ''}`} role={kind === 'error' ? 'alert' : undefined}>{detail}</p>}

      {kind === 'downloading' && (
        <div className="updates-card-download">
          <div className="updates-card-progress-label"><span>{t('settings.updates.card.downloadLabel')}</span><b>{percent === null ? t('settings.updates.card.unknownSize') : formatPercent(percent)}</b></div>
          <div className={`update-progress ${percent === null ? 'indeterminate' : ''}`} role="progressbar"
            aria-label={t('settings.updates.card.downloadLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <div style={{ width: `${percent ?? 40}%` }} />
          </div>
          <p>{t(server ? 'shell.web.updateDownloading' : 'settings.updates.card.downloadHint')}</p>
        </div>
      )}

      {(release || primary) && (
        <div className="updates-card-actions">
          {release && <button type="button" className="updates-notes-toggle" aria-expanded={expanded} aria-controls={notesId}
            onClick={() => setExpandedVersion(expanded ? null : release.version)}>
            {expanded ? <Icon.up /> : <Icon.down />}{t(expanded ? 'settings.updates.card.collapse' : found ? 'settings.updates.card.expand' : 'settings.updates.card.currentNotes')}
          </button>}
          <div className="updates-card-buttons">
            {kind === 'ready' && state?.installPending && <button type="button" className="btn-sm" onClick={updates.cancelPending}>{t('shell.update.cancel')}</button>}
            {primary === 'openRelease' ? (
              isReleaseUrl(releaseUrl) && <a className="btn-sm primary" href={releaseUrl} target="_blank" rel="noreferrer"><Icon.external />{t('settings.updates.card.downloadExternal')}</a>
            ) : primary === 'download' ? (
              <button type="button" className="btn-sm primary" onClick={updates.download}><Icon.download />{t('shell.update.download')}</button>
            ) : primary === 'install' ? (
              <button type="button" className="btn-sm primary" onClick={() => updates.install('now')}><Icon.refresh />{t(server ? 'shell.web.updateInstall' : 'shell.update.restart')}</button>
            ) : primary === 'retry' ? (
              <button type="button" className="btn-sm primary" onClick={updates.check}><Icon.refresh />{t('shell.update.retry')}</button>
            ) : null}
          </div>
        </div>
      )}
      {release && <div className="updates-card-notes" id={notesId} hidden={!expanded}>
        {notes ? <Markdown text={notes} /> : <p className="updates-card-detail">{t('settings.updates.card.noNotes')}</p>}
        {isReleaseUrl(releaseUrl) && <a className="updates-release-link" href={releaseUrl} target="_blank" rel="noreferrer">{t('shell.update.notes.open')}<Icon.external /></a>}
      </div>}
      {updates.lastCheckedAt && <p className="updates-card-checked">{t('settings.updates.card.checked', { time: formatDateTime(updates.lastCheckedAt, { hour: '2-digit', minute: '2-digit' }) })}</p>}
    </article>
  )
}
