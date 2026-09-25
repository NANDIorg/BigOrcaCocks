import type React from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BoardColumn, Task } from '@orca-board/core'
import type { DocGroup } from '../../shared/ipc'
import { Markdown } from './Markdown'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'
import { docLinkHash, docsApi, isStaleDocsError, resolveDocLink, staleAppMessage } from './docLinks'
import { alsoIn, buildTree, dirAncestors, excerpt, sameDoc, type DocRef, type TaskMark } from './docTree'
import { clearMatches, findInDoc, paintMatches, scrollToRange, type TextMatch } from './docFind'
import { buildDocToc, findDocHeading } from './docToc'
import { DocsTree, dirKey, TaskDot, type TreeMode } from './DocsTree'
import { DocsToc } from './DocsToc'
import { DocsBlank, DocsStart, taskCards } from './DocsStart'
import { DocIcon } from './docsIcons'
import { useT } from './i18n'

/** Запись истории переходов: документ и где он был прокручен, когда с него ушли. */
interface Entry extends DocRef {
  scroll: number
}

interface DocError {
  title: string
  detail?: string
}

interface Find {
  open: boolean
  query: string
  index: number
}

const docs = (): ReturnType<typeof docsApi> => docsApi(window.orca)

function errorMessage(e: unknown): string {
  const msg = ipcErrorMessage(e)
  return isStaleDocsError(msg) ? staleAppMessage() : msg
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const MODE_KEY = 'orca.docs.mode'
const TOC_KEY = 'orca.docs.toc'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage недоступен — настройка просто не переживёт перезапуск
  }
}

export interface DocsModalProps {
  projectName: string
  tasks: Task[]
  columns: BoardColumn[]
  onClose(): void
}

/**
 * «Документы» (кнопка в rail), раскладка «Проводник» (docs/mockups/docs-viewer/concept-a.html):
 * дерево .md проекта и worktree задач в работе | документ с историей и поиском | оглавление.
 * Относительные ссылки на .md открываются здесь же, http(s) — во внешнем браузере.
 */
