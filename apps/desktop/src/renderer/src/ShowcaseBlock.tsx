import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { DispatchShowcase } from '@orca-board/core'
import { Markdown } from './Markdown'
import { hasMarkdownImages, showcaseTextAssets, type MarkdownAssets } from './markdownAssets'
import { PopupMenu, POPUP_MENU_WIDTH } from './PopupMenu'
import { PreviewFrame, usePreviewUrl } from './PreviewFrame'
import {
  FILE_KIND_ICON, fileKindLabel, ShowcaseViewer, useBlobUrl, useShowcaseBytes, useShowcaseMarkdownAssets, type ShowcaseDecision
} from './ShowcaseViewer'
import {
  hiddenFiles, INLINE_FRAME_HEIGHT, INLINE_VIEWPORTS, requestShowcaseGroups, scalePercent, showcaseApi, showcaseEntries, showcaseFailure,
  showcasePreviewBaseApi,
  showcaseGroup, SHOWCASE_CARD_ENTRIES, SHOWCASE_GROUP_ENTRIES, thumbsShown, type FrameFit, type RequestShowcase, type ShowcaseFileItem,
  type ShowcaseGroup, type ShowcasePos, type ShowcaseTaskState
} from './showcase'
import { useT, type TKey } from './i18n'
import { Icon } from './icons'

interface Props {
  /** Задача показа: из её worktree читается старый показ без снимка (IPC showcase:*). */
  taskId: string
  /** Запуск, сдавший показ: по нему main берёт снимок и выдаёт адрес страницы (`showcase:previewUrl`). */
  dispatchId: string
  showcase: DispatchShowcase
  /** Без рамки и заголовка: модалка задачи, где заголовок — у раздела. */
  bare?: boolean
  /** Решение approval: есть — внизу просмотрщика поле и «Принять» / «Вернуть…» (вариант 2 макета). */
  decision?: ShowcaseDecision
}

type Api = ReturnType<typeof showcaseApi>

/**
 * Показ человеку с ноды «Работа» (Dispatch.showcase): описание воркера и файлы (docs/design/showcase-viewer/variant-2.html).
 * HTML — «Превью» (мини-просмотрщик: изолированный фрейм, «Десктоп / Телефон», «Обновить»; грузится только по нажатию,
 * открыт один за раз) и «На весь экран»; картинки — сеткой миниатюр 3 в ряд; markdown — «Текст»; PDF — «Открыть».
 * «Открыть» / «В папке» у страниц и md — в меню «⋯». Всё, кроме PDF и неоткрываемых файлов, открывается в ShowcaseViewer.
 */
export function ShowcaseBlock({ taskId, dispatchId, showcase, bare = false, decision }: Props): React.JSX.Element {
  const t = useT()
  const group = useMemo(() => showcaseGroup(taskId, dispatchId, showcase), [taskId, dispatchId, showcase])
  const groups = useMemo(() => [group], [group])
  const [viewer, setViewer] = useState<ShowcasePos | null>(null)
  const view = (file: number): void => setViewer({ group: 0, file })
  const viewable = group.files.some((f) => f.view !== 'none')

  return (
    <section className={`showcase${bare ? ' bare' : ''}`} aria-label={t('board.showcase.title')}>
      {(!bare || viewable) && (
        <div className="showcase-head">
          {!bare && <span>{t('board.showcase.title')}</span>}
          <span className="grow" />
          {viewable && (
            <button type="button" className="btn-sm" onClick={() => view(0)} title={t('board.showcase.viewAllTitle')}>
              {t('board.showcase.viewAll', { n: group.files.length })} <Icon.expand />
            </button>
          )}
        </div>
      )}
      {showcase.text && <ShowcaseText dispatchId={dispatchId} text={showcase.text} />}
      <ShowcaseFileList group={group} limit={SHOWCASE_CARD_ENTRIES} onView={view} />
      {viewer && <ShowcaseViewer groups={groups} start={viewer} decision={decision} onClose={() => setViewer(null)} />}
    </section>
  )
}

/**
 * Показ из запроса (`requestShowcases`): у approval задачи и у answer — один `ShowcaseBlock`; у approval прогона —
 * `ShowcaseGroupsBlock` по подзадачам, даже если подзадача одна (её название и состояние тоже нужны).
 */
