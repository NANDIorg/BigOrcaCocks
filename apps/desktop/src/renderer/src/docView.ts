// Просмотр файла в «Документах» (docs/design/docs-files/variant-1.html): решения без DOM и IPC — значок и подпись
// вида, режимы и кнопки по виду, строки кода, причина заглушки, сведения для строки статуса. Компоненты
// (DocViewer.tsx и соседи) только рисуют то, что решено здесь.
import type { DocStub, DocView } from '../../shared/ipc'
import { DOC_IMAGE_MAX_BYTES, DOC_TEXT_MAX_BYTES, docKindOf, type DocViewKind } from '../../shared/docs-view'
import { formatSize } from './docLinks'
import { longTime } from './docTree'
import { t } from './i18n'
import { formatShort } from './i18n/format'

/** Значок файла в дереве, выдаче и на заглушке — по виду (имена — ключи `DocIcon`). */
export type DocIconName = 'doc' | 'code' | 'config' | 'text' | 'html' | 'image' | 'pdf' | 'binary' | 'env' | 'file'

/** Языки «конфигов»: у них свой значок, чтобы `package.json` отличался в дереве от `index.ts`. */
const CONFIG_LANGUAGES = new Set(['JSON', 'YAML', 'TOML', 'INI', 'Config', 'Properties', 'XML', 'gitignore', 'gitattributes'])

/**
 * Значок по пути (дерево — без IPC) или по уточнённому виду из `docs:view` (`kind`): файл без расширения, который
 * main распознал как текст, получает значок текста, а не общий.
 */
export function docIconOf(path: string, kind?: DocViewKind): DocIconName {
  const byPath = docKindOf(path)
  const k = kind ?? byPath.kind
  if (k === 'markdown') return 'doc'
  if (k === 'html') return 'html'
  if (k === 'image') return 'image'
  if (k === 'pdf') return 'pdf'
  if (k === 'binary') return 'binary'
  if (k === 'unknown') return 'file'
  const language = byPath.kind === 'text' ? byPath.language : undefined
  if (language === 'dotenv') return 'env'
  if (language && CONFIG_LANGUAGES.has(language)) return 'config'
  return language ? 'code' : 'text'
}

const KIND_LABEL = {
  markdown: 'config.docs.kind.markdown',
  text: 'config.docs.kind.text',
  image: 'config.docs.kind.image',
  html: 'config.docs.kind.html',
  pdf: 'config.docs.kind.pdf',
  binary: 'config.docs.kind.binary',
  unknown: 'config.docs.kind.unknown'
} as const

/**
 * Подпись вида в строке статуса и на заглушке: язык по расширению («TypeScript», «SVG»), у картинки — формат
 * («PNG»), иначе — вид словами («Текст», «Бинарный»). Названия языков — имена собственные, не переводятся.
 */
export function docKindLabel(path: string, kind?: DocViewKind): string {
  const byPath = docKindOf(path)
  const k = kind ?? byPath.kind
  if (byPath.language && byPath.kind === k) return byPath.language
  if (k === 'image') {
    const dot = path.lastIndexOf('.')
    const ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1).toUpperCase() : ''
    if (ext) return ext === 'JPG' ? 'JPEG' : ext
  }
  return t(KIND_LABEL[k])
}

/**
 * Текст для `<pre>`: переводы строк `\r\n` и одиночный `\r` — в `\n`. CSS показывает `\r` пробелом, а не переносом:
 * файл со старыми маковскими переводами слился бы в одну строку, а номера строк разошлись бы с текстом.
 */
