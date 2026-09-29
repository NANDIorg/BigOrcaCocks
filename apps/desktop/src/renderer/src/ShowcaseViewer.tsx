import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ShowcaseFileData } from '../../shared/ipc'
import { Markdown } from './Markdown'
import { PreviewFrame, usePreviewUrl } from './PreviewFrame'
import {
  clampShowcasePos, onShowcaseFrameEscape, scalePercent, showcaseApi, showcaseFailure, showcaseIndex, showcaseOrder, stepShowcase,
  SHOWCASE_VIEWPORT_ORDER, SHOWCASE_VIEWPORTS, type FrameFit, type ShowcaseFailure, type ShowcaseFileItem, type ShowcaseGroup,
  type ShowcasePos, type ShowcaseViewport
} from './showcase'
import { useT, type TKey } from './i18n'
import { Icon } from './icons'

/**
 * Решение по approval прямо в просмотрщике (вариант 2 макета): то же поле и те же действия, что в карточке
 * (RequestCard) — состояние поля общее, просмотрщик его только показывает.
 */
export interface ShowcaseDecision {
  value: string
  onChange(value: string): void
  onAccept(): void
  /** «Вернуть…»: замечания пишутся в карточке — просмотрщик закрывается, карточка открывает поле. */
  onReject(): void
  busy: boolean
}

interface Props {
  groups: ShowcaseGroup[]
  start: ShowcasePos
  decision?: ShowcaseDecision
  onClose(): void
}

type Api = ReturnType<typeof showcaseApi>
type Zoom = 'fit' | '100'

/** Значок вида файла в списке просмотрщика и в карточке. */
export const FILE_KIND_ICON: Record<ShowcaseFileItem['view'], () => React.JSX.Element> = {
  html: Icon.code,
  image: Icon.image,
  markdown: Icon.doc,
  open: Icon.doc,
  none: Icon.doc
}

/** Подпись вида файла в списке: «HTML», «Картинка»… */
export function fileKindLabel(t: ReturnType<typeof useT>, f: ShowcaseFileItem): string {
  return t(`board.showcase.kind.${f.view === 'open' ? 'pdf' : f.view}` as TKey)
}

/** Поле ввода: ←/→ и A/C в нём — текст, а не команды просмотрщика. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
}

/**
 * Просмотрщик показа (docs/design/showcase-viewer/variant-2.html): слева дерево «подзадачи → файлы», справа файл —
 * страница в изолированном фрейме с виртуальной шириной, картинка или markdown; внизу — решение по approval. В окне уже
 * 980 px список заменяется выпадающим списком в шапке (контейнерный запрос `.sv-host`). Esc закрывает только просмотрщик
 * (и когда фокус во фрейме — через `showcase:escape` из main), ←/→ листают файлы, фокус возвращается туда, откуда открыли.
 * «Интернет-ресурсы» выключены при каждом открытии: выбор живёт, пока открыт просмотрщик.
 */