export function RequestShowcaseBlock({ items, decision }: { items: readonly RequestShowcase[]; decision?: ShowcaseDecision }): React.JSX.Element | null {
  if (items.length === 0) return null
  const [first] = items
  if (items.length === 1 && first.title === undefined) {
    return <ShowcaseBlock taskId={first.taskId} dispatchId={first.dispatchId} showcase={first.showcase} decision={decision} />
  }
  return <ShowcaseGroupsBlock items={items} decision={decision} />
}

/** Цвет полосы подзадачи: как у колонок доски (готово — «Сделано», на проверке — «Ревью», иначе — «В работе»). */
const STATE_TONE: Record<ShowcaseTaskState, string> = { done: 'var(--col-done)', review: 'var(--col-review)', work: 'var(--col-progress)' }

/**
 * Approval прогона: показ нескольких подзадач (`showcaseDispatchIds`, вариант 2 макета → «Несколько подзадач»). Каждая
 * подзадача — свой блок с цветной полосой и чипом состояния, числом файлов, сворачиванием и «Смотреть» с её первого
 * файла; «Смотреть всё» — просмотрщик с теми же группами в боковом списке. «Ещё N файлов» — по три записи на подзадачу.
 */
export function ShowcaseGroupsBlock({ items, decision }: { items: readonly RequestShowcase[]; decision?: ShowcaseDecision }): React.JSX.Element {
  const t = useT()
  const groups = useMemo(() => requestShowcaseGroups(items), [items])
  const total = groups.reduce((n, g) => n + g.files.length, 0)
  const [viewer, setViewer] = useState<ShowcasePos | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const viewable = groups.some((g) => g.files.some((f) => f.view !== 'none'))

  return (
    <section className="showcase" aria-label={t('board.showcase.title')}>
      <div className="showcase-head">
        <span>{t('board.showcase.groupsTitle', { subtasks: t('board.showcase.subtasks', { count: groups.length }) })}</span>
        <span className="grow" />
        {viewable && (
          <button type="button" className="btn-sm" onClick={() => setViewer({ group: 0, file: 0 })} title={t('board.showcase.viewAllTitle')}>
            {t('board.showcase.viewAll', { n: total })} <Icon.expand />
          </button>
        )}
      </div>
      {items.map((x, gi) => {
        const g = groups[gi]
        const open = !collapsed.has(x.dispatchId)
        const title = x.title ?? x.taskId
        return (
          <div
            key={x.dispatchId}
            className="sv-sub"
            role="group"
            aria-label={title}
            style={{ '--tone': x.state ? STATE_TONE[x.state] : 'var(--line)' } as React.CSSProperties}
          >
            <div className="sv-group-head">
              <button
                type="button"
                className="tgl"
                aria-expanded={open}
                aria-label={t(open ? 'board.showcase.collapseSub' : 'board.showcase.expandSub', { title })}
                onClick={() => toggle(x.dispatchId)}
              >
                {open ? <Icon.down /> : <Icon.chevron />}
              </button>
              <span className="ttl" title={title}>
                {title}
                <span className="cnt">{t('board.card.files', { count: g.files.length })}</span>
              </span>
              {x.state && <span className={`chip sv-st ${x.state}`}>{t(`board.showcase.state.${x.state}` as TKey)}</span>}
              {g.files.some((f) => f.view !== 'none') && (
                <button
                  type="button"
                  className="btn-sm icon"
                  onClick={() => setViewer({ group: gi, file: 0 })}
                  title={t('board.showcase.viewSubTitle', { title })}
                  aria-label={t('board.showcase.viewSubTitle', { title })}
                >
                  <Icon.expand />
                </button>
              )}
            </div>
            {open && (
              <>
                {x.showcase.text && <ShowcaseText dispatchId={x.dispatchId} text={x.showcase.text} />}
                <ShowcaseFileList group={g} limit={SHOWCASE_GROUP_ENTRIES} onView={(file) => setViewer({ group: gi, file })} />
              </>
            )}
          </div>
        )
      })}
      {viewer && <ShowcaseViewer groups={groups} start={viewer} decision={decision} onClose={() => setViewer(null)} />}
    </section>
  )
}

