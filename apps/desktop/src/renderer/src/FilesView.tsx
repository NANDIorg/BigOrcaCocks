import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CopyButton } from './about/parts'
import { DocIcon } from './docsIcons'
import {
  absolutePath,
  applyError,
  applyListing,
  fileIconKind,
  findEntry,
  focusRefreshDue,
  initialTree,
  isTreeKey,
  markLoading,
  navigate,
  pendingLoads,
  readOpen,
  refreshAll,
  retryDir,
  toggleDir,
  visibleRows,
  writeOpen,
  type FileIconKind,
  type FileTreeState,
  type TreeRow
} from './fileTree'
import { useT } from './i18n'
import { filesApi, filesError } from './projectFiles'

/** localStorage может бросить при доступе (запрет, песочница) — тогда вкладка работает без него. */
function safeStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const ICONS: Record<FileIconKind, () => React.JSX.Element> = {
  folder: DocIcon.folder,
  doc: DocIcon.doc,
  image: DocIcon.image,
  link: DocIcon.link,
  file: DocIcon.file
}

/** Отступ строки, как в DocsTree; служебные строки («Загрузка…», пусто) — вровень с именами, после шеврона. */
const indent = (depth: number, extra = 0): React.CSSProperties => ({ paddingLeft: 8 + depth * 16 + extra })
const NOTE = 20

/**
 * Вкладка проекта «Файлы»: ленивое дерево корня проекта, только чтение (docs/architecture.md → «Вкладка “Файлы”»).
 * Монтируется с `key={projectId}` — дерево не переезжает в чужой проект. Состояние и решения, что читать, — в
 * `fileTree.ts`; здесь — запросы `files:list`, фокус и localStorage.
 */
