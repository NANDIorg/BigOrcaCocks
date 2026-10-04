import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import type { DocView } from '../shared/ipc'
import type { DocViewKind } from '../shared/docs-view'
import { CodeView } from './CodeView'
import { DocHtml } from './DocHtml'
import { DocImage } from './DocImage'
import { DocLoading, DocStub } from './DocStub'
import { Markdown } from './Markdown'
import { PopupMenu, POPUP_MENU_WIDTH, type PopupItem } from './PopupMenu'
import { DocFileIcon, DocIcon } from './docsIcons'
import {
  codeText,
  docFindable,
  docModes,
  docStatusFacts,
  docStubOf,
  docZoomable,
  effectiveMode,
  lineCount,
  type DocAction,
  type DocActions,
  type DocMode,
  type DocZoom
} from './docView'
import { useDocMarkdownAssets, useDocSourceText } from './docViewApi'
import { useT } from './i18n'
import './docs-viewers.css'

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export interface DocViewerProps {
  /** `'project'` или id задачи в работе — как в `docs:*`. */
  source: string
  /** Путь от корня источника, через `/`. */
  path: string
  /** Ответ `docs:view` для этого файла. */
  view: DocView
  /** Выбранный режим (`docModes`); не подходит виду или не задан — по умолчанию. */
  mode?: DocMode
  zoom: DocZoom
  /** Растёт по «Обновить»: перечитать картинку, исходник, адрес превью. */
  reload: number
  now: number
  actions: DocActions
  /** Корень текста для ⌘F (`findInDoc`): `<article>` у markdown, `<code>` у кода. */
  textRef?: React.Ref<HTMLElement>
  /** Прокручиваемая область просмотра — для `scrollToRange` и прокрутки в истории. */
  scrollRef?: React.Ref<HTMLDivElement>
  onScroll?(e: React.UIEvent<HTMLDivElement>): void
  /** Над содержимым: ошибка `docs-err`, «также изменён в задаче». У markdown — внутри прокрутки, как раньше. */
  notices?: React.ReactNode
  /** Ссылка markdown на файл того же источника (путь от корня) и её `#якорь`. Внешние ссылки открывает браузер. */
  onLink(path: string, hash?: string): void
  onAction(action: DocAction): void
  /** «Повторить» у ошибки загрузки картинки, исходника или превью. */
  onRetry?(): void
  /** Натуральный размер картинки — для строки статуса. */
  onImageDims?(dims: { width: number; height: number } | undefined): void
}

/**
 * Просмотр одного файла «Документов» по `view.kind` (docs/design/docs-files/variant-1.html): markdown — документ или
 * исходник, код и конфиги — `CodeView`, картинка — `DocImage` (SVG ещё и кодом), HTML — `DocHtml` (код ⇄ превью), PDF,
 * бинарный и всё, что показать нельзя, — `DocStub`. Данные — пропсами; API зовут только хуки `docViewApi.ts`
 * (байты картинки, исходник HTML/SVG, адрес превью). Панель режимов — `DocViewControls`, сведения — `DocStatus`.
 */
export function DocViewer(props: DocViewerProps): React.JSX.Element {
  const { source, path, view, now, actions, onAction, onRetry, notices } = props
  const mode = effectiveMode(view, props.mode)
  const name = nameOf(path)
  const code = useDocSourceText(source, path, view, mode, props.reload)
  const noticeBar = notices ? <div className="docs-notices">{notices}</div> : null
  if (docStubOf(view)) return <>{noticeBar}<DocStub path={path} view={view} now={now} actions={actions} onAction={onAction} /></>

  const codeView = (): React.JSX.Element => {
    if (code.failure) return <DocStub path={path} failure={code.failure} now={now} actions={actions} onAction={onAction} onRetry={onRetry} />
    if (code.data === undefined) return <DocLoading name={name} />
    return <CodeView text={code.data} name={name} path={path} codeRef={props.textRef} scrollRef={props.scrollRef} onScroll={props.onScroll} />
  }

  let body: React.JSX.Element
  if (view.kind === 'markdown' && mode === 'doc') {
    return <MarkdownDoc {...props} text={view.text ?? ''} name={name} />
  } else if (view.kind === 'html') {
    body = (
      <DocHtml
        source={source}
        path={path}
        name={name}
        mode={mode === 'preview' ? 'preview' : 'code'}
        code={code}
        reload={props.reload}
        now={now}
        actions={actions}
        onAction={onAction}
        onRetry={onRetry}
        codeRef={props.textRef}
        scrollRef={props.scrollRef}
        onScroll={props.onScroll}
      />
    )
  } else if (view.kind === 'image' && mode !== 'code') {
    body = <DocImage source={source} path={path} name={name} zoom={props.zoom} reload={props.reload} now={now} actions={actions} onAction={onAction} onRetry={onRetry} onDims={props.onImageDims} />
  } else {
    body = codeView()
  }
  return <>{noticeBar}{body}</>
}