/**
 * Контекст картинок описания показа запуска `dispatchId` (`showcase:previewBase`): относительные `![](design/a.png)` —
 * от корня репозитория, из снимка. Пока база не пришла — undefined (не мигать подписью); нет базы, старый
 * main/preload или ошибка — без `base`: картинки заменяются подписью. Без картинок в тексте IPC не зовётся.
 */
function useShowcaseTextAssets(dispatchId: string, text: string): MarkdownAssets | undefined {
  const images = useMemo(() => hasMarkdownImages(text), [text])
  const [state, setState] = useState<{ dispatchId: string; assets: MarkdownAssets } | null>(null)
  useEffect(() => {
    if (!images) return
    let alive = true
    const done = (base: unknown): void => { if (alive) setState({ dispatchId, assets: showcaseTextAssets(base) }) }
    const api = showcasePreviewBaseApi(window.orca)
    if (!api) done(null)
    else api(dispatchId).then(done, () => done(null))
    return () => { alive = false }
  }, [dispatchId, images])
  if (!images) return showcaseTextAssets(null)
  return state?.dispatchId === dispatchId ? state.assets : undefined
}

/** Описание показа (`--show-file`): markdown с картинками из снимка запуска. */
function ShowcaseText({ dispatchId, text }: { dispatchId: string; text: string }): React.JSX.Element | null {
  const assets = useShowcaseTextAssets(dispatchId, text)
  if (!assets) return null
  return <Markdown text={text} className="showcase-md" assets={assets} />
}

/**
 * Файлы одной группы показа в карточке: картинки подряд — сеткой миниатюр, остальные — строками; первые `limit`
 * записей, остальное — за «Ещё N файлов». `onView` — открыть просмотрщик на файле группы.
 */
function ShowcaseFileList({ group, limit, onView }: { group: ShowcaseGroup; limit: number; onView(file: number): void }): React.JSX.Element | null {
  const t = useT()
  const { taskId, dispatchId } = group
  const entries = useMemo(() => showcaseEntries(group.files), [group])
  const [expanded, setExpanded] = useState(false)
  const [inline, setInline] = useState<string | null>(null)
  const shown = expanded ? entries : entries.slice(0, limit)
  const hidden = hiddenFiles(entries, limit)
  if (entries.length === 0) return null
  return (
    <>
      <ul className="showcase-files">
        {shown.map((e) =>
          e.kind === 'images'
            ? <ThumbGrid key={`img:${e.files[0].index}`} taskId={taskId} dispatchId={dispatchId} files={e.files} onView={onView} />
            : (
              <ShowcaseFile
                key={e.file.path}
                taskId={taskId}
                dispatchId={dispatchId}
                file={e.file}
                inline={inline === e.file.path}
                onInline={(on) => setInline(on ? e.file.path : null)}
                onView={() => onView(e.index)}
                onLink={(path) => {
                  const fi = group.files.findIndex((f) => f.path === path)
                  if (fi >= 0) onView(fi)
                }}
              />
            )
        )}
      </ul>
      {hidden > 0 && (
        <button type="button" className="showcase-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('board.showcase.less') : t('board.showcase.more', { files: t('board.card.files', { count: hidden }) })}
          {expanded ? <Icon.up /> : <Icon.down />}
        </button>
      )}
    </>
  )
}

/** Действие с файлом через IPC; ошибка — строкой под файлом. */
function useAct(): { error: string | null; act(fn: (api: Api) => Promise<void>): void } {
  const [error, setError] = useState<string | null>(null)
  const act = (fn: (api: Api) => Promise<void>): void => {
    setError(null)
    try {
      fn(showcaseApi(window.orca)).catch((e: unknown) => setError(showcaseFailure(e).message))
    } catch (e) {
      setError(showcaseFailure(e).message)
    }
  }
  return { error, act }
}

interface FileProps {
  taskId: string
  dispatchId: string
  file: ShowcaseFileItem
  inline: boolean
  onInline(on: boolean): void
  onView(): void
  /** Ссылка из markdown на другой файл показа (путь от корня показа). */
  onLink(path: string): void
}