export function codeText(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

/**
 * Строк в тексте, как в редакторе: последний перевод строки новую строку не начинает (`"a\n"` — одна строка, в
 * `<pre>` она и видна одна). Пустой файл — 0.
 */
export function lineCount(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return text.endsWith('\n') ? n - 1 : n
}

/** Колонка номеров строк одним текстовым узлом: «1\n2\n…». У пустого файла — «1», как у редактора. */
export function gutterText(lines: number): string {
  const n = Math.max(1, lines)
  let out = '1'
  for (let i = 2; i <= n; i++) out += `\n${i}`
  return out
}

/**
 * Режимы показа: `doc`/`source` — markdown (рендер ⇄ исходник), `code`/`preview` — HTML, `image`/`code` — SVG.
 * Первый — по умолчанию: HTML открывается кодом (сайт на Vite/Next в изолированном фрейме пуст).
 */
export type DocMode = 'doc' | 'source' | 'code' | 'preview' | 'image'

/** Масштаб картинки: вписать в окно или 100 %. */
export type DocZoom = 'fit' | 'actual'

const SVG_MIME = 'image/svg+xml'

export function isSvgView(view: Pick<DocView, 'kind' | 'mime'>): boolean {
  return view.kind === 'image' && view.mime === SVG_MIME
}

/** Переключатель вида над просмотром; пусто — переключать нечего (код, картинка, заглушка). */
export function docModes(view: Pick<DocView, 'kind' | 'mime' | 'stub'>): readonly DocMode[] {
  if (view.stub) return []
  if (view.kind === 'markdown') return ['doc', 'source']
  if (view.kind === 'html') return ['code', 'preview']
  if (isSvgView(view)) return ['image', 'code']
  return []
}

/** Режим, который действительно показывается: недопустимый для вида (остался от прошлого файла) — по умолчанию. */
export function effectiveMode(view: Pick<DocView, 'kind' | 'mime' | 'stub'>, mode: DocMode | undefined): DocMode | undefined {
  const modes = docModes(view)
  return mode && modes.includes(mode) ? mode : modes[0]
}

/** В этом режиме показывается исходный текст (`CodeView`): нужен `view.text`. */
export function showsCode(view: Pick<DocView, 'kind' | 'mime' | 'stub'>, mode: DocMode | undefined): boolean {
  if (view.stub) return false
  const m = effectiveMode(view, mode)
  if (view.kind === 'text') return true
  return m === 'source' || m === 'code'
}

/**
 * Текст надо запросить отдельно (`docs:view` с `opts.source`): у HTML и SVG main без опции текста не отдаёт, у
 * markdown и кода он есть всегда.
 */
export function needsSourceText(view: DocView, mode: DocMode | undefined): boolean {
  return view.text === undefined && (view.kind === 'html' || isSvgView(view)) && showsCode(view, mode)
}

/** ⌘F по тексту есть у кода и у markdown в обоих режимах; у картинки, превью и заглушки — нет. */
export function docFindable(view: Pick<DocView, 'kind' | 'mime' | 'stub'>, mode: DocMode | undefined): boolean {
  if (view.stub) return false
  return view.kind === 'markdown' || showsCode(view, mode)
}

/** Масштаб «Вписать / 100 %» — только у картинки, показанной картинкой. */
export function docZoomable(view: Pick<DocView, 'kind' | 'mime' | 'stub'>, mode: DocMode | undefined): boolean {
  return !view.stub && view.kind === 'image' && effectiveMode(view, mode) !== 'code'
}

/** Действия с файлом: кнопки над просмотром, меню «⋯», кнопки заглушки. */
export type DocAction = 'copy' | 'copyAbs' | 'reveal' | 'open'

export interface DocActions {
  copy: boolean
  /** Абсолютный путь — только у источника «Проект»: корень worktree задачи человеку не нужен. */
  copyAbs: boolean
  reveal: boolean
  /** Только белый список (`DocView.openable`): `.sh`, `.app`, `.exe` приложение не запускает. */
  open: boolean
}

/** Какие действия доступны; вида ещё нет (грузится, ошибка) — без «Открыть». */
export function docActions(source: string, view: Pick<DocView, 'openable'> | undefined): DocActions {
  return { copy: true, copyAbs: source === 'project', reveal: true, open: view?.openable === true }
}

/** Заглушка: значок, заголовок, пояснение. `tone` — цвет значка. */
export interface DocStubInfo {
  icon: DocIconName
  tone: 'muted' | 'warn' | 'danger'
  title: string
  text: string
}

/** «1 МБ», «10 МБ»: лимит без «,0». */
function limitText(bytes: number): string {
  return t('config.docs.size.mb', { n: formatShort(bytes / 1024 / 1024, 1) })
}

/**
 * Заглушка для `view.stub`, а у PDF и бинарного вида без `stub` (старый или кривой ответ) — по виду: показать их
 * всё равно нечем. Лимит в тексте — тот, по которому main решил: картинка — `DOC_IMAGE_MAX_BYTES`, иначе текст.
 */
export function docStubOf(view: Pick<DocView, 'kind' | 'stub'>): DocStub | undefined {
  if (view.stub) return view.stub
  if (view.kind === 'pdf') return 'pdf'
  if (view.kind === 'binary') return 'binary'
  return undefined
}

export function docStubInfo(view: Pick<DocView, 'kind' | 'stub' | 'size'>, path: string): DocStubInfo | undefined {
  const stub = docStubOf(view)
  const size = formatSize(view.size)
  switch (stub) {
    case 'binary':
      return { icon: 'binary', tone: 'muted', title: t('config.docs.stub.binary.title'), text: t('config.docs.stub.binary.text') }
    case 'notUtf8':
      return { icon: 'text', tone: 'warn', title: t('config.docs.stub.notUtf8.title'), text: t('config.docs.stub.notUtf8.text') }
    case 'pdf':
      return { icon: 'pdf', tone: 'danger', title: t('config.docs.stub.pdf.title'), text: t('config.docs.stub.pdf.text') }
    case 'tooBig':
      return view.kind === 'image'
        ? { icon: 'image', tone: 'warn', title: t('config.docs.stub.tooBigImage.title'), text: t('config.docs.stub.tooBigImage.text', { limit: limitText(DOC_IMAGE_MAX_BYTES), size }) }
        : { icon: docIconOf(path, view.kind), tone: 'warn', title: t('config.docs.stub.tooBig.title'), text: t('config.docs.stub.tooBig.text', { limit: limitText(DOC_TEXT_MAX_BYTES), size }) }
    default:
      return undefined
  }
}

/** Пункт строки статуса; `optional` прячется на узком окне. */
export interface DocFact {
  key: 'type' | 'encoding' | 'lines' | 'dims' | 'zoom' | 'size' | 'modified' | 'isolated' | 'nowrap'
  text: string
  optional?: boolean
}

export interface DocStatusInput {
  path: string
  view: DocView
  mode: DocMode | undefined
  zoom: DocZoom
  /** Строк в показанном тексте (`lineCount`); текста нет — undefined. */
  lines?: number
  /** Натуральный размер картинки, когда она загрузилась. */
  dims?: { width: number; height: number }
  now: number
}

/**
 * Строка статуса под просмотром (вариант 1: сведения о файле внизу, у markdown — ещё и в оглавлении): тип,
 * кодировка и строки у текста, размеры и масштаб у картинки, размер и время у всех, «изолировано» у превью HTML.
 */
export function docStatusFacts({ path, view, mode, zoom, lines, dims, now }: DocStatusInput): DocFact[] {
  const out: DocFact[] = [{ key: 'type', text: docKindLabel(path, view.kind) }]
  const code = showsCode(view, mode)
  const text = code || (view.kind === 'markdown' && !view.stub)
  if (text) out.push({ key: 'encoding', text: 'UTF-8', optional: true })
  if (text && lines !== undefined) out.push({ key: 'lines', text: t('config.docs.view.lines', { count: lines }) })
  if (docZoomable(view, mode)) {
    if (dims) out.push({ key: 'dims', text: `${dims.width} × ${dims.height}` })
    out.push({ key: 'zoom', text: zoom === 'fit' ? t('config.docs.view.fitted') : t('config.docs.view.zoom.actual') })
  }
  out.push({ key: 'size', text: formatSize(view.size) })
  if (view.mtime > 0) out.push({ key: 'modified', text: t('config.docs.view.modified', { when: longTime(view.mtime, now) }), optional: true })
  if (view.kind === 'html' && effectiveMode(view, mode) === 'preview') out.push({ key: 'isolated', text: t('config.docs.view.isolated') })
  if (code) out.push({ key: 'nowrap', text: t('config.docs.view.nowrap'), optional: true })
  return out
}
