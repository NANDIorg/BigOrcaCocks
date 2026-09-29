import type React from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectFileKind } from '../../shared/ipc'
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
  isOpenableDoc,
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

interface FileRowProps {
  path: string
  name: string
  kind: ProjectFileKind
  depth: number
  open: boolean
  active: boolean
  /** Строка — точка входа в дерево с клавиатуры (roving tabindex). */
  focusable: boolean
  /** Открывается в «Документах» двойным кликом. */
  openable: boolean
  /** Подсказка при наведении: путь, у симлинка — с пометкой. */
  title: string
  onSelect: (path: string, isDir: boolean) => void
  onOpen: (path: string) => void
}

/**
 * Строка записи. Только примитивы и стабильные колбэки в пропсах: на папке в тысячи записей клик или стрелка
 * перерисовывают две строки (старое и новое выделение), а не всё дерево.
 */
const FileRow = memo(function FileRow(p: FileRowProps): React.JSX.Element {
  const isDir = p.kind === 'dir'
  const Ico = isDir && p.open ? DocIcon.folderOpen : ICONS[fileIconKind(p.name, p.kind)]
  return (
    <div
      role="treeitem"
      aria-level={p.depth + 1}
      aria-selected={p.active}
      aria-expanded={isDir ? p.open : undefined}
      tabIndex={p.focusable ? 0 : -1}
      data-path={p.path}
      className={`docs-row files-row ${isDir ? 'dir' : 'file'} ${p.open ? 'open' : ''} ${p.active ? 'active' : ''}`}
      style={indent(p.depth)}
      title={p.title}
      onClick={() => p.onSelect(p.path, isDir)}
      onDoubleClick={p.openable ? () => p.onOpen(p.path) : undefined}
    >
      {isDir ? <DocIcon.chev /> : <span className="docs-spacer" />}
      <Ico />
      <span className="docs-nm">{p.name}</span>
    </div>
  )
})

/**
 * Вкладка проекта «Файлы»: ленивое дерево корня проекта, только чтение (docs/architecture.md → «Вкладка “Файлы”»).
 * Монтируется с `key={projectId}` — дерево не переезжает в чужой проект. Состояние и решения, что читать, — в
 * `fileTree.ts`; здесь — запросы `files:list`, фокус и localStorage.
 * `onOpenDoc` — открыть .md (путь от корня) в «Документах»; без него кнопки открытия нет.
 */
export function FilesView({
  projectId,
  name,
  root,
  onOpenDoc
}: {
  projectId: string
  name: string
  root: string
  onOpenDoc?: (path: string) => void
}): React.JSX.Element {
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
      // Enter на .md открывает его в «Документах», как двойной клик; пробел только выделяет.
      const entry = key === 'Enter' && state.selected ? findEntry(state, state.selected) : undefined
      if (entry && state.selected && canOpen(entry.name, entry.kind)) {
        onOpenDoc?.(state.selected)
        return
      }
      // Выделение берём из актуального состояния: клавиши могут прийти раньше перерисовки.
      setState((s) => (s.selected && findEntry(s, s.selected)?.kind === 'dir' ? toggleDir(s, s.selected) : s))
    }
  }

  const clickRow = useCallback((path: string, isDir: boolean): void => {
    setRevealError(null)
    setState((s) => {
      const next = s.selected === path ? s : { ...s, selected: path }
      return isDir ? toggleDir(next, path) : next
    })
  }, [])

  // Родитель может передавать новый `onOpenDoc` на каждой отрисовке — строкам нужен стабильный колбэк.
  const onOpenDocRef = useRef(onOpenDoc)
  onOpenDocRef.current = onOpenDoc
  const openDoc = useCallback((path: string): void => onOpenDocRef.current?.(path), [])

  async function reveal(path: string): Promise<void> {
    setRevealError(null)
    try {
      await filesApi(window.orca).reveal(projectId, path)
    } catch (e) {
      setRevealError(filesError(e, { path, root }).message)
    }
  }

  const canOpen = (entryName: string, kind: ProjectFileKind): boolean => !!onOpenDoc && isOpenableDoc(entryName, kind)

  const retry = (dir: string): void => setState((s) => retryDir(s, dir))

  const rootDir = state.dirs['']
  const rootError = rootDir?.error ?? null
  const selected = state.selected
  const selectedEntry = selected ? findEntry(state, selected) : undefined

  const row = (r: TreeRow): React.JSX.Element => {
    if (r.type === 'entry') {
      return (
        <FileRow
          key={r.path}
          path={r.path}
          name={r.name}
          kind={r.kind}
          depth={r.depth}
          open={r.open}
          active={selected === r.path}
          focusable={focusable === r.path}
          openable={canOpen(r.name, r.kind)}
          title={r.kind === 'symlink' ? `${r.path} — ${t('config.files.symlink')}` : r.path}
          onSelect={clickRow}
          onOpen={openDoc}
        />
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
      {/* Старый main/preload: выбирать нечего, над деревом уже просьба перезапустить приложение — панель не нужна. */}
      {!rootError?.stale && (
        <footer className="files-foot">
          {selected && selectedEntry ? (
            <>
              <code className="files-path" title={absolutePath(root, selected)}>{selected}</code>
              <CopyButton text={selected} label={t('config.files.copyPath')} title={t('config.files.absPath', { path: absolutePath(root, selected) })} />
              <button className="copy-btn" onClick={() => void reveal(selected)}>{t('config.files.reveal')}</button>
              {canOpen(selectedEntry.name, selectedEntry.kind) && (
                <button className="copy-btn" title={t('config.files.openDocHint')} onClick={() => onOpenDoc?.(selected)}>
                  {t('config.files.openDoc')}
                </button>
              )}
              {revealError && <span className="editor-error files-foot-err">{revealError}</span>}
            </>
          ) : (
            <span className="muted">{t('config.files.selectHint')}</span>
          )}
        </footer>
      )}
    </section>
  )
}