function ShowcaseFile({ taskId, dispatchId, file, inline, onInline, onView, onLink }: FileProps): React.JSX.Element {
  const t = useT()
  const { error, act } = useAct()
  const [text, setText] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; el: HTMLElement } | null>(null)
  const Kind = FILE_KIND_ICON[file.view]
  const open = (): void => act((api) => api.open(taskId, file.path, dispatchId))
  const reveal = (): void => act((api) => api.reveal(taskId, file.path, dispatchId))
  const page = file.view === 'html' || file.view === 'markdown'
  const on = file.view === 'html' ? inline : text

  return (
    <li className={`showcase-file${file.view === 'none' ? ' dim' : ''}`}>
      <div className="showcase-file-head">
        <span className="sf-ic" title={fileKindLabel(t, file)}><Kind /></span>
        <div className="showcase-file-title" title={file.path}>
          <span className="showcase-file-name">{file.name}</span>
          {file.name !== file.path && <span className="showcase-file-path">{file.path}</span>}
        </div>
        {page && (
          <>
            <button type="button" className={`btn-text${on ? ' on' : ''}`} aria-expanded={on} onClick={() => (file.view === 'html' ? onInline(!inline) : setText((v) => !v))}>
              {on ? t('board.showcase.hide') : file.view === 'html' ? t('board.showcase.preview') : t('board.showcase.text')}
            </button>
            <button type="button" className="btn-sm icon" onClick={onView} title={t('board.showcase.fullscreen')} aria-label={t('board.showcase.fullscreen')}>
              <Icon.expand />
            </button>
            <button
              type="button"
              className="btn-sm icon"
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              title={t('board.showcase.moreActions')}
              aria-label={t('board.showcase.moreActions')}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.right - POPUP_MENU_WIDTH, y: r.bottom + 4, el: e.currentTarget })
              }}
            >
              <Icon.more />
            </button>
          </>
        )}
        {file.view === 'open' && (
          <>
            <button type="button" className="btn-sm" onClick={open} title={t('board.showcase.openTitle')}>{t('board.showcase.open')}</button>
            <button type="button" className="btn-sm" onClick={reveal}>{t('board.showcase.reveal')}</button>
          </>
        )}
      </div>
      {file.view === 'none' && <div className="muted showcase-note">{t('board.showcase.cantOpen')}</div>}
      {inline && file.view === 'html' && <InlinePreview dispatchId={dispatchId} file={file} onView={onView} />}
      {text && file.view === 'markdown' && <MarkdownPreview taskId={taskId} dispatchId={dispatchId} file={file} onLink={onLink} />}
      {error && <span className="error-text">{error}</span>}
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={t('board.showcase.moreActions')}
          items={[
            { id: 'open', label: t(file.view === 'html' ? 'board.showcase.viewer.openBrowser' : 'board.showcase.openSystem') },
            { id: 'reveal', label: t('board.showcase.revealLong') },
            { id: 'copy', label: t('board.showcase.viewer.copyPath') }
          ]}
          onPick={(id) => {
            setMenu(null)
            if (id === 'open') open()
            else if (id === 'reveal') reveal()
            else void navigator.clipboard.writeText(file.path).catch(() => {})
          }}
          onClose={(restore) => {
            if (restore) menu.el.focus()
            setMenu(null)
          }}
        />
      )}
    </li>
  )
}

/**
 * Мини-просмотрщик страницы в карточке: 360 px по высоте, «Десктоп» — обзор 1024 px с масштабом, «Телефон» — 375 px
 * без масштаба. Сеть всегда выключена; включить интернет-ресурсы можно только на весь экран.
 */