export function DocsModal({ projectName, tasks, columns, onClose }: DocsModalProps): React.JSX.Element {
  const t = useT()
  const [groups, setGroups] = useState<DocGroup[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [hist, setHist] = useState<{ stack: Entry[]; index: number }>({ stack: [], index: -1 })
  const [content, setContent] = useState<string | null>(null)
  /** Растёт с каждым переходом: пересчитать оглавление и прокрутку, даже если текст тот же. */
  const [rev, setRev] = useState(0)
  const [docError, setDocError] = useState<DocError | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setModeState] = useState<TreeMode>(() => (stored(MODE_KEY) === 'recent' ? 'recent' : 'tree'))
  const [showToc, setShowToc] = useState(() => stored(TOC_KEY) !== '0')
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [spy, setSpy] = useState<{ active: string | null; progress: number }>({ active: null, progress: 0 })
  const [find, setFind] = useState<Find>({ open: false, query: '', index: 0 })
  const [findMatches, setFindMatches] = useState<TextMatch[]>([])
  const [textHits, setTextHits] = useState<TextMatch[]>([])
  const [excerpts, setExcerpts] = useState<Map<string, string>>(new Map())

  const searchRef = useRef<HTMLInputElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)
  const navSeq = useRef(0)
  const pendingScroll = useRef<{ hash?: string; top: number } | null>(null)
  const dirsInited = useRef(false)
  const spyFrame = useRef(0)
  const revealTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const current: Entry | null = hist.stack[hist.index] ?? null
  const currentGroup = groups?.find((g) => g.source === current?.source)
  const currentFile = currentGroup?.files.find((f) => f.path === current?.path)
  const total = (groups ?? []).reduce((n, g) => n + g.files.length, 0)
  // Оглавление — из исходника: те же id, что у заголовков в <Markdown variant="doc">.
  const toc = useMemo(() => (content === null ? [] : buildDocToc(content)), [content])

  const marks = useMemo(() => {
    const byId = new Map(columns.map((c) => [c.id, c]))
    const out = new Map<string, TaskMark>()
    for (const task of tasks) {
      const col = byId.get(task.status)
      if (col) out.set(task.id, { color: col.color, status: col.title })
    }
    return out
  }, [tasks, columns])

  const setMode = (m: TreeMode): void => {
    setModeState(m)
    store(MODE_KEY, m)
  }

  const openAncestors = useCallback((doc: DocRef, withSelf?: string): void => {
    if (doc.source !== 'project') return
    const keys = [...dirAncestors(doc.path), ...(withSelf ? [withSelf] : [])].map((d) => dirKey('project', d))
    setOpenDirs((cur) => (keys.every((k) => cur.has(k)) ? cur : new Set([...cur, ...keys])))
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await docs().list()
      setGroups(next)
      setListError(null)
      setNow(Date.now())
      // Первая загрузка — раскрыты папки верхнего уровня.
      if (!dirsInited.current) {
        dirsInited.current = true
        const project = next.find((g) => g.source === 'project')
        const top = buildTree(project?.files ?? []).flatMap((n) => (n.kind === 'dir' ? [dirKey('project', n.path)] : []))
        setOpenDirs((cur) => new Set([...cur, ...top]))
      }
    } catch (e) {
      setListError(errorMessage(e))
    }
  }, [])

  /**
   * Открыть документ: сначала читаем, и только если прочитался — переходим. Битая ссылка
   * оставляет открытым прежний документ и показывает ошибку сверху.
   * `move` — шаг по истории (‹ ›) вместо новой записи.
   */
  async function go(doc: DocRef, opts: { hash?: string; link?: string; move?: number } = {}): Promise<void> {
    if (!opts.move && sameDoc(current, doc)) {
      setDocError(null)
      if (opts.hash) jumpTo(opts.hash)
      return
    }
    const seq = ++navSeq.current
    let text: string
    try {
      text = await docs().read(doc.source, doc.path)
    } catch (e) {
      if (seq !== navSeq.current) return
      const msg = errorMessage(e)
      // Файла нет: main с переводом присылает код docs.notFound, main до перевода — только русский текст.
      if (opts.link && current && (ipcErrorCode(e) === 'docs.notFound' || /не найден/i.test(msg))) {
        setDocError({
          title: t('config.docs.err.notFound', { path: doc.path }),
          detail: `${t('config.docs.err.deletedLink', { name: nameOf(current.path) })} ${t('config.docs.err.stay')}`
        })
      } else setDocError({ title: msg, detail: current ? t('config.docs.err.stay') : undefined })
      return
    }
    if (seq !== navSeq.current) return
    const leaving = bodyRef.current?.scrollTop ?? 0
    const target = opts.move ? hist.stack[hist.index + opts.move] : undefined
    setHist((h) => {
      const stack = h.stack.map((e, i) => (i === h.index ? { ...e, scroll: leaving } : e))
      if (opts.move) return { stack, index: h.index + opts.move }
      return { stack: [...stack.slice(0, h.index + 1), { ...doc, scroll: 0 }], index: h.index + 1 }
    })
    pendingScroll.current = { hash: opts.hash, top: target?.scroll ?? 0 }
    setContent(text)
    setRev((r) => r + 1)
    setDocError(null)
    openAncestors(doc)
  }

  const canBack = hist.index > 0
  const canForward = hist.index < hist.stack.length - 1
  const back = (): void => {
    if (canBack) void go(hist.stack[hist.index - 1], { move: -1 })
  }
  const forward = (): void => {
    if (canForward) void go(hist.stack[hist.index + 1], { move: 1 })
  }

  /** Перечитать открытый документ (вернулись в окно, «Обновить») — без перехода и прокрутки. */
  async function reload(): Promise<void> {
    if (!current) return
    const seq = navSeq.current
    try {
      const text = await docs().read(current.source, current.path)
      if (seq === navSeq.current) setContent(text)
    } catch (e) {
      if (seq === navSeq.current) setDocError({ title: errorMessage(e), detail: t('config.docs.err.staleVersion') })
    }
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Вернулись в окно (агент мог дописать файлы) — список и открытый документ перечитываются.
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
      void reloadRef.current()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const updateSpy = useCallback((): void => {
    const body = bodyRef.current
    if (!body) return
    const top = body.getBoundingClientRect().top
    // Вверху документа, до первого раздела, подсвечен первый.
    let active: string | null = toc[0]?.id ?? null
    for (const item of toc) {
      const h = document.getElementById(item.id)
      if (!h) continue
      if (h.getBoundingClientRect().top - top <= 48) active = item.id
      else break
    }
    const max = body.scrollHeight - body.clientHeight
    const progress = max <= 0 ? 1 : Math.min(1, body.scrollTop / max)
    setSpy((s) => (s.active === active && Math.abs(s.progress - progress) < 0.005 ? s : { active, progress }))
  }, [toc])

  const onScroll = (): void => {
    cancelAnimationFrame(spyFrame.current)
    spyFrame.current = requestAnimationFrame(updateSpy)
  }

  // Размонтирование: отложенные кадр scroll-spy и прокрутка дерева не должны сработать после закрытия.
  useEffect(
    () => () => {
      cancelAnimationFrame(spyFrame.current)
      clearTimeout(revealTimer.current)
    },
    []
  )

  // Документ отрендерен: прокрутка к якорю или на запомненное место, затем scroll-spy.
  useLayoutEffect(() => {
    const root = articleRef.current
    const body = bodyRef.current
    const ps = pendingScroll.current
    pendingScroll.current = null
    if (root && ps && body) {
      const anchor = ps.hash ? findDocHeading(root, ps.hash) : null
      if (anchor) anchor.scrollIntoView({ block: 'start' })
      else body.scrollTop = ps.top
    }
    updateSpy()
  }, [content, rev, updateSpy])

  function jumpTo(hash: string): void {
    const root = articleRef.current
    const el = root && findDocHeading(root, hash)
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    else setDocError({ title: t('config.docs.err.noSection', { hash }) })
  }

  // ⌘F: совпадения в тексте открытого документа.
  useEffect(() => {
    setFindMatches(find.open ? findInDoc(articleRef.current, find.query) : [])
  }, [find.open, find.query, content, rev])

  useEffect(() => {
    if (findMatches.length === 0) {
      clearMatches()
      return
    }
    const i = Math.min(find.index, findMatches.length - 1)
    paintMatches(findMatches.map((m) => m.range), i)
    if (bodyRef.current) scrollToRange(bodyRef.current, findMatches[i].range)
  }, [findMatches, find.index])

  useEffect(() => clearMatches, [])

  // Поиск слева: группа «В тексте открытого документа».
  useEffect(() => {
    setTextHits(query.trim() ? findInDoc(articleRef.current, query) : [])
  }, [query, content, rev])

  useEffect(() => {
    if (find.open) findRef.current?.focus()
  }, [find.open])

  // Стартовый экран: первые строки файлов, изменённых задачами.
  useEffect(() => {
    if (current || !groups) return
    const missing = taskCards(groups).filter(({ group, file }) => !excerpts.has(`${group.source}:${file.path}`))
    if (missing.length === 0) return
    let cancelled = false
    void Promise.all(
      missing.map(async ({ group, file }) => {
        const key = `${group.source}:${file.path}`
        try {
          return [key, excerpt(await docs().read(group.source, file.path))] as const
        } catch {
          return [key, ''] as const
        }
      })
    ).then((pairs) => {
      if (!cancelled) setExcerpts((cur) => new Map([...cur, ...pairs]))
    })
    return () => {
      cancelled = true
    }
  }, [current, groups, excerpts])

  const stepFind = (d: number): void => {
    if (findMatches.length) setFind((f) => ({ ...f, index: (Math.min(f.index, findMatches.length - 1) + d + findMatches.length) % findMatches.length }))
  }
  const closeFind = (): void => setFind((f) => ({ ...f, open: false }))

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.code === 'KeyP') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (mod && e.code === 'KeyF') {
      e.preventDefault()
      if (current) {
        setFind((f) => ({ ...f, open: true }))
        findRef.current?.focus()
        findRef.current?.select()
      } else searchRef.current?.focus()
    } else if (mod && e.code === 'BracketLeft') {
      e.preventDefault()
      back()
    } else if (mod && e.code === 'BracketRight') {
      e.preventDefault()
      forward()
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      if (find.open) closeFind()
      else onClose()
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function onDocClick(e: React.MouseEvent): void {
    const a = (e.target as Element).closest('a, [data-doc-href]')
    if (!a || !current) return
    const docHref = a.getAttribute('data-doc-href')
    if (docHref !== null) {
      e.preventDefault()
      const path = resolveDocLink(current.path, docHref)
      if (path) void go({ source: current.source, path }, { hash: docLinkHash(docHref), link: docHref })
      else setDocError({ title: t('config.docs.err.outside', { href: docHref }), detail: t('config.docs.err.stay') })
    }
  }

  async function run(action: (source: string, path: string) => Promise<void>): Promise<void> {
    if (!current) return
    try {
      await action(current.source, current.path)
    } catch (e) {
      setDocError({ title: errorMessage(e) })
    }
  }

  /** Клик по папке в крошках: показать её в дереве. */
  function revealDir(dir: string): void {
    if (!current || current.source !== 'project') return
    setMode('tree')
    setQuery('')
    openAncestors({ source: 'project', path: `${dir}/x.md` }, dir)
    clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => {
      const prefixes = dirAncestors(`${dir}/x.md`).reverse()
      for (const d of prefixes) {
        const row = document.querySelector(`[data-dir-key="${CSS.escape(dirKey('project', d))}"]`)
        if (row) {
          row.scrollIntoView({ block: 'nearest' })
          return
        }
      }
    })
  }

  const toggleToc = (): void => {
    setShowToc((v) => {
      store(TOC_KEY, v ? '0' : '1')
      return !v
    })
  }

  const errorBlock = docError && (
    <div className="docs-err" role="alert">
      <DocIcon.close />
      <div className="docs-grow">
        <b>{docError.title}</b>
        {docError.detail && <><br /><span className="muted">{docError.detail}</span></>}
      </div>
      <button className="icon-btn docs-tool" title={t('config.docs.err.hide')} aria-label={t('config.docs.err.hideAria')} onClick={() => setDocError(null)}>
        <DocIcon.close />
      </button>
    </div>
  )

  const others = current && groups ? alsoIn(groups, current.source, current.path) : []
  const withToc = !!current && showToc
  const dirs = current ? current.path.split('/').slice(0, -1) : []
  const findPos = findMatches.length ? Math.min(find.index, findMatches.length - 1) + 1 : 0

  let center: React.JSX.Element
  if (groups !== null && total === 0) center = <DocsBlank onRefresh={() => void refresh()} />
  else if (current && content !== null)
    center = (
      <section className="docs-pane">
        <div className="docs-crumbs">
          <button className="icon-btn docs-tool" title={t('config.docs.nav.back')} aria-label={t('config.docs.nav.backAria')} disabled={!canBack} onClick={back}><DocIcon.back /></button>
          <button className="icon-btn docs-tool" title={t('config.docs.nav.forward')} aria-label={t('config.docs.nav.forwardAria')} disabled={!canForward} onClick={forward}><DocIcon.forward /></button>
          <div className="docs-path" title={current.path}>
            {current.source === 'project' ? (
              <span className="src">{t('config.docs.tree.project')}</span>
            ) : (
              <span className="src" title={currentGroup?.branch}><TaskDot mark={marks.get(current.source)} />{currentGroup?.title ?? current.source}</span>
            )}
            {dirs.map((seg, i) => {
              const dir = dirs.slice(0, i + 1).join('/')
              return (
                <Fragment key={dir}>
                  <span className="sep">/</span>
                  {current.source === 'project' ? (
                    <button className="seg" onClick={() => revealDir(dir)} title={t('config.docs.nav.revealDir')}>{seg}</button>
                  ) : (
                    <span className="seg">{seg}</span>
                  )}
                </Fragment>
              )
            })}
            <span className="sep">/</span>
            <span className="cur">{nameOf(current.path)}</span>
          </div>
          <span className="docs-grow" />
          <button className={`icon-btn docs-tool ${showToc ? 'on' : ''}`} title={t('config.docs.nav.toc')} aria-label={t('config.docs.nav.toc')} aria-pressed={showToc} onClick={toggleToc}><DocIcon.toc /></button>
          <button className="icon-btn docs-tool" title={t('config.docs.nav.reveal')} aria-label={t('config.docs.nav.reveal')} onClick={() => void run((s, p) => docs().reveal(s, p))}><DocIcon.reveal /></button>
          <button className="icon-btn docs-tool" title={t('config.docs.nav.openExternal')} aria-label={t('config.docs.nav.openExternal')} onClick={() => void run((s, p) => docs().open(s, p))}><DocIcon.external /></button>
        </div>
        {find.open && (
          <div className="docs-find">
            <DocIcon.search />
            <input
              ref={findRef}
              value={find.query}
              placeholder={t('config.docs.find.placeholder')}
              aria-label={t('config.docs.find.placeholder')}
              onChange={(e) => setFind({ open: true, query: e.target.value, index: 0 })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepFind(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeFind()
                }
              }}
            />
            <span className="docs-find-count">{find.query.trim() ? (findMatches.length ? t('config.docs.find.pos', { pos: findPos, total: findMatches.length }) : t('config.docs.find.none')) : ''}</span>
            <button className="icon-btn docs-tool" title={t('config.docs.find.prev')} aria-label={t('config.docs.find.prevAria')} disabled={!findMatches.length} onClick={() => stepFind(-1)}><DocIcon.up /></button>
            <button className="icon-btn docs-tool" title={t('config.docs.find.next')} aria-label={t('config.docs.find.nextAria')} disabled={!findMatches.length} onClick={() => stepFind(1)}><DocIcon.down /></button>
            <button className="icon-btn docs-tool" title={t('config.docs.find.close')} aria-label={t('config.docs.find.closeAria')} onClick={closeFind}><DocIcon.close /></button>
          </div>
        )}
        <div className="docs-body" ref={bodyRef} onScroll={onScroll}>
          {errorBlock}
          {others.map((g) =>
            g.source === 'project' ? (
              <div key={g.source} className="docs-note project">
                <DocIcon.file />
                <span className="docs-grow">{t('config.docs.version.task')} <b>{nameOf(current.path)}</b></span>
                <button className="btn-sm" onClick={() => void go({ source: 'project', path: current.path })}>{t('config.docs.version.openProject')}</button>
              </div>
            ) : (
              <div key={g.source} className="docs-note">
                <TaskDot mark={marks.get(g.source)} />
                <span className="docs-grow">{t('config.docs.version.alsoTask')} <b>«{g.title}»</b></span>
                <button className="btn-sm" onClick={() => void go({ source: g.source, path: current.path })}>{t('config.docs.version.openTask')}</button>
              </div>
            )
          )}
          <article className="docs-article" ref={articleRef} onClick={onDocClick}>
            <Markdown text={content} variant="doc" />
          </article>
        </div>
      </section>
    )
  else if (groups !== null)
    center = <DocsStart projectName={projectName} groups={groups} marks={marks} now={now} excerpts={excerpts} notice={errorBlock} onOpen={(d) => void go(d)} />
  else center = <section className="docs-start">{errorBlock}</section>

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="docs-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('config.docs.title')}>
        <div className="docs-head">
          <h3><DocIcon.doc />{t('config.docs.title')} <span className="proj">· {projectName}</span></h3>
          <span className="docs-grow" />
          <span className="docs-keys"><kbd>⌘P</kbd> {t('config.docs.keys.file')} · <kbd>⌘F</kbd> {t('config.docs.keys.inText')}</span>
          <button className="icon-btn docs-tool" title={t('config.docs.refresh')} aria-label={t('config.docs.refresh')} onClick={() => { void refresh(); void reload() }}><DocIcon.refresh /></button>
          <button className="icon-btn" title={t('config.docs.close')} aria-label={t('common.close')} onClick={onClose}><DocIcon.close /></button>
        </div>
        <div className={`docs-grid ${withToc ? 'with-toc' : ''}`}>
          <DocsTree
            groups={groups}
            listError={listError}
            now={now}
            current={current}
            marks={marks}
            mode={mode}
            onMode={setMode}
            openDirs={openDirs}
            onToggleDir={(key) => setOpenDirs((cur) => { const next = new Set(cur); if (!next.delete(key)) next.add(key); return next })}
            onCollapseAll={() => setOpenDirs(new Set())}
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            textHits={textHits}
            onTextHit={(i) => setFind({ open: true, query: query.trim(), index: i })}
            onOpen={(d) => void go(d)}
          />
          {center}
          {withToc && content !== null && (
            <DocsToc
              items={toc}
              active={spy.active}
              progress={spy.progress}
              file={currentFile}
              content={content}
              now={now}
              alsoTasks={others.filter((g) => g.source !== 'project').map((g) => g.title)}
              onJump={(id) => {
                document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                setSpy((s) => ({ ...s, active: id }))
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