export function ShowcaseViewer({ groups, start, decision, onClose }: Props): React.JSX.Element | null {
  const t = useT()
  const [pos, setPos] = useState<ShowcasePos>(start)
  const [side, setSide] = useState(true)
  const [viewport, setViewport] = useState<ShowcaseViewport>('desktop')
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [network, setNetwork] = useState(false)
  const [reload, setReload] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const at = clampShowcasePos(groups, pos)
  const order = useMemo(() => showcaseOrder(groups), [groups])
  const group = at ? groups[at.group] : undefined
  const file = at ? group?.files[at.file] : undefined
  const index = at ? showcaseIndex(groups, at) : -1

  // Свежие колбэки для подписок, которые не пересоздаются на каждый рендер.
  const latest = useRef({ onClose, decision, at })
  latest.current = { onClose, decision, at }

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => prev?.focus()
  }, [])

  useEffect(() => {
    const go = (delta: number): void => {
      const cur = latest.current.at
      if (cur) setPos(stepShowcase(groups, cur, delta))
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const d = latest.current.decision
      if (key === 'Escape') latest.current.onClose()
      else if (typing(e.target)) return
      else if (key === 'ArrowLeft' || key === 'ArrowUp') go(-1)
      else if (key === 'ArrowRight' || key === 'ArrowDown') go(1)
      else if (d && !d.busy && e.code === 'KeyA') {
        latest.current.onClose()
        d.onAccept()
      } else if (d && !d.busy && e.code === 'KeyC') {
        latest.current.onClose()
        d.onReject()
      } else return
      // A/C — по физической клавише (`code`): в русской раскладке тоже. Захват на window: раньше Инбокса и модалок под просмотрщиком, которые тоже слушают эти клавиши.
      e.stopImmediatePropagation()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    // Фокус во фрейме — keydown до окна не доходит; main присылает Esc отдельно (на каждый Esc, поэтому проверяем фокус).
    const offFrame = onShowcaseFrameEscape(window.orca, () => {
      const el = document.activeElement
      if (el instanceof HTMLIFrameElement && hostRef.current?.contains(el)) latest.current.onClose()
    })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      offFrame()
    }
  }, [groups])

  // Смена файла: прежняя ошибка действия и масштаб картинки к нему не относятся; выбранный — в видимой части списка.
  useEffect(() => {
    setActionError(null)
    setZoom('fit')
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at?.group, at?.file])

  if (!at || !group || !file) return null

  const act = (fn: (api: Api) => Promise<void>): void => {
    setActionError(null)
    try {
      fn(showcaseApi(window.orca)).catch((e: unknown) => setActionError(showcaseFailure(e).message))
    } catch (e) {
      setActionError(showcaseFailure(e).message)
    }
  }
  const open = (): void => act((api) => api.open(group.taskId, file.path, group.dispatchId))
  const reveal = (): void => act((api) => api.reveal(group.taskId, file.path, group.dispatchId))
  const copyPath = (): void => void navigator.clipboard.writeText(file.path).catch(() => {})
  const refresh = (): void => setReload((n) => n + 1)
  const multi = groups.length > 1
  const live = file.view === 'html' || file.view === 'image' || file.view === 'markdown'

  const list = groups.map((g, gi) => (
    <div key={g.dispatchId} role="group" aria-label={g.title}>
      {multi && g.title && <div className="sv-lg" title={g.title}><span className="t">{g.title}</span></div>}
      {g.files.map((f, fi) => {
        const Kind = FILE_KIND_ICON[f.view]
        const selected = gi === at.group && fi === at.file
        return (
          <button
            key={f.path}
            type="button"
            role="option"
            aria-selected={selected}
            className={`sv-li${f.view === 'none' ? ' dim' : ''}`}
            title={f.path}
            onClick={() => setPos({ group: gi, file: fi })}
          >
            <span className="k"><Kind /></span>
            <span className="txt">
              <span className="nm">{f.name}</span>
              <span className="mt">{fileKindLabel(t, f)}</span>
            </span>
            {f.view === 'none' && <span className="flag lock" title={t('board.showcase.viewer.cantOpenShort')} aria-label={t('board.showcase.viewer.cantOpenShort')}><Icon.lock /></span>}
          </button>
        )
      })}
    </div>
  ))

  const toolbarLeft = (
    <>
      {file.view === 'html' && (
        <div className="segmented sv-seg" role="group" aria-label={t('board.showcase.viewer.width')}>
          {SHOWCASE_VIEWPORT_ORDER.map((v) => {
            const label = t(`board.showcase.viewer.vp.${v}` as TKey)
            const w = SHOWCASE_VIEWPORTS[v].width
            return (
              <button
                key={v}
                type="button"
                className={`seg${viewport === v ? ' active' : ''}`}
                aria-pressed={viewport === v}
                title={t('board.showcase.viewer.vpTitle', { label, w })}
                aria-label={t('board.showcase.viewer.vpTitle', { label, w })}
                onClick={() => setViewport(v)}
              >
                {v === 'mobile' ? <Icon.phone /> : v === 'tablet' ? <Icon.tablet /> : <Icon.desktop />}
                <span className="lbl">{label}</span>
                <span className="w">{w}</span>
              </button>
            )
          })}
        </div>
      )}
      {file.view === 'image' && (
        <div className="segmented sv-seg" role="group" aria-label={t('board.showcase.viewer.zoom')}>
          {(['fit', '100'] as const).map((z) => (
            <button key={z} type="button" className={`seg${zoom === z ? ' active' : ''}`} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              {t(z === 'fit' ? 'board.showcase.viewer.zoomFit' : 'board.showcase.viewer.zoom100')}
            </button>
          ))}
        </div>
      )}
      {live && (
        <button type="button" className="icon-btn" onClick={refresh} title={t('board.showcase.viewer.refreshTitle')} aria-label={t('board.showcase.viewer.refresh')}>
          <Icon.refresh />
        </button>
      )}
      {file.view === 'html' && (
        <button
          type="button"
          className="sv-net"
          role="switch"
          aria-checked={network}
          aria-label={t('board.showcase.viewer.network')}
          title={t('board.showcase.viewer.networkTitle')}
          onClick={() => setNetwork((v) => !v)}
        >
          <span className={`switch${network ? ' on' : ''}`} aria-hidden="true" />
          <span className="lbl">{t('board.showcase.viewer.network')}</span>
          <span className="lbl-s">{t('board.showcase.viewer.networkShort')}</span>
          <b>{t(network ? 'board.showcase.viewer.on' : 'board.showcase.viewer.off')}</b>
        </button>
      )}
    </>
  )
  const toolbarRight = file.view !== 'none' && (
    <>
      <button type="button" className="btn-sm" onClick={open} aria-label={t(file.view === 'html' ? 'board.showcase.viewer.openBrowser' : 'board.showcase.open')} title={t(file.view === 'html' ? 'board.showcase.viewer.openBrowserTitle' : 'board.showcase.openTitle')}>
        <Icon.external />
        <span className="sv-btn-lbl">{t(file.view === 'html' ? 'board.showcase.viewer.openBrowser' : 'board.showcase.open')}</span>
      </button>
      <button type="button" className="btn-text" onClick={reveal} aria-label={t('board.showcase.reveal')} title={t('board.showcase.viewer.revealTitle')}>
        <Icon.folder />
        <span className="sv-btn-lbl">{t('board.showcase.reveal')}</span>
      </button>
    </>
  )

  return createPortal(
    <div ref={hostRef} className="modal-backdrop sv-host" onClick={onClose}>
      <div
        className={`modal sv-modal${side ? '' : ' side-off'}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('board.showcase.viewer.label', { name: file.name })}
        onClick={(e) => e.stopPropagation()}
      >
        {side && (
          <aside className="sv-side" aria-label={t('board.showcase.viewer.files')}>
            <div className="sv-side-head">
              <span className="ttl">{t('board.showcase.title')}</span>
              <span className="muted">{t('board.card.files', { count: order.length })}</span>
            </div>
            <div ref={listRef} className="sv-list" role="listbox" aria-label={t('board.showcase.viewer.files')}>
              {list}
            </div>
            <div className="sv-side-foot">
              <span className="sv-kbdhint"><kbd>←</kbd><kbd>→</kbd> {t('board.showcase.viewer.hintFile')} <kbd>Esc</kbd> {t('board.showcase.viewer.hintClose')}</span>
            </div>
          </aside>
        )}
        <section className="sv-main">
          <div className="sv-mhead">
            <button
              type="button"
              className="icon-btn sv-sidebtn"
              aria-pressed={side}
              title={t('board.showcase.viewer.files')}
              aria-label={t('board.showcase.viewer.files')}
              onClick={() => setSide((v) => !v)}
            >
              <Icon.sidebar />
            </button>
            <label className="sv-fsel">
              <span className="sr-only">{t('board.showcase.viewer.file')}</span>
              <select
                value={`${at.group}:${at.file}`}
                onChange={(e) => {
                  const [g, f] = e.target.value.split(':').map(Number)
                  setPos({ group: g, file: f })
                }}
              >
                {groups.map((g, gi) => {
                  const options = g.files.map((f, fi) => <option key={f.path} value={`${gi}:${fi}`}>{f.name}</option>)
                  return multi ? <optgroup key={g.dispatchId} label={g.title ?? ''}>{options}</optgroup> : options
                })}
              </select>
            </label>
            <div className="ttl">
              <h3 title={file.path}>{file.name}</h3>
              <div className="pth" title={t('board.showcase.viewer.pathTitle')}>{multi && group.title ? `${group.title} · ${file.path}` : file.path}</div>
            </div>
            <div className="sv-nav">
              <button type="button" className="icon-btn" disabled={index <= 0} onClick={() => setPos(stepShowcase(groups, at, -1))} title={t('board.showcase.viewer.prev')} aria-label={t('board.showcase.viewer.prev')}>
                <Icon.chevronLeft />
              </button>
              <span className="chip mono">{index + 1} / {order.length}</span>
              <button type="button" className="icon-btn" disabled={index >= order.length - 1} onClick={() => setPos(stepShowcase(groups, at, 1))} title={t('board.showcase.viewer.next')} aria-label={t('board.showcase.viewer.next')}>
                <Icon.chevron />
              </button>
            </div>
            <button ref={closeRef} type="button" className="icon-btn task-modal-close" onClick={onClose} title={t('board.showcase.viewer.closeTitle')} aria-label={t('common.close')}>
              <Icon.close />
            </button>
          </div>
          {(live || file.view === 'open') && (
            <div className="sv-toolbar">
              {toolbarLeft}
              <span className="grow" />
              {toolbarRight}
            </div>
          )}
          {actionError && <div className="sv-action-error error-text" role="alert">{actionError}</div>}
          <ViewerCanvas
            key={`${group.dispatchId}:${file.path}`}
            group={group}
            file={file}
            viewport={viewport}
            zoom={zoom}
            network={network}
            reload={reload}
            onRetry={refresh}
            onOpen={open}
            onReveal={reveal}
            onCopy={copyPath}
          />
          {decision && (
            <div className="sv-decide" role="group" aria-label={t('board.showcase.viewer.decision')}>
              <label className="dec">
                <span className="sr-only">{t('shell.request.decisionLabel')}</span>
                <input
                  value={decision.value}
                  placeholder={t('shell.request.approvalPlaceholder')}
                  disabled={decision.busy}
                  onChange={(e) => decision.onChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    onClose()
                    decision.onAccept()
                  }}
                />
              </label>
              {live && (
                <button type="button" className="btn-sm" disabled={decision.busy} onClick={() => decision.onChange(file.name)} title={t('board.showcase.viewer.pickTitle')}>
                  <Icon.check />{t('board.showcase.viewer.pick')}
                </button>
              )}
              <span className="grow" />
              <button type="button" className="btn-sm" disabled={decision.busy} onClick={() => { onClose(); decision.onReject() }} title={t('board.showcase.viewer.rejectTitle')}>
                <kbd className="rq-kbd">C</kbd>{t('shell.request.rejectMore')}
              </button>
              <button type="button" className="btn-sm primary" disabled={decision.busy} onClick={() => { onClose(); decision.onAccept() }} title={t('shell.request.acceptHint')}>
                <kbd className="rq-kbd">A</kbd>{t('shell.request.accept')}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>,
    document.body
  )
}

interface CanvasProps {
  group: ShowcaseGroup
  file: ShowcaseFileItem
  viewport: ShowcaseViewport
  zoom: Zoom
  network: boolean
  reload: number
  onRetry(): void
  onOpen(): void
  onReveal(): void
  onCopy(): void
}

/** Тело просмотрщика по виду файла: страница, картинка, markdown или состояние («PDF — в приложении системы», «не открывается»). */
function ViewerCanvas(props: CanvasProps): React.JSX.Element {
  const { file } = props
  if (file.view === 'html') return <PageCanvas {...props} />
  if (file.view === 'image') return <ImageCanvas {...props} />
  if (file.view === 'markdown') return <MarkdownCanvas {...props} />
  return (
    <div className="sv-canvas center">
      {file.view === 'open'
        ? <ViewerState kind="external" {...props} />
        : <ViewerState kind="unsupported" {...props} />}
    </div>
  )
}

function PageCanvas({ group, file, viewport, network, reload, ...rest }: CanvasProps): React.JSX.Element {
  const t = useT()
  const { url, failure } = usePreviewUrl(group.dispatchId, file.path, network, reload)
  const [fit, setFit] = useState<FrameFit | null>(null)
  const vp = SHOWCASE_VIEWPORTS[viewport]
  if (failure) return <div className="sv-canvas center"><ViewerState kind={failure.kind} failure={failure} group={group} file={file} {...rest} /></div>
  if (!url) return <div className="sv-canvas center"><ViewerLoading file={file} /></div>
  return (
    <div className="sv-canvas">
      <div className="sv-devlabel">
        <b>{t(`board.showcase.viewer.vp.${viewport}` as TKey)}</b>
        {fit && <span>{t('board.showcase.viewer.scale', { w: vp.width, pct: scalePercent(fit.scale) })}</span>}
        <span className="lock" title={t('board.showcase.viewer.isolatedTitle')}><Icon.lock /> {t('board.showcase.viewer.isolated')}</span>
        {network && <b className="sv-net-on">{t('board.showcase.viewer.networkOn')}</b>}
      </div>
      <PreviewFrame url={url} title={t('board.showcase.viewer.frameTitle', { name: file.name })} viewport={vp} device={viewport} reload={reload} onFit={setFit} />
    </div>
  )
}

/** Байты картинки или markdown из main (`showcase:read`, со снимком — из него). `reload` — перечитать. */
export function useShowcaseBytes(taskId: string, dispatchId: string | undefined, path: string, reload = 0): { data?: ShowcaseFileData; failure?: ShowcaseFailure } {
  const [state, setState] = useState<{ data?: ShowcaseFileData; failure?: ShowcaseFailure }>({})
  useEffect(() => {
    let alive = true
    setState({})
    try {
      showcaseApi(window.orca).read(taskId, path, dispatchId).then(
        (data) => alive && setState({ data }),
        (e: unknown) => alive && setState({ failure: showcaseFailure(e) })
      )
    } catch (e) {
      setState({ failure: showcaseFailure(e) })
    }
    return () => {
      alive = false
    }
  }, [taskId, dispatchId, path, reload])
  return state
}

/** `blob:` URL байтов картинки (CSP renderer пускает `blob:`); отзывается при смене данных. */
export function useBlobUrl(data: ShowcaseFileData | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!data) return
    // Копия в свой ArrayBuffer: Blob не принимает view на SharedArrayBuffer (так типизирован Uint8Array из IPC).
    const u = URL.createObjectURL(new Blob([new Uint8Array(data.bytes)], { type: data.mime }))
    setUrl(u)
    return () => {
      URL.revokeObjectURL(u)
      setUrl(null)
    }
  }, [data])
  return url
}

function ImageCanvas({ group, file, zoom, reload, ...rest }: CanvasProps): React.JSX.Element {
  const { data, failure } = useShowcaseBytes(group.taskId, group.dispatchId, file.path, reload)
  const url = useBlobUrl(data)
  if (failure) return <div className="sv-canvas center"><ViewerState kind={failure.kind} failure={failure} group={group} file={file} {...rest} /></div>
  if (!url) return <div className="sv-canvas center"><ViewerLoading file={file} /></div>
  return (
    <div className="sv-canvas pad0">
      <div className={`sv-imgc${zoom === '100' ? ' z100' : ''}`}>
        <img src={url} alt={file.name} />
      </div>
    </div>
  )
}

function MarkdownCanvas({ group, file, reload, ...rest }: CanvasProps): React.JSX.Element {
  const { data, failure } = useShowcaseBytes(group.taskId, group.dispatchId, file.path, reload)
  const text = useMemo(() => (data ? new TextDecoder().decode(data.bytes) : null), [data])
  if (failure) return <div className="sv-canvas center"><ViewerState kind={failure.kind} failure={failure} group={group} file={file} {...rest} /></div>
  if (text === null) return <div className="sv-canvas center"><ViewerLoading file={file} /></div>
  return (
    <div className="sv-canvas pad0">
      <div className="sv-mdc">
        <Markdown text={text} variant="doc" />
      </div>
    </div>
  )
}

function ViewerLoading({ file }: { file: ShowcaseFileItem }): React.JSX.Element {
  const t = useT()
  return (
    <div className="sv-state" role="status" aria-live="polite">
      <div className="sv-skel" aria-hidden="true"><i className="h" /><i style={{ width: '70%' }} /><i style={{ width: '88%' }} /><i style={{ width: '52%' }} /></div>
      <div className="sv-state-title">{t('board.showcase.viewer.loading', { name: file.name })}</div>
    </div>
  )
}

type StateKind = ShowcaseFailure['kind'] | 'external' | 'unsupported'

interface StateProps {
  kind: StateKind
  failure?: ShowcaseFailure
  group: ShowcaseGroup
  file: ShowcaseFileItem
  onRetry(): void
  onOpen(): void
  onReveal(): void
  onCopy(): void
}

/** Состояния из таблицы README макетов: что видит человек и какие действия ему остаются. */
export function ViewerState({ kind, failure, file, onRetry, onOpen, onReveal, onCopy }: StateProps): React.JSX.Element {
  const t = useT()
  const tone = kind === 'missing' || kind === 'error' ? 'err' : kind === 'big' || kind === 'stale' ? 'warn' : ''
  const retry = <button type="button" className="btn-sm" onClick={onRetry}><Icon.refresh />{t('board.showcase.viewer.retry')}</button>
  const copy = <button type="button" className="btn-sm" onClick={onCopy}>{t('board.showcase.viewer.copyPath')}</button>
  const openBtn = <button type="button" className="btn-sm primary" onClick={onOpen}><Icon.external />{t('board.showcase.open')}</button>
  const revealBtn = <button type="button" className="btn-sm" onClick={onReveal}><Icon.folder />{t('board.showcase.reveal')}</button>
  const path = <span className="sv-path">{file.path}</span>
  const body: Record<StateKind, { title: string; text?: React.ReactNode; acts?: React.ReactNode }> = {
    missing: { title: t('board.showcase.viewer.missing'), text: <p>{failure?.message}</p>, acts: <>{retry}{copy}</> },
    big: { title: t('board.showcase.viewer.big'), text: <p>{failure?.message}</p>, acts: <>{openBtn}{revealBtn}</> },
    stale: { title: t('board.showcase.viewer.staleTitle'), text: <p>{failure?.message ?? t('board.showcase.viewer.stale')}</p> },
    error: { title: t('board.showcase.viewer.error'), text: <p className="error-text">{failure?.message}</p>, acts: retry },
    external: { title: t('board.showcase.viewer.pdf'), text: <p>{t('board.showcase.viewer.pdfText')}</p>, acts: <>{openBtn}{revealBtn}</> },
    unsupported: { title: t('board.showcase.viewer.unsupported'), text: <p>{t('board.showcase.cantOpen')}</p>, acts: copy }
  }
  const b = body[kind]
  return (
    <div className={`sv-state ${tone}`} role={tone ? 'alert' : 'status'}>
      <div className="sv-state-title">{b.title}</div>
      {kind !== 'stale' && path}
      {b.text}
      {b.acts && <div className="acts">{b.acts}</div>}
    </div>
  )
}