function InlinePreview({ dispatchId, file, onView }: { dispatchId: string; file: ShowcaseFileItem; onView(): void }): React.JSX.Element {
  const t = useT()
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop')
  const [reload, setReload] = useState(0)
  const [fit, setFit] = useState<FrameFit | null>(null)
  const { url, failure } = usePreviewUrl(dispatchId, file.path, false, reload)
  const vp = INLINE_VIEWPORTS[mode]
  return (
    <div className="sv-inl-wrap">
      <div className="sv-inl-bar">
        <div className="segmented" role="group" aria-label={t('board.showcase.inlineWidth')}>
          {(['desktop', 'mobile'] as const).map((m) => (
            <button key={m} type="button" className={`seg${mode === m ? ' active' : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'desktop' ? <Icon.desktop /> : <Icon.phone />}
              {t(`board.showcase.viewer.vp.${m}`)}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={() => setReload((n) => n + 1)} title={t('board.showcase.viewer.refreshTitle')} aria-label={t('board.showcase.viewer.refresh')}>
          <Icon.refresh />
        </button>
      </div>
      {failure ? (
        <span className="error-text">{failure.message}</span>
      ) : (
        <div className={`sv-inl${mode === 'mobile' ? ' mobile' : ''}${url ? '' : ' loading'}`} style={{ height: INLINE_FRAME_HEIGHT }}>
          {url && <PreviewFrame url={url} title={t('board.showcase.previewOf', { name: file.name })} viewport={vp} device="inline" reload={reload} onFit={setFit} />}
          <button type="button" className="sv-inl-expand" onClick={onView} title={t('board.showcase.fullscreen')}>
            <Icon.expand />{t('board.showcase.fullscreen')}
          </button>
        </div>
      )}
      {!failure && (
        <div className="sv-inl-cap">
          <span>{fit && (fit.scale < 0.995 ? t('board.showcase.fitted', { w: vp.width, pct: scalePercent(fit.scale) }) : t('board.showcase.fullWidth', { w: vp.width }))}</span>
          <span className="lock" title={t('board.showcase.viewer.isolatedTitle')}><Icon.lock /> {t('board.showcase.isolatedInline')}</span>
        </div>
      )}
    </div>
  )
}

interface ThumbGridProps {
  taskId: string
  dispatchId: string
  files: { file: ShowcaseFileItem; index: number }[]
  onView(index: number): void
}

/** Подряд идущие картинки — одна запись: сетка миниатюр 3 в ряд, больше шести — пять и «+N»; клик — просмотрщик. */
function ThumbGrid({ taskId, dispatchId, files, onView }: ThumbGridProps): React.JSX.Element {
  const t = useT()
  const { shown, more } = thumbsShown(files.length)
  return (
    <li className="showcase-file">
      <div className="showcase-file-head">
        <span className="sf-ic"><Icon.image /></span>
        <div className="showcase-file-title">
          <span className="showcase-file-name">{t('board.showcase.images', { count: files.length })}</span>
          <span className="showcase-file-path" title={files.map((f) => f.file.path).join('\n')}>{files.map((f) => f.file.name).join(', ')}</span>
        </div>
      </div>
      <div className="sv-thumbs">
        {files.slice(0, shown).map((f) => <Thumb key={f.file.path} taskId={taskId} dispatchId={dispatchId} file={f.file} onView={() => onView(f.index)} />)}
        {more > 0 && (
          <button type="button" className="sv-thumb more" onClick={() => onView(files[shown].index)} title={t('board.showcase.fullscreen')}>
            +{more}
          </button>
        )}
      </div>
    </li>
  )
}

function Thumb({ taskId, dispatchId, file, onView }: { taskId: string; dispatchId: string; file: ShowcaseFileItem; onView(): void }): React.JSX.Element {
  const t = useT()
  const { data, failure } = useShowcaseBytes(taskId, dispatchId, file.path)
  const url = useBlobUrl(data)
  return (
    <button type="button" className={`sv-thumb${failure ? ' failed' : ''}`} onClick={onView} title={failure ? failure.message : t('board.showcase.thumbTitle', { name: file.name })}>
      {url ? <img src={url} alt={file.name} /> : <span className="sv-thumb-ph" aria-hidden="true">{failure ? '!' : ''}</span>}
      <span className="cap">{file.name}</span>
    </button>
  )
}

interface MarkdownPreviewProps {
  taskId: string
  dispatchId: string
  file: ShowcaseFileItem
  onLink(path: string): void
}

/** «Текст» markdown в карточке: картинки из снимка показа (`useShowcaseMarkdownAssets`), ссылки на файлы — в просмотрщик. */
function MarkdownPreview({ taskId, dispatchId, file, onLink }: MarkdownPreviewProps): React.JSX.Element {
  const t = useT()
  const { data, failure } = useShowcaseBytes(taskId, dispatchId, file.path)
  const text = useMemo(() => (data ? new TextDecoder().decode(data.bytes) : null), [data])
  const assets = useShowcaseMarkdownAssets(dispatchId, file.path)
  if (failure) return <span className="error-text">{failure.message}</span>
  if (text === null || !assets) return <div className="muted showcase-note">{t('common.loading')}</div>
  return <Markdown text={text} className="showcase-md showcase-file-md" assets={assets} onShowcaseLink={onLink} />
}
