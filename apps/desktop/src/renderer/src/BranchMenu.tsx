import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectBranchInfo, ProjectBranchList } from '../../shared/ipc'
import { Icon } from './icons'
import { useT } from './i18n'
import type { BranchBadge } from './projectBranch'
import { aheadBehindLabel, filterBranches, firstPickable, gitErrorMessage, gitOutputText, projectGitApi, staleGitMessage, upstreamLine, remoteLocalName } from './projectGit'

/** Что сейчас выполняется: пока не ноль — кнопки и ветки заблокированы, чтобы не запустить две git-команды разом. */
type Op = 'load' | 'fetch' | 'pull' | 'checkout'

/** Итог последней операции под списком: успех (вывод git) или ошибка. */
interface Notice {
  kind: 'ok' | 'error'
  text: string
}

/**
 * Бейдж текущей git-ветки проекта, по клику — поповер: Fetch, Pull, поиск и список веток (локальные и удалённые),
 * выбор ветки — checkout корня. Состояние операции живёт в самом компоненте, а не в поповере: закрытое меню не
 * теряет идущий fetch/pull. После checkout и pull бейдж обновляется через `onBranchChanged`.
 */
export function BranchMenu({ projectId, badge, onBranchChanged }: {
  projectId: string
  badge: BranchBadge
  onBranchChanged(next?: ProjectBranchInfo): void
}): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ProjectBranchList | null>(null)
  const [op, setOp] = useState<Op | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  /** Проект сменился: запоздавший ответ не должен попасть в чужое состояние. */
  const epoch = useRef(0)

  useEffect(() => {
    epoch.current++
    setOpen(false)
    setList(null)
    setOp(null)
    setNotice(null)
    setQuery('')
  }, [projectId])

  async function loadList(): Promise<void> {
    const api = projectGitApi(window.orca)
    if (!api) {
      setNotice({ kind: 'error', text: staleGitMessage() })
      return
    }
    const my = epoch.current
    setOp((cur) => cur ?? 'load')
    try {
      const next = await api.branches(projectId)
      if (my === epoch.current) setList(next)
    } catch (e) {
      if (my === epoch.current) setNotice({ kind: 'error', text: gitErrorMessage(e) })
    } finally {
      if (my === epoch.current) setOp((cur) => (cur === 'load' ? null : cur))
    }
  }

  /** Общий каркас fetch/pull/checkout: блокировка, разбор итога и ошибки по коду, обновление списка и бейджа. */
  async function run(kind: Exclude<Op, 'load'>, action: () => Promise<{ text: string; branch: ProjectBranchInfo; close?: boolean }>, ctxBranch?: string): Promise<void> {
    const my = epoch.current
    let reload = true
    setOp(kind)
    setNotice(null)
    try {
      const res = await action()
      if (my !== epoch.current) return
      onBranchChanged(res.branch)
      if (res.close) {
        reload = false
        setOpen(false)
        setQuery('')
        setList(null)
      } else {
        setNotice({ kind: 'ok', text: res.text })
      }
    } catch (e) {
      if (my !== epoch.current) return
      setNotice({ kind: 'error', text: gitErrorMessage(e, { branch: ctxBranch }) })
    } finally {
      if (my === epoch.current) setOp(null)
    }
    if (reload && my === epoch.current) await loadList()
  }

  function fetchAll(): void {
    const api = projectGitApi(window.orca)
    if (!api) return setNotice({ kind: 'error', text: staleGitMessage() })
    void run('fetch', async () => {
      const r = await api.gitFetch(projectId)
      return { text: gitOutputText(r.output), branch: r.branch }
    })
  }

  function pull(): void {
    const api = projectGitApi(window.orca)
    if (!api) return setNotice({ kind: 'error', text: staleGitMessage() })
    void run('pull', async () => {
      const r = await api.gitPull(projectId)
      return { text: gitOutputText(r.output), branch: r.branch }
    }, list?.current.branch ?? undefined)
  }

  function checkout(name: string): void {
    const api = projectGitApi(window.orca)
    if (!api) return setNotice({ kind: 'error', text: staleGitMessage() })
    void run('checkout', async () => {
      const branch = await api.checkoutBranch(projectId, name)
      return { text: t('shell.branch.checkedOut', { name }), branch, close: true }
    }, remoteLocalName(name))
  }

  function toggle(): void {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setNotice(null)
    void loadList()
  }

  // Закрытие: клик мимо и Esc. Пока идёт операция, меню можно закрыть — состояние остаётся в компоненте.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    searchRef.current?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const view = useMemo(() => (list ? filterBranches(list, query) : null), [list, query])
  const busy = op !== null
  const diff = aheadBehindLabel(list?.upstream)

  return (
    <div className="branch-menu" ref={rootRef}>
      <button
        type="button"
        className={`branch-badge ${badge.detached ? 'detached' : ''} ${open ? 'open' : ''}`}
        title={`${badge.title}\n${t('shell.branch.menuHint')}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy}
        onClick={toggle}
      >
        <Icon.branch />
        <span className="branch-name">{badge.label}</span>
        {badge.mark && <span className="branch-mark">{badge.mark}</span>}
        {busy && op !== 'load' && <span className="branch-spin"><Icon.spinner /></span>}
      </button>
      {open && (
        <div className="branch-pop" role="dialog" aria-label={t('shell.branch.menuLabel')}>
          <div className="branch-pop-head">
            <div className="branch-upstream" title={list?.upstream?.name}>
              {list ? (list.isGitRepo ? upstreamLine(list.upstream) : t('shell.branch.notRepo')) : ' '}
            </div>
            <button type="button" className="btn-sm" disabled={busy || !list?.isGitRepo} title={t('shell.branch.fetchHint')} onClick={fetchAll}>
              {op === 'fetch' ? <span className="branch-spin"><Icon.spinner /></span> : <Icon.download />} {t('shell.branch.fetch')}
            </button>
            <button type="button" className="btn-sm" disabled={busy || !list?.isGitRepo} title={t('shell.branch.pullHint')} onClick={pull}>
              {op === 'pull' ? <span className="branch-spin"><Icon.spinner /></span> : <Icon.refresh />} {t('shell.branch.pull')}
              {diff && <span className="branch-diff">{diff}</span>}
            </button>
          </div>
          <input
            ref={searchRef}
            type="text"
            className="branch-search"
            value={query}
            placeholder={t('shell.branch.search')}
            aria-label={t('shell.branch.search')}
            disabled={!list?.isGitRepo}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || busy || !view) return
              const target = firstPickable(view)
              if (target) checkout(target)
            }}
          />
          {list?.dirty && <div className="branch-note">{t('shell.branch.dirty')}</div>}
          <div className="branch-list" role="listbox" aria-label={t('shell.branch.menuLabel')}>
            {!view && <div className="branch-empty">{op === 'load' ? t('shell.branch.loading') : ''}</div>}
            {view && view.local.length + view.remote.length === 0 && list?.isGitRepo && <div className="branch-empty">{t('shell.branch.empty')}</div>}
            {view && view.local.length > 0 && <div className="branch-group">{t('shell.branch.local')}</div>}
            {view?.local.map((b) => (
              <button
                key={b.name}
                type="button"
                role="option"
                aria-selected={b.current}
                className={`branch-item ${b.current ? 'current' : ''}`}
                disabled={busy || b.busy}
                title={b.busy ? t('shell.branch.busyHint') : b.name}
                onClick={() => (b.current ? setOpen(false) : checkout(b.name))}
              >
                <span className="branch-item-check">{b.current && <Icon.check />}</span>
                <span className="branch-item-name">{b.name}</span>
                {b.current && diff && <span className="branch-diff">{diff}</span>}
                {b.current && <span className="branch-item-mark">{t('shell.branch.currentMark')}</span>}
                {b.busy && <span className="branch-item-mark">{t('shell.branch.busyMark')}</span>}
              </button>
            ))}
            {view && view.remote.length > 0 && <div className="branch-group">{t('shell.branch.remote')}</div>}
            {view?.remote.map((name) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={false}
                className="branch-item"
                disabled={busy}
                title={t('shell.branch.remoteHint')}
                onClick={() => checkout(name)}
              >
                <span className="branch-item-check" />
                <span className="branch-item-name">{name}</span>
              </button>
            ))}
          </div>
          {op && op !== 'load' && op !== 'checkout' && <div className="branch-note">{t('shell.branch.running')}</div>}
          {notice && (
            <pre className={`branch-result ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</pre>
          )}
        </div>
      )}
    </div>
  )
}
