import { getUiApi } from './host'
import { motionScrollBehavior } from './appearance'
import type React from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BoardColumn, Task } from '@orca-board/core'
import type { DocGroup, DocView } from '../shared/ipc'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'
import { docsApi, isStaleDocsError, resolveDocLink, staleAppMessage } from './docLinks'
import {
  absolutePath, alsoIn, buildTree, dirAncestors, excerpt, focusRefreshDue, readOpenDirs, sameDoc, writeOpenDirs,
  type DocRef, type TaskMark
} from './docTree'
import { clearMatches, findInDoc, paintMatches, scrollToRange, type TextMatch } from './docFind'
import { buildDocToc, findDocHeading } from './docToc'
import { DocsTree, dirKey, TaskDot, type TreeMode } from './DocsTree'
import { DocsToc } from './DocsToc'
import { DocsBlank, DocsStart, taskCards } from './DocsStart'
import { DocActionsMenu, DocKindIcon, DocStatus, DocViewControls, DocViewer } from './DocViewer'
import { DocStub } from './DocStub'
import { docActions, docFindable, docModes, docZoomable, effectiveMode, type DocAction, type DocMode, type DocZoom } from './docView'
import { DocViewStaleError, docViewApi, docViewFailure, hasDocView, type DocViewFailure } from './docViewApi'
import { DocIcon } from './docsIcons'
import { t as translateNow, useT } from './i18n'

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

/**
 * Что показано для открытого файла: ответ `docs:view` или ошибка на месте просмотра — приложение устарело, ссылка
 * ведёт наружу, это не файл. Остальные отказы (файла нет, нет прав) — баннер над прежним документом.
 */
type Shown = { view: DocView; failure?: undefined } | { view?: undefined; failure: DocViewFailure }

const docs = (): ReturnType<typeof docsApi> => docsApi(getUiApi())

function errorMessage(e: unknown): string {
  const msg = ipcErrorMessage(e)
  return isStaleDocsError(msg) ? staleAppMessage() : msg
}

/** Файла нет: новый main присылает `files.notFound`, `docs:read` — `docs.notFound`, main до перевода — только текст. */
function isNotFound(e: unknown): boolean {
  const code = ipcErrorCode(e)
  return code === 'files.notFound' || code === 'docs.notFound' || (!code && /не найден/i.test(ipcErrorMessage(e)))
}

/** Заголовок баннера: «Файл не найден: путь» понятнее текста main, остальное — текст main как есть. */
function errorTitle(e: unknown, path: string): string {
  return isNotFound(e) ? translateNow('config.docs.err.notFound', { path }) : errorMessage(e)
}

/** Отказы, которые показываются заглушкой вместо просмотра: человек выбрал файл, и это ответ про сам файл. */
const IN_PLACE: ReadonlySet<DocViewFailure['kind']> = new Set(['stale', 'outside', 'notFile'])

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const MODE_KEY = 'orca.docs.mode'
const TOC_KEY = 'orca.docs.toc'
/** Задержка поиска по пути после ввода: в проекте до 100 000 файлов. */
const SEARCH_DEBOUNCE_MS = 120

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

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