export function FilesView({ projectId, name, root }: { projectId: string; name: string; root: string }): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<FileTreeState>(() => initialTree(projectId, readOpen(safeStorage(), projectId)))
  const [revealError, setRevealError] = useState<string | null>(null)
  const reqSeq = useRef(0)
  const lastRefresh = useRef(0)
  const treeRef = useRef<HTMLDivElement>(null)

  // Все чтения идут отсюда: раскрытие, «Повторить», «Обновить» и восстановление только меняют состояние.
  useEffect(() => {
    const loads = pendingLoads(state).map((path) => ({ path, req: ++reqSeq.current }))
    if (loads.length === 0) return
    setState((s) => markLoading(s, loads))
    for (const { path, req } of loads) {
      void (async () => {
        try {
          const listing = await filesApi(window.orca).list(projectId, path)
          setState((s) => applyListing(s, projectId, path, req, listing))
        } catch (e) {
          const error = filesError(e, { path: path || '/', root })
          setState((s) => applyError(s, projectId, path, req, error))
        }
      })()
    }
  }, [state, projectId, root])

  useEffect(() => {
    writeOpen(safeStorage(), projectId, state.open)
  }, [projectId, state.open])

  const refresh = useCallback(() => {
    lastRefresh.current = Date.now()
    setRevealError(null)
    setState(refreshAll)
  }, [])

  // Диск за приложением не следим: вернулись в окно — перечитываем, но не чаще раза в `FOCUS_REFRESH_MS`.
  useEffect(() => {
    lastRefresh.current = Date.now()
    const onFocus = (): void => {
      if (focusRefreshDue(lastRefresh.current, Date.now())) refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const rows = useMemo(() => visibleRows(state), [state])
  const firstEntry = rows.find((r) => r.type === 'entry')
  const focusable = state.selected ?? (firstEntry?.type === 'entry' ? firstEntry.path : null)

  // Фокус идёт за выделением (roving tabindex), но только если он уже в дереве — «Обновить» его не крадёт.
  useEffect(() => {
    const tree = treeRef.current
    if (!tree || !state.selected || !tree.contains(document.activeElement)) return
    const el = tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(state.selected)}"]`)
    if (el && el !== document.activeElement) el.focus()
    el?.scrollIntoView({ block: 'nearest' })
  }, [state.selected])

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.target instanceof HTMLButtonElement) return
    const key = e.key
    if (isTreeKey(key)) {
      e.preventDefault()
      setState((s) => navigate(s, key))
    } else if (key === 'Enter' || key === ' ') {
      e.preventDefault()
      // Выделение берём из актуального состояния: клавиши могут прийти раньше перерисовки.
      setState((s) => (s.selected && findEntry(s, s.selected)?.kind === 'dir' ? toggleDir(s, s.selected) : s))
    }
  }

  function clickRow(path: string, isDir: boolean): void {
    setRevealError(null)
    setState((s) => {
      const next = s.selected === path ? s : { ...s, selected: path }
      return isDir ? toggleDir(next, path) : next
    })
  }

  async function reveal(path: string): Promise<void> {
    setRevealError(null)
    try {
      await filesApi(window.orca).reveal(projectId, path)
    } catch (e) {
      setRevealError(filesError(e, { path, root }).message)
    }
  }

  const retry = (dir: string): void => setState((s) => retryDir(s, dir))

  const rootDir = state.dirs['']
  const rootError = rootDir?.error ?? null
  const selected = state.selected
  const selectedEntry = selected ? findEntry(state, selected) : undefined

  const row = (r: TreeRow): React.JSX.Element => {
    if (r.type === 'entry') {
      const isDir = r.kind === 'dir'
      const Ico = r.kind === 'dir' && r.open ? DocIcon.folderOpen : ICONS[fileIconKind(r.name, r.kind)]
      return (
        <div
          key={r.path}
          role="treeitem"
          aria-level={r.depth + 1}
          aria-selected={selected === r.path}
          aria-expanded={isDir ? r.open : undefined}
          tabIndex={focusable === r.path ? 0 : -1}
          data-path={r.path}
          className={`docs-row files-row ${isDir ? 'dir' : 'file'} ${r.open ? 'open' : ''} ${selected === r.path ? 'active' : ''}`}
          style={indent(r.depth)}
          title={r.kind === 'symlink' ? `${r.path} — ${t('config.files.symlink')}` : r.path}
          onClick={() => clickRow(r.path, isDir)}
        >
          {isDir ? <DocIcon.chev /> : <span className="docs-spacer" />}
          <Ico />
          <span className="docs-nm">{r.name}</span>
        </div>
      )
    }
    const key = `${r.type}:${r.dir}`
    if (r.type === 'loading') return <div key={key} role="none" className="muted files-note" style={indent(r.depth, NOTE)}>{t('common.loading')}</div>
    if (r.type === 'empty') return <div key={key} role="none" className="muted files-note" style={indent(r.depth, NOTE)}>{t('config.files.empty')}</div>
    if (r.type === 'truncated') return <div key={key} role="none" className="muted files-note" style={indent(r.depth, NOTE)}>{t('config.files.truncated', { count: r.count })}</div>
    return (
      <div key={key} role="none" className="files-note files-note-err" style={indent(r.depth, NOTE)}>
        <span className="editor-error">{r.error.message}</span>
        {!r.error.stale && <button className="btn-sm" onClick={() => retry(r.dir)}>{t('config.files.retry')}</button>}
      </div>
    )
  }

  return (
    <section className="files-page" aria-label={t('config.files.aria')}>
      <header className="files-head">
        <DocIcon.folder />
        <h3>{t('config.files.title')}</h3>
        <span className="files-proj">{name}</span>
        <code className="files-root" title={`${t('config.files.rootHint')}: ${root}`}><bdi>{root}</bdi></code>
        <span className="docs-grow" />
        <button className="icon-btn files-refresh" title={t('config.files.refresh')} aria-label={t('config.files.refresh')} onClick={refresh}>
          <DocIcon.refresh />
        </button>
      </header>
      <div className="files-body">
        {rootError ? (
          <div className="files-banner">
            <span className="editor-error">{rootError.message}</span>
            {!rootError.stale && <button className="btn-sm" onClick={() => retry('')}>{t('config.files.retry')}</button>}
          </div>
        ) : (
          <div ref={treeRef} className="files-tree" role="tree" aria-label={t('config.files.aria')} onKeyDown={onKeyDown}>
            {rows.map(row)}
          </div>
        )}
      </div>
      <footer className="files-foot">
        {selected && selectedEntry ? (
          <>
            <code className="files-path" title={absolutePath(root, selected)}>{selected}</code>
            <CopyButton text={selected} label={t('config.files.copyPath')} title={t('config.files.absPath', { path: absolutePath(root, selected) })} />
            <button className="copy-btn" onClick={() => void reveal(selected)}>{t('config.files.reveal')}</button>
            {revealError && <span className="editor-error files-foot-err">{revealError}</span>}
          </>
        ) : (
          <span className="muted">{t('config.files.selectHint')}</span>
        )}
      </footer>
    </section>
  )
}
