import { getUiApi } from './host'
import type React from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { InitialCommitMode, ProjectBranchInfo } from '../shared/ipc'
import { useT } from './i18n'
import {
  defaultInitialCommitMode,
  initialCommitApi,
  initialCommitErrorMessage,
  loadInitialCommitInfo,
  retryHint,
  staleInitialCommitMessage,
  warnNoGitignore,
  type InitialCommitInfo
} from './initialCommit'

interface Props {
  projectId: string
  projectName: string
  /** Упавший запуск будет повторён после коммита (`onCommitted`); нет — окно открыто из меню веток. */
  willRetry: boolean
  onClose(): void
  /** Коммит создан: диалог закрывает вызывающий, он же повторяет упавший запуск. */
  onCommitted(branch: ProjectBranchInfo): void
}

/**
 * «В репозитории нет коммитов»: запуск координатора или воркера упал с `git.noCommits`. Коммит создаётся только по
 * кнопке человека — сами ничего не коммитим. Основная кнопка — по файлам корня (`defaultInitialCommitMode`).
 * Ошибка остаётся в окне, пока идёт операция — кнопки и Esc заблокированы.
 */
export function InitialCommitDialog({ projectId, projectName, willRetry, onClose, onCommitted }: Props): React.JSX.Element {
  const t = useT()
  const ids = useId()
  const [api] = useState(() => initialCommitApi(getUiApi()))
  const [info, setInfo] = useState<InitialCommitInfo | null>(null)
  const [busy, setBusy] = useState<InitialCommitMode | null>(null)
  const [error, setError] = useState<string | null>(api ? null : staleInitialCommitMessage())
  const busyRef = useRef(false)
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!api) return
    let alive = true
    void loadInitialCommitInfo(api, projectId).then((next) => {
      if (alive) setInfo(next)
    })
    return () => {
      alive = false
    }
  }, [api, projectId])

  // Фокус — на основную кнопку, как только стало ясно, какая она.
  useEffect(() => {
    if (info) primaryRef.current?.focus()
  }, [info])

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

  const commit = async (mode: InitialCommitMode): Promise<void> => {
    if (busyRef.current || !api) return
    busyRef.current = true
    setBusy(mode)
    setError(null)
    try {
      const branch = await api.createInitialCommit(projectId, mode)
      busyRef.current = false
      onCommitted(branch)
      return
    } catch (e) {
      setError(initialCommitErrorMessage(e))
    }
    busyRef.current = false
    setBusy(null)
  }

  const primary = info ? defaultInitialCommitMode(info) : 'snapshot'
  const disabled = busy !== null || !api || !info
  const text = info?.branch
    ? t('shell.initialCommit.text', { project: projectName, branch: info.branch })
    : t('shell.initialCommit.textNoBranch', { project: projectName })
  const retry = retryHint(willRetry)

  const option = (mode: InitialCommitMode, label: string, hint: React.ReactNode): React.JSX.Element => (
    <div className="initial-commit-option">
      <button
        ref={mode === primary ? primaryRef : undefined}
        type="button"
        className={mode === primary ? 'btn-primary' : 'btn-primary ghost'}
        disabled={disabled}
        aria-describedby={`${ids}-${mode}`}
        onClick={() => void commit(mode)}
      >
        {busy === mode ? t('shell.initialCommit.busy') : label}
      </button>
      <div id={`${ids}-${mode}`} className="muted initial-commit-hint">{hint}</div>
    </div>
  )

  const snapshot = option('snapshot', t('shell.initialCommit.snapshot'), (
    <>
      {t('shell.initialCommit.snapshotHint')}
      {info && warnNoGitignore(info) && <span className="initial-commit-warn">{t('shell.initialCommit.noGitignore')}</span>}
    </>
  ))
  const empty = option('empty', t('shell.initialCommit.empty'), t('shell.initialCommit.emptyHint'))

  return (
    <div className="modal-backdrop initial-commit-backdrop" onClick={close}>
      <div
        className="modal initial-commit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-text`}
        aria-busy={busy !== null || (api !== null && !info)}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={`${ids}-title`}>{t('shell.initialCommit.title')}</h3>
        <p id={`${ids}-text`} className="initial-commit-text">
          {text}{retry && <> <span className="muted">{retry}</span></>}
        </p>
        <div className="initial-commit-options">
          {primary === 'snapshot' ? <>{snapshot}{empty}</> : <>{empty}{snapshot}</>}
        </div>
        {error && <span className="error-text" role="alert">{error}</span>}
        <div className="row">
          <button type="button" className="btn-text" onClick={close} disabled={busy !== null} autoFocus={!api}>{t('shell.cancel')}</button>
        </div>
      </div>
    </div>
  )
}