/** Markdown-документ: как раньше (`<Markdown variant="doc">` в `.docs-article`), плюс картинки и ссылки проекта. */
function MarkdownDoc({ source, path, text, name, reload, textRef, scrollRef, onScroll, notices, onLink }: DocViewerProps & { text: string; name: string }): React.JSX.Element {
  const assets = useDocMarkdownAssets(source, path, text, reload)
  if (!assets) return <DocLoading name={name} />
  return (
    <div className="docs-body" ref={scrollRef} onScroll={onScroll}>
      {notices}
      <article className="docs-article" ref={textRef}>
        <Markdown text={text} variant="doc" assets={assets} onShowcaseLink={onLink} />
      </article>
    </div>
  )
}

/** Значок файла по виду — дерево, выдача поиска, крошки. `kind` — уточнённый вид из `docs:view`, если он есть. */
export function DocKindIcon({ path, kind }: { path: string; kind?: DocViewKind }): React.JSX.Element {
  return <DocFileIcon path={path} kind={kind} />
}

interface ControlsProps {
  view: DocView
  mode?: DocMode
  zoom: DocZoom
  findOpen: boolean
  onMode(mode: DocMode): void
  onZoom(zoom: DocZoom): void
  /** «Обновить превью» — только у HTML в режиме превью. */
  onReloadPreview(): void
  onFind(): void
}

const MODE_LABEL = {
  doc: 'config.docs.view.mode.doc',
  source: 'config.docs.view.mode.source',
  code: 'config.docs.view.mode.code',
  preview: 'config.docs.view.mode.preview',
  image: 'config.docs.view.mode.image'
} as const

/**
 * Переключатели над просмотром (в строке крошек): «Документ ⇄ Исходник», «Код ⇄ Превью» (+ «Обновить превью»),
 * у SVG «Картинка ⇄ Код», «Вписать / 100 %», «Поиск в файле». Чего у вида нет, того нет и на панели.
 */
export function DocViewControls({ view, mode, zoom, findOpen, onMode, onZoom, onReloadPreview, onFind }: ControlsProps): React.JSX.Element | null {
  const t = useT()
  const modes = docModes(view)
  const current = effectiveMode(view, mode)
  const zoomable = docZoomable(view, mode)
  const findable = docFindable(view, mode)
  const preview = view.kind === 'html' && current === 'preview'
  if (!modes.length && !zoomable && !findable) return null
  const modeAria = view.kind === 'markdown' ? t('config.docs.view.modeAria.markdown') : view.kind === 'html' ? t('config.docs.view.modeAria.html') : t('config.docs.view.modeAria.image')
  return (
    <span className="docs-ctl">
      {modes.length > 0 && (
        <span className="seg2" role="group" aria-label={modeAria}>
          {modes.map((m) => (
            <button key={m} type="button" className={m === current ? 'on' : ''} aria-pressed={m === current} onClick={() => onMode(m)}>
              {m === 'preview' && <DocIcon.eye />}
              {t(MODE_LABEL[m])}
            </button>
          ))}
        </span>
      )}
      {preview && (
        <button type="button" className="icon-btn docs-tool" title={t('config.docs.view.refreshPreview')} aria-label={t('config.docs.view.refreshPreview')} onClick={onReloadPreview}><DocIcon.refresh /></button>
      )}
      {zoomable && (
        <span className="seg2" role="group" aria-label={t('config.docs.view.zoomAria')}>
          <button type="button" className={zoom === 'fit' ? 'on' : ''} aria-pressed={zoom === 'fit'} onClick={() => onZoom('fit')}><DocIcon.fit />{t('config.docs.view.zoom.fit')}</button>
          <button type="button" className={zoom === 'actual' ? 'on' : ''} aria-pressed={zoom === 'actual'} onClick={() => onZoom('actual')}>{t('config.docs.view.zoom.actual')}</button>
        </span>
      )}
      {findable && (
        <button type="button" className={`icon-btn docs-tool ${findOpen ? 'on' : ''}`} title={t('config.docs.view.find')} aria-label={t('config.docs.view.findAria')} aria-pressed={findOpen} onClick={onFind}><DocIcon.findIn /></button>
      )}
    </span>
  )
}

