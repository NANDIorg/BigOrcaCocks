import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocFile, DocGroup } from '../../shared/ipc'
import { Markdown } from './Markdown'
import { Icon } from './icons'
import { ipcErrorMessage } from './useAutoSave'
import { docsApi, formatSize, isRecent, isStaleDocsError, matchesQuery, resolveDocLink, STALE_APP_MESSAGE } from './docLinks'

interface Selected {
  source: string
  path: string
}

const sameDoc = (a: Selected | null, b: Selected): boolean => a?.source === b.source && a.path === b.path

const docs = (): ReturnType<typeof docsApi> => docsApi(window.orca)

function errorMessage(e: unknown): string {
  const msg = ipcErrorMessage(e)
  return isStaleDocsError(msg) ? STALE_APP_MESSAGE : msg
}

const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * «Документы» (кнопка в rail): .md активного проекта и worktree его задач в работе (docs:list).
 * Слева — список с поиском, свежие сверху; справа — выбранный файл через Markdown.
 * Относительные ссылки на .md открываются здесь же, http(s) — во внешнем браузере.
 */
export function DocsModal({ onClose }: { onClose(): void }): React.JSX.Element {
  const [groups, setGroups] = useState<DocGroup[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await docs().list()
      setGroups(next)
      setListError(null)
      setNow(Date.now())
      // Ничего не выбрано — открываем самый свежий документ.
      setSelected((cur) => {
        if (cur) return cur
        const first = next
          .flatMap((g) => g.files.map((f) => ({ source: g.source, file: f })))
          .sort((a, b) => b.file.mtime - a.file.mtime)[0]
        return first ? { source: first.source, path: first.file.path } : null
      })
    } catch (e) {
      setListError(errorMessage(e))
    }
  }, [])

  const load = useCallback(async (doc: Selected): Promise<void> => {
    try {
      const text = await docs().read(doc.source, doc.path)
      setContent(text)
      setDocError(null)
    } catch (e) {
      setContent(null)
      setDocError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (selected) void load(selected)
    else setContent(null)
  }, [selected, load])

  // Вернулись в окно (агент мог дописать файлы) — список и открытый документ перечитываются.
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
      setSelected((cur) => (cur ? { ...cur } : cur))
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const visible = useMemo(
    () => (groups ?? []).map((g) => ({ ...g, files: g.files.filter((f) => matchesQuery(f, query)) })),
    [groups, query]
  )
  const total = (groups ?? []).reduce((n, g) => n + g.files.length, 0)
  const project = visible.find((g) => g.source === 'project')
  const taskGroups = visible.filter((g) => g.source !== 'project')
  const selectedGroup = groups?.find((g) => g.source === selected?.source)
  const selectedFile = selectedGroup?.files.find((f) => f.path === selected?.path)

  function onDocClick(e: React.MouseEvent): void {
    const link = (e.target as Element).closest('[data-doc-href]')
    if (!link || !selected) return
    e.preventDefault()
    const path = resolveDocLink(selected.path, link.getAttribute('data-doc-href') ?? '')
    if (path) setSelected({ source: selected.source, path })
    else setDocError(`ссылка ведёт за пределы проекта: ${link.getAttribute('data-doc-href')}`)
  }

  async function run(action: (source: string, path: string) => Promise<void>): Promise<void> {
    if (!selected) return
    try {
      await action(selected.source, selected.path)
    } catch (e) {
      setDocError(errorMessage(e))
    }
  }

  const fileItem = (source: string, f: DocFile): React.JSX.Element => {
    const doc = { source, path: f.path }
    const slash = f.path.lastIndexOf('/')
    return (
      <li key={f.path}>
        <button className={`docs-item ${sameDoc(selected, doc) ? 'active' : ''}`} onClick={() => setSelected(doc)} title={f.path}>
          <span className="docs-name">
            {f.path.slice(slash + 1)}
            {f.untracked ? <span className="chip docs-badge">новый</span> : isRecent(f, now) ? <span className="chip docs-badge">изменён</span> : null}
          </span>
          <span className="docs-sub">
            {slash > 0 && <span className="docs-dir">{f.path.slice(0, slash)}</span>}
            <span className="docs-meta">{fmtTime(f.mtime)} · {formatSize(f.size)}</span>
          </span>
        </button>
      </li>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal docs-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Документы">
        <div className="settings-head">
          <h3>Документы</h3>
          <button className="icon-btn task-modal-close" title="Обновить список" aria-label="Обновить список" onClick={() => void refresh()}>
            <Icon.refresh />
          </button>
          <button className="icon-btn task-modal-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon.close />
          </button>
        </div>
        <div className="docs">
          <nav className="docs-nav" aria-label="Markdown-файлы">
            <div className="docs-search">
              <Icon.search />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по имени или пути" />
            </div>
            <div className="docs-list">
              {listError && <div className="editor-error">{listError}</div>}
              {groups === null && !listError && <div className="muted docs-hint">Загрузка…</div>}
              {groups !== null && total === 0 && <div className="empty">В проекте пока нет .md-файлов</div>}
              {groups !== null && total > 0 && (
                <>
                  <div className="docs-group">Проект</div>
                  {project && project.files.length > 0 ? (
                    <ul>{project.files.map((f) => fileItem(project.source, f))}</ul>
                  ) : (
                    <div className="muted docs-hint">{query ? 'Ничего не найдено' : 'Нет .md-файлов'}</div>
                  )}
                  <div className="docs-group">Задачи в работе</div>
                  {taskGroups.every((g) => g.files.length === 0) && (
                    <div className="muted docs-hint">{query ? 'Ничего не найдено' : 'Задачи в работе не меняли .md'}</div>
                  )}
                  {taskGroups
                    .filter((g) => g.files.length > 0)
                    .map((g) => (
                      <div key={g.source} className="docs-task">
                        <div className="docs-task-title" title={g.branch}>{g.title}</div>
                        <ul>{g.files.map((f) => fileItem(g.source, f))}</ul>
                      </div>
                    ))}
                </>
              )}
            </div>
          </nav>
          <section className="docs-pane">
            {selected ? (
              <>
                <div className="docs-file-head">
                  <div className="docs-file-path">
                    <span className="docs-file-source">{selectedGroup?.title ?? ''}</span>
                    <code>{selected.path}</code>
                    {selectedFile && <span className="muted">{fmtTime(selectedFile.mtime)}</span>}
                  </div>
                  <button className="btn-sm" onClick={() => void run((source, path) => docs().open(source, path))} title="Открыть в приложении по умолчанию">
                    Открыть в системе
                  </button>
                  <button className="btn-sm" onClick={() => void run((source, path) => docs().reveal(source, path))}>Показать в папке</button>
                </div>
                {docError && <div className="editor-error docs-error">{docError}</div>}
                {content !== null && (
                  <div className="docs-body" onClick={onDocClick}>
                    <Markdown text={content} className="docs-markdown" />
                  </div>
                )}
              </>
            ) : (
              <div className="empty">Выберите файл слева</div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