/** Значение с задержкой; пустая строка — сразу (сброс поиска не ждёт). */
function useDebounced(value: string, ms: number): string {
  const [out, setOut] = useState(value)
  useEffect(() => {
    if (!value.trim()) {
      setOut(value)
      return
    }
    const timer = setTimeout(() => setOut(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return out
}

/**
 * Как показать файл: `docs:view`, а при старом preload/main (renderer обновился по HMR) — `.md` по-старому через
 * `docs:read`; остальное тогда — `DocViewStaleError` («перезапустите приложение»).
 */
async function loadView(doc: DocRef, groups: DocGroup[] | null): Promise<DocView> {
  if (hasDocView(getUiApi())) {
    try {
      return await docViewApi(getUiApi()).view(doc.source, doc.path)
    } catch (e) {
      if (docViewFailure(e).kind !== 'stale') throw e
    }
  }
  if (!/\.md$/i.test(doc.path)) throw new DocViewStaleError()
  const text = await docs().read(doc.source, doc.path)
  const file = groups?.find((g) => g.source === doc.source)?.files.find((f) => f.path === doc.path)
  return { kind: 'markdown', size: file?.size ?? text.length, mtime: file?.mtime ?? 0, text, openable: true }
}

export interface DocsModalProps {
  projectId: string
  projectName: string
  /** Корень проекта — для «Копировать абсолютный путь». */
  root: string
  tasks: Task[]
  columns: BoardColumn[]
  onClose(): void
}

/**
 * «Документы» (кнопка в rail), раскладка «Проводник» (docs/design/docs-files/variant-1.html, меню «⋯» — из
 * variant-2.html): дерево всех файлов проекта и `.md` worktree задач в работе | просмотр файла по виду с историей и
 * поиском | оглавление — только у markdown. Ссылки из markdown на файлы проекта открываются здесь же, http(s) — во
 * внешнем браузере.
 */
export function DocsModal({ projectId, projectName, root, tasks, columns, onClose }: DocsModalProps): React.JSX.Element {
  const t = useT()
  const [groups, setGroups] = useState<DocGroup[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [hist, setHist] = useState<{ stack: Entry[]; index: number }>({ stack: [], index: -1 })
  const [shown, setShown] = useState<Shown | null>(null)
  /** Растёт с каждым переходом: пересчитать оглавление и прокрутку, даже если текст тот же. */
  const [rev, setRev] = useState(0)
  /** Растёт по «Обновить» и при изменении файла на диске: просмотрщики перечитывают картинку, исходник, превью. */
  const [reloadTick, setReloadTick] = useState(0)
  const [docMode, setDocMode] = useState<DocMode | undefined>(undefined)
  const [zoom, setZoom] = useState<DocZoom>('fit')
  const [dims, setDims] = useState<{ width: number; height: number } | undefined>(undefined)
  const [docError, setDocError] = useState<DocError | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const searchQuery = useDebounced(query, SEARCH_DEBOUNCE_MS)
  const [mode, setModeState] = useState<TreeMode>(() => (stored(MODE_KEY) === 'recent' ? 'recent' : 'tree'))
  const [showToc, setShowToc] = useState(() => stored(TOC_KEY) !== '0')
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => {
    const saved = readOpenDirs(safeStorage(), projectId)
    return new Set((saved ?? []).map((d) => dirKey('project', d)))
  })
  const [spy, setSpy] = useState<{ active: string | null; progress: number }>({ active: null, progress: 0 })
  const [find, setFind] = useState<Find>({ open: false, query: '', index: 0 })
  const [findMatches, setFindMatches] = useState<TextMatch[]>([])
  const [textHits, setTextHits] = useState<TextMatch[]>([])
  const [excerpts, setExcerpts] = useState<Map<string, string>>(new Map())
  /** Корень текста (`<article>` markdown, `<code>` кода) и прокручиваемая область — монтируются, когда файл загрузился. */
  const [textEl, setTextEl] = useState<HTMLElement | null>(null)
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const navSeq = useRef(0)
  const pendingScroll = useRef<{ hash?: string; top: number } | null>(null)
  /** Раскрытые папки уже были (сохранённые или верхний уровень) — первая загрузка их не трогает. */
  const dirsInited = useRef(readOpenDirs(safeStorage(), projectId) !== null)
  const spyFrame = useRef(0)
  const revealTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastRefresh = useRef(0)

  const current: Entry | null = hist.stack[hist.index] ?? null
  const view = shown?.view ?? null
  const currentGroup = groups?.find((g) => g.source === current?.source)
  const currentFile = currentGroup?.files.find((f) => f.path === current?.path)
  const total = (groups ?? []).reduce((n, g) => n + g.files.length, 0)
  const viewMode = view ? effectiveMode(view, docMode) : undefined
  const markdownDoc = view?.kind === 'markdown' && !view.stub && viewMode === 'doc'
  const markdownText = markdownDoc ? view.text ?? '' : null
  // Оглавление — из исходника: те же id, что у заголовков в <Markdown variant="doc">.
  const toc = useMemo(() => (markdownText === null ? [] : buildDocToc(markdownText)), [markdownText])
  const findable = !!view && docFindable(view, docMode)

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

  // Раскрытые папки проекта переживают перезапуск (`orca.docs.open.<projectId>`). Ключи бывшей вкладки «Файлы»
  // (`orca.files.open.*`) больше не читаются — убираем мусор.
  useEffect(() => {
    if (!dirsInited.current) return
    const prefix = dirKey('project', '')
    writeOpenDirs(safeStorage(), projectId, [...openDirs].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))
  }, [openDirs, projectId])
  useEffect(() => {
    try {
      localStorage.removeItem(`orca.files.open.${projectId}`)
    } catch {
      // localStorage недоступен — убирать нечего
    }
  }, [projectId])

  const openAncestors = useCallback((doc: DocRef, withSelf?: string): void => {
    if (doc.source !== 'project') return
    const keys = [...dirAncestors(doc.path), ...(withSelf ? [withSelf] : [])].map((d) => dirKey('project', d))
    setOpenDirs((cur) => (keys.every((k) => cur.has(k)) ? cur : new Set([...cur, ...keys])))
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    lastRefresh.current = Date.now()
    try {
      const next = await docs().list()
      setGroups(next)
      setListError(null)
      setNow(Date.now())
      // Первая загрузка без сохранённых папок — раскрыт верхний уровень.
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

  /** Перейти к уже прочитанному файлу: запись в истории, сброс вида, прокрутка — на якорь или запомненное место. */
  function commit(doc: DocRef, next: Shown, opts: { hash?: string; move?: number }): void {
    const leaving = bodyEl?.scrollTop ?? 0
    const target = opts.move ? hist.stack[hist.index + opts.move] : undefined
    setHist((h) => {
      const stack = h.stack.map((e, i) => (i === h.index ? { ...e, scroll: leaving } : e))
      if (opts.move) return { stack, index: h.index + opts.move }
      return { stack: [...stack.slice(0, h.index + 1), { ...doc, scroll: 0 }], index: h.index + 1 }
    })
    pendingScroll.current = { hash: opts.hash, top: target?.scroll ?? 0 }
    setShown(next)
    setDocMode(undefined)
    setDims(undefined)
    setFind((f) => ({ ...f, index: 0 }))
    setRev((r) => r + 1)
    setDocError(null)
    openAncestors(doc)
  }

  /**
   * Открыть файл: сначала читаем, и только если прочитался — переходим. Битая ссылка и недоступный файл оставляют
   * открытым прежний документ и показывают ошибку сверху. `move` — шаг по истории (‹ ›) вместо новой записи.
   */
  async function go(doc: DocRef, opts: { hash?: string; link?: string; move?: number } = {}): Promise<void> {
    if (!opts.move && sameDoc(current, doc)) {
      setDocError(null)
      if (opts.hash) jumpTo(opts.hash)
      return
    }
    const seq = ++navSeq.current
    let next: DocView
    try {
      next = await loadView(doc, groups)
    } catch (e) {
      if (seq !== navSeq.current) return
      const failure = docViewFailure(e)
      if (IN_PLACE.has(failure.kind)) {
        commit(doc, { failure }, opts)
        return
      }
      if (opts.link && current && isNotFound(e)) {
        setDocError({
          title: t('config.docs.err.notFound', { path: doc.path }),
          detail: `${t('config.docs.err.deletedLink', { name: nameOf(current.path) })} ${t('config.docs.err.stay')}`
        })
      } else setDocError({ title: errorTitle(e, doc.path), detail: current ? t('config.docs.err.stay') : undefined })
      return
    }
    if (seq !== navSeq.current) return
    commit(doc, { view: next }, opts)
  }

  const canBack = hist.index > 0
  const canForward = hist.index < hist.stack.length - 1
  const back = (): void => {
    if (canBack) void go(hist.stack[hist.index - 1], { move: -1 })
  }
  const forward = (): void => {
    if (canForward) void go(hist.stack[hist.index + 1], { move: 1 })
  }

  /**
   * Перечитать открытый файл без перехода и прокрутки. `force` — «Обновить»: просмотрщики перечитают картинку и
   * превью в любом случае; при возврате фокуса — только если файл на диске изменился (иначе превью HTML сбрасывалось
   * бы при каждом переключении окна). Ошибка — баннер, прежний документ остаётся.
   */
  async function reload(force: boolean): Promise<void> {
    if (!current) return
    const seq = navSeq.current
    try {
      const next = await loadView(current, groups)
      if (seq !== navSeq.current) return
      const prev = shown?.view
      const changed = !prev || prev.mtime !== next.mtime || prev.size !== next.size || prev.text !== next.text || prev.kind !== next.kind
      if (changed) setShown({ view: next })
      if (changed || force) setReloadTick((n) => n + 1)
      if (force) setDocError(null)
    } catch (e) {
      if (seq !== navSeq.current) return
      if (shown?.failure) setShown({ failure: docViewFailure(e) })
      else setDocError({ title: errorTitle(e, current.path), detail: t('config.docs.err.staleVersion') })
    }
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Вернулись в окно (агент мог дописать файлы) — список и открытый файл перечитываются, но не чаще раза в 5 секунд:
  // список всего проекта — это `git ls-files` и lstat каждого файла.
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    const onFocus = (): void => {
      if (!focusRefreshDue(lastRefresh.current, Date.now())) return
      void refresh()
      void reloadRef.current(false)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const updateSpy = useCallback((): void => {
    const body = bodyEl
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
  }, [toc, bodyEl])

  const onScroll = (): void => {
    cancelAnimationFrame(spyFrame.current)
    spyFrame.current = requestAnimationFrame(updateSpy)
  }

  // Размонтирование: отложенные кадр scroll-spy, прокрутка дерева и тост не должны сработать после закрытия.
  useEffect(
    () => () => {
      cancelAnimationFrame(spyFrame.current)
      clearTimeout(revealTimer.current)
      clearTimeout(toastTimer.current)
    },
    []
  )

  // Файл отрендерен: прокрутка к якорю или на запомненное место, затем scroll-spy. Markdown с картинками и исходник
  // HTML приходят не сразу — прокрутка ждёт, пока появятся текст и область прокрутки. Сразу после перехода в состоянии
  // ещё элементы прежнего файла (новые придут из ref-колбэков следующим рендером) — их отличает `isConnected`.
  useLayoutEffect(() => {
    const ps = pendingScroll.current
    const text = textEl?.isConnected ? textEl : null
    if (ps && bodyEl?.isConnected && (text || !ps.hash)) {
      pendingScroll.current = null
      const anchor = ps.hash && text ? findDocHeading(text, ps.hash) : null
      if (anchor) anchor.scrollIntoView({ block: 'start' })
      else bodyEl.scrollTop = ps.top
    }
    updateSpy()
  }, [shown, rev, textEl, bodyEl, updateSpy])

  function jumpTo(hash: string): void {
    const el = textEl && findDocHeading(textEl, hash)
    if (el) el.scrollIntoView({ block: 'start', behavior: motionScrollBehavior() })
    else setDocError({ title: t('config.docs.err.noSection', { hash }) })
  }

  // ⌘F: совпадения в тексте открытого файла.
  useEffect(() => {
    setFindMatches(find.open && findable ? findInDoc(textEl, find.query) : [])
  }, [find.open, find.query, findable, textEl, shown, rev])

  useEffect(() => {
    if (findMatches.length === 0) {
      clearMatches()
      return
    }
    const i = Math.min(find.index, findMatches.length - 1)
    paintMatches(findMatches.map((m) => m.range), i)
    if (bodyEl) scrollToRange(bodyEl, findMatches[i].range)
  }, [findMatches, find.index, bodyEl])

  useEffect(() => clearMatches, [])

  // Поиск слева: группа «В тексте открытого файла».
  useEffect(() => {
    setTextHits(searchQuery.trim() && findable ? findInDoc(textEl, searchQuery) : [])
  }, [searchQuery, findable, textEl, shown, rev])

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
  const openFind = (): void => {
    setFind((f) => ({ ...f, open: true }))
    findRef.current?.focus()
    findRef.current?.select()
  }

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.code === 'KeyP') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (mod && e.code === 'KeyF') {
      e.preventDefault()
      if (current && findable) openFind()
      else searchRef.current?.focus()
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

  /** Ссылка markdown на файл того же источника: путь уже от корня (Markdown разрешил его сам). */
  function openLink(path: string, hash?: string): void {
    if (!current) return
    void go({ source: current.source, path }, { hash, link: path })
  }

  // Ссылку, которую Markdown не смог разрешить в путь источника (выход за корень, `.git`), он оставляет в
  // data-doc-href: здесь — только понятная ошибка вместо молчания.
  function onDocClick(e: React.MouseEvent): void {
    const a = (e.target as Element).closest('[data-doc-href]')
    if (!a || !current) return
    e.preventDefault()
    const href = a.getAttribute('data-doc-href') ?? ''
    const target = resolveDocLink(current.path, href)
    if (target) openLink(target.path, target.hash)
    else setDocError({ title: t('config.docs.err.outside', { href }), detail: t('config.docs.err.stay') })
  }

  function showToast(text: string): void {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1600)
  }

  async function onAction(action: DocAction): Promise<void> {
    if (!current) return
    const { source, path } = current
    try {
      if (action === 'copy' || action === 'copyAbs') {
        try {
          await navigator.clipboard.writeText(action === 'copyAbs' ? absolutePath(root, path) : path)
          showToast(t('config.docs.view.copied'))
        } catch {
          showToast(t('config.docs.view.copyFailed'))
        }
      } else if (action === 'reveal') await docs().reveal(source, path)
      else await docs().open(source, path)
    } catch (e) {
      setDocError({ title: errorMessage(e) })
    }
  }

  /** Клик по папке в крошках: показать её в дереве. */
  function revealDir(dir: string): void {
    if (!current || current.source !== 'project') return
    setMode('tree')
    setQuery('')
    openAncestors({ source: 'project', path: `${dir}/x` }, dir)
    clearTimeout(revealTimer.current)
    revealTimer.current = setTimeout(() => {
      const prefixes = dirAncestors(`${dir}/x`).reverse()
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
  const withToc = markdownDoc && showToc
  const dirs = current ? current.path.split('/').slice(0, -1) : []
  const findPos = findMatches.length ? Math.min(find.index, findMatches.length - 1) + 1 : 0
  const actions = current ? docActions(current.source, view ?? undefined) : null

  const notices = current && (errorBlock || others.length > 0) ? (
    <>
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
    </>
  ) : null

  let center: React.JSX.Element
  if (groups !== null && total === 0) center = <DocsBlank onRefresh={() => void refresh()} />
  else if (current && shown && actions)
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
            <span className="cur"><DocKindIcon path={current.path} kind={view?.kind} />{nameOf(current.path)}</span>
          </div>
          <span className="docs-grow" />
          {view && (
            <DocViewControls
              view={view}
              mode={docMode}
              zoom={zoom}
              findOpen={find.open}
              onMode={setDocMode}
              onZoom={setZoom}
              onReloadPreview={() => setReloadTick((n) => n + 1)}
              onFind={() => (find.open ? closeFind() : openFind())}
            />
          )}
          {markdownDoc && (
            <button className={`icon-btn docs-tool ${showToc ? 'on' : ''}`} title={t('config.docs.nav.toc')} aria-label={t('config.docs.nav.toc')} aria-pressed={showToc} onClick={toggleToc}><DocIcon.toc /></button>
          )}
          {(findable || markdownDoc || (view && (docModes(view).length > 0 || docZoomable(view, docMode)))) && <span className="docs-vsep docs-acts" />}
          <span className="docs-ctl docs-acts">
            <button className="icon-btn docs-tool" title={t('config.docs.view.copyPath')} aria-label={t('config.docs.view.copyPath')} onClick={() => void onAction('copy')}><DocIcon.copy /></button>
            <button className="icon-btn docs-tool" title={(getUiApi().app.environment === 'web' ? t('shell.web.download') : t('config.docs.nav.reveal'))} aria-label={(getUiApi().app.environment === 'web' ? t('shell.web.download') : t('config.docs.nav.reveal'))} onClick={() => void onAction('reveal')}><DocIcon.reveal /></button>
            {actions.open && (
              <button className="icon-btn docs-tool" title={t('config.docs.nav.openExternal')} aria-label={t('config.docs.nav.openExternal')} onClick={() => void onAction('open')}><DocIcon.external /></button>
            )}
          </span>
          <DocActionsMenu actions={actions} onAction={(a) => void onAction(a)} />
        </div>
        {find.open && findable && (
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
        <div className="docs-view" onClick={onDocClick}>
          {view ? (
            <DocViewer
              key={`${current.source}:${current.path}`}
              source={current.source}
              path={current.path}
              view={view}
              mode={docMode}
              zoom={zoom}
              reload={reloadTick}
              now={now}
              actions={actions}
              textRef={setTextEl}
              scrollRef={setBodyEl}
              onScroll={onScroll}
              notices={notices}
              onLink={openLink}
              onAction={(a) => void onAction(a)}
              onRetry={() => void reload(true)}
              onImageDims={setDims}
            />
          ) : (
            <>
              {notices && <div className="docs-notices">{notices}</div>}
              <DocStub path={current.path} failure={shown.failure} now={now} actions={actions} onAction={(a) => void onAction(a)} onRetry={() => void reload(true)} />
            </>
          )}
        </div>
        {view && <DocStatus path={current.path} view={view} mode={docMode} zoom={zoom} now={now} dims={dims} />}
        {toast && <div className="docs-toast" role="status">{toast}</div>}
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
          <button className="icon-btn docs-tool" title={t('config.docs.refresh')} aria-label={t('config.docs.refresh')} onClick={() => { void refresh(); void reload(true) }}><DocIcon.refresh /></button>
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
            searchQuery={searchQuery}
            onQuery={setQuery}
            searchRef={searchRef}
            textHits={textHits}
            onTextHit={(i) => setFind({ open: true, query: searchQuery.trim(), index: i })}
            onOpen={(d) => void go(d)}
          />
          {center}
          {withToc && markdownText !== null && (
            <DocsToc
              items={toc}
              active={spy.active}
              progress={spy.progress}
              file={currentFile}
              content={markdownText}
              now={now}
              alsoTasks={others.filter((g) => g.source !== 'project').map((g) => g.title)}
              onJump={(id) => {
                document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: motionScrollBehavior() })
                setSpy((s) => ({ ...s, active: id }))
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