/**
 * Меню «⋯» действий с файлом (из варианта 2): копировать путь (и абсолютный — у проекта), показать в папке, открыть
 * приложением системы. «Открыть» для файла не из белого списка — неактивный пункт с причиной, а не пропажа.
 */
export function DocActionsMenu({ actions, onAction }: { actions: DocActions; onAction(action: DocAction): void }): React.JSX.Element {
  const t = useT()
  const btnRef = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const items: PopupItem[] = [
    { id: 'copy', label: t('config.docs.view.copyPath'), icon: <DocIcon.copy /> },
    ...(actions.copyAbs ? [{ id: 'copyAbs', label: t('config.docs.view.copyAbsPath'), icon: <DocIcon.copy /> }] : []),
    { id: 'reveal', label: t('config.docs.view.reveal'), icon: <DocIcon.reveal />, separatorBefore: true },
    actions.open
      ? { id: 'open', label: t('config.docs.view.open'), icon: <DocIcon.external /> }
      : { id: 'open', label: t('config.docs.view.openNo'), icon: <DocIcon.external />, disabled: true }
  ]
  const toggle = (): void => {
    if (at) return setAt(null)
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setAt({ x: r.right - POPUP_MENU_WIDTH, y: r.bottom + 4 })
  }
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`icon-btn docs-tool ${at ? 'on' : ''}`}
        title={t('config.docs.view.more')}
        aria-label={t('config.docs.view.more')}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={toggle}
      >
        <DocIcon.more />
      </button>
      {at && (
        <PopupMenu
          x={at.x}
          y={at.y}
          ariaLabel={t('config.docs.view.more')}
          items={items}
          onPick={(id) => {
            setAt(null)
            if (id === 'copy' || id === 'copyAbs' || id === 'reveal' || id === 'open') onAction(id)
          }}
          onClose={(restore) => {
            setAt(null)
            if (restore) btnRef.current?.focus()
          }}
        />
      )}
    </>
  )
}

interface StatusProps {
  path: string
  view: DocView
  mode?: DocMode
  zoom: DocZoom
  now: number
  dims?: { width: number; height: number }
}

/**
 * Строка статуса под просмотром (вариант 1): тип, кодировка, строки, размер, время; у картинки — размеры и масштаб,
 * у превью HTML — «изолировано, без сети». У заглушки сведения уже на ней — строки нет.
 */
export function DocStatus({ path, view, mode, zoom, now, dims }: StatusProps): React.JSX.Element | null {
  const t = useT()
  const lines = useMemo(() => (view.text === undefined ? undefined : lineCount(codeText(view.text))), [view.text])
  if (docStubOf(view)) return null
  const facts = docStatusFacts({ path, view, mode, zoom, now, ...(lines !== undefined ? { lines } : {}), ...(dims ? { dims } : {}) })
  return (
    <div className="docs-status" role="group" aria-label={t('config.docs.view.statusAria')}>
      {facts.map((f) => (
        <span key={f.key} className={`it${f.optional ? ' opt' : ''}${f.key === 'isolated' ? ' iso' : ''}`}>
          {f.key === 'isolated' && <DocIcon.lock />}
          {f.key === 'modified' && <DocIcon.clock />}
          {f.key === 'type' ? <b>{f.text}</b> : f.text}
        </span>
      ))}
    </div>
  )
}
