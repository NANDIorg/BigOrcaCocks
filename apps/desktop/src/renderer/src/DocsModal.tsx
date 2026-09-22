import type React from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BoardColumn, Task } from '@orca-board/core'
import type { DocGroup } from '../../shared/ipc'
import { Markdown } from './Markdown'
import { ipcErrorMessage } from './useAutoSave'
import { docLinkHash, docsApi, isStaleDocsError, resolveDocLink, STALE_APP_MESSAGE } from './docLinks'
import { alsoIn, buildTree, dirAncestors, excerpt, sameDoc, type DocRef, type TaskMark } from './docTree'
import { clearMatches, findInDoc, paintMatches, scrollToRange, type TextMatch } from './docFind'
import { buildDocToc, findDocHeading } from './docToc'
import { DocsTree, dirKey, TaskDot, type TreeMode } from './DocsTree'
import { DocsToc } from './DocsToc'
import { DocsBlank, DocsStart, taskCards } from './DocsStart'
import { DocIcon } from './docsIcons'

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
  return isStaleDocsError(msg) ? STALE_APP_MESSAGE : msg
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const STAY = 'Остались на странице, на которой были.'

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
    for (const t of tasks) {
      const col = byId.get(t.status)
      if (col) out.set(t.id, { color: col.color, status: col.title })
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
      if (opts.link && current && /не найден/i.test(msg)) {
        setDocError({ title: `Файл не найден: ${doc.path}`, detail: `Ссылка из ${nameOf(current.path)} ведёт на удалённый файл. ${STAY}` })
      } else setDocError({ title: msg, detail: current ? STAY : undefined })
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
      if (seq === navSeq.current) setDocError({ title: errorMessage(e), detail: 'Показана версия, прочитанная раньше.' })
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
    else setDocError({ title: `В документе нет раздела «${hash}»` })
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
      else setDocError({ title: `Ссылка ведёт за пределы проекта: ${docHref}`, detail: STAY })
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
      <button className="icon-btn docs-tool" title="Скрыть" aria-label="Скрыть ошибку" onClick={() => setDocError(null)}>
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
          <button className="icon-btn docs-tool" title="Назад (⌘[)" aria-label="Назад" disabled={!canBack} onClick={back}><DocIcon.back /></button>
          <button className="icon-btn docs-tool" title="Вперёд (⌘])" aria-label="Вперёд" disabled={!canForward} onClick={forward}><DocIcon.forward /></button>
          <div className="docs-path" title={current.path}>
            {current.source === 'project' ? (
              <span className="src">Проект</span>
            ) : (
              <span className="src" title={currentGroup?.branch}><TaskDot mark={marks.get(current.source)} />{currentGroup?.title ?? current.source}</span>
            )}
            {dirs.map((seg, i) => {
              const dir = dirs.slice(0, i + 1).join('/')
              return (
                <Fragment key={dir}>
                  <span className="sep">/</span>
                  {current.source === 'project' ? (
                    <button className="seg" onClick={() => revealDir(dir)} title="Показать в дереве">{seg}</button>
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
          <button className={`icon-btn docs-tool ${showToc ? 'on' : ''}`} title="Оглавление" aria-label="Оглавление" aria-pressed={showToc} onClick={toggleToc}><DocIcon.toc /></button>
          <button className="icon-btn docs-tool" title="Показать в папке" aria-label="Показать в папке" onClick={() => void run((s, p) => docs().reveal(s, p))}><DocIcon.reveal /></button>
          <button className="icon-btn docs-tool" title="Открыть в системе" aria-label="Открыть в системе" onClick={() => void run((s, p) => docs().open(s, p))}><DocIcon.external /></button>
        </div>
        {find.open && (
          <div className="docs-find">
            <DocIcon.search />
            <input
              ref={findRef}
              value={find.query}
              placeholder="Найти в документе"
              aria-label="Найти в документе"
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
            <span className="docs-find-count">{find.query.trim() ? (findMatches.length ? `${findPos} из ${findMatches.length}` : 'нет совпадений') : ''}</span>
            <button className="icon-btn docs-tool" title="Предыдущее (⇧↵)" aria-label="Предыдущее" disabled={!findMatches.length} onClick={() => stepFind(-1)}><DocIcon.up /></button>
            <button className="icon-btn docs-tool" title="Следующее (↵)" aria-label="Следующее" disabled={!findMatches.length} onClick={() => stepFind(1)}><DocIcon.down /></button>
            <button className="icon-btn docs-tool" title="Закрыть (Esc)" aria-label="Закрыть поиск" onClick={closeFind}><DocIcon.close /></button>
          </div>
        )}
        <div className="docs-body" ref={bodyRef} onScroll={onScroll}>
          {errorBlock}
          {others.map((g) =>
            g.source === 'project' ? (
              <div key={g.source} className="docs-note project">
                <DocIcon.file />
                <span className="docs-grow">Это версия файла из задачи. В проекте есть свой <b>{nameOf(current.path)}</b></span>
                <button className="btn-sm" onClick={() => void go({ source: 'project', path: current.path })}>Открыть версию проекта</button>
              </div>
            ) : (
              <div key={g.source} className="docs-note">
                <TaskDot mark={marks.get(g.source)} />
                <span className="docs-grow">Этот файл также изменён в задаче <b>«{g.title}»</b></span>
                <button className="btn-sm" onClick={() => void go({ source: g.source, path: current.path })}>Открыть версию задачи</button>
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
      <div className="docs-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Документы">
        <div className="docs-head">
          <h3><DocIcon.doc />Документы <span className="proj">· {projectName}</span></h3>
          <span className="docs-grow" />
          <span className="docs-keys"><kbd>⌘P</kbd> файл · <kbd>⌘F</kbd> в тексте</span>
          <button className="icon-btn docs-tool" title="Обновить" aria-label="Обновить" onClick={() => { void refresh(); void reload() }}><DocIcon.refresh /></button>
          <button className="icon-btn" title="Закрыть (Esc)" aria-label="Закрыть" onClick={onClose}><DocIcon.close /></button>
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
