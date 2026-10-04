import { getUiApi } from './host'
// Каналы просмотра файлов «Документов» (`docs:view`, `docs:bytes`, `docs:previewUrl`) для renderer: проверка, что они
// есть, ошибки по коду и хуки загрузки. Методы появились позже `docs:list`/`docs:read`: в `pnpm dev` после HMR
// renderer новый, а preload и main — старые, поэтому всё идёт через `docViewApi()`, а не `getUiApi().docs.view`.
import { useEffect, useMemo, useState } from 'react'
import type { DocBytes, DocView, DocViewOptions, OrcaApi } from '../shared/ipc'
import { hasMarkdownImages, type MarkdownAssets } from './markdownAssets'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'
import { isPreviewUrl } from './showcase'
import { needsSourceText, type DocMode } from './docView'
import { t } from './i18n'

export interface DocViewApi {
  view(source: string, path: string, opts?: DocViewOptions): Promise<DocView>
  bytes(source: string, path: string): Promise<DocBytes>
  previewUrl(source: string, path: string): ReturnType<NonNullable<OrcaApi['docs']['previewUrl']>>
}

/** Старый preload без новых методов: просмотрщик говорит «перезапустите приложение», а не падает. */
export class DocViewStaleError extends Error {
  constructor() {
    super(t('config.docs.view.staleText'))
    this.name = 'DocViewStaleError'
  }
}

/** Новые методы `docs.*` или `DocViewStaleError`. Хендлера нет в старом main — это уже ошибка invoke (`docViewFailure`). */
export function docViewApi(api: Partial<OrcaApi> | undefined): DocViewApi {
  const docs = api?.docs
  const view = docs?.view
  const bytes = docs?.bytes
  const previewUrl = docs?.previewUrl
  if (typeof view !== 'function' || typeof bytes !== 'function' || typeof previewUrl !== 'function') throw new DocViewStaleError()
  return {
    view: (source, path, opts) => view(source, path, opts),
    bytes: (source, path) => bytes(source, path),
    previewUrl: (source, path) => previewUrl(source, path)
  }
}

/** Есть ли в preload просмотр любых файлов. Нет — окно работает по-старому: только `.md` через `docs:read`. */
export function hasDocView(api: Partial<OrcaApi> | undefined): boolean {
  try {
    docViewApi(api)
    return true
  } catch {
    return false
  }
}

/**
 * Почему файл не показан: `stale` — старый main/preload; `missing` — файла уже нет; `outside` — путь или цель симлинка
 * вне источника; `notFile` — папка, FIFO; `error` — остальное (доступ, ввод-вывод, нет превью).
 */
export type DocViewFailureKind = 'stale' | 'missing' | 'outside' | 'notFile' | 'error'

export interface DocViewFailure {
  kind: DocViewFailureKind
  /** Код `OrcaError` из main, если он был. */
  code?: string
  /** Короткий заголовок по коду — на языке интерфейса. */
  title: string
  /** Текст из main (уже переведён, с путём) или пояснение renderer. */
  message: string
}

/** Код ошибки → вид и заголовок. Коды — `PROJECT_FILES_ERROR_CODES`, `DOC_VIEW_ERROR_CODES` и `docs.noTaskSource`. */
const BY_CODE: Readonly<Record<string, { kind: DocViewFailureKind; title: () => string }>> = {
  'files.notFound': { kind: 'missing', title: () => t('config.docs.err.file.notFound') },
  'files.outside': { kind: 'outside', title: () => t('config.docs.err.file.outside') },
  'files.hidden': { kind: 'error', title: () => t('config.docs.err.file.hidden') },
  'files.notFile': { kind: 'notFile', title: () => t('config.docs.err.file.notFile') },
  'files.rootMissing': { kind: 'missing', title: () => t('config.docs.err.file.rootMissing') },
  'files.badPath': { kind: 'error', title: () => t('config.docs.err.file.badPath') },
  'files.readFailed': { kind: 'error', title: () => t('config.docs.err.file.readFailed') },
  'docs.notOpenable': { kind: 'error', title: () => t('config.docs.err.file.notOpenable') },
  'docs.noPreview': { kind: 'error', title: () => t('config.docs.err.file.noPreview') },
  'docs.noTaskSource': { kind: 'missing', title: () => t('config.docs.err.file.noTask') }
}

/** Ошибка вызова `docs:view/bytes/previewUrl/open/reveal` → состояние просмотрщика. Узнаём по коду, не по тексту. */
export function docViewFailure(e: unknown): DocViewFailure {
  const stale = { kind: 'stale', title: t('config.docs.view.stale'), message: t('config.docs.view.staleText') } as const
  if (e instanceof DocViewStaleError) return stale
  const message = ipcErrorMessage(e)
  if (/No handler registered for 'docs:/.test(message)) return stale
  const code = ipcErrorCode(e)
  const known = code ? BY_CODE[code] : undefined
  if (known) return { kind: known.kind, code, title: known.title(), message }
  return { kind: 'error', ...(code ? { code } : {}), title: t('config.docs.err.file.other'), message }
}

/** Состояние загрузки: ни данных, ни ошибки — ещё грузится. */
export interface DocLoad<T> {
  data?: T
  failure?: DocViewFailure
}

/**
 * Общая загрузка: запрос, пока компонент смонтирован и `enabled`; ответ устаревшего запроса (сменился файл) отбрасывается.
 * `key` — всё, от чего зависит запрос, строкой; `reload` — перечитать тот же файл.
 */
function useDocLoad<T>(key: string, enabled: boolean, load: (api: DocViewApi) => Promise<T>): DocLoad<T> {
  const [state, setState] = useState<DocLoad<T>>({})
  useEffect(() => {
    if (!enabled) {
      setState({})
      return
    }
    let alive = true
    setState({})
    try {
      load(docViewApi(getUiApi())).then(
        (data) => alive && setState({ data }),
        (e: unknown) => alive && setState({ failure: docViewFailure(e) })
      )
    } catch (e) {
      setState({ failure: docViewFailure(e) })
    }
    return () => {
      alive = false
    }
    // `load` — новая стрелка на каждый рендер; запрос определяется `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])
  return state
}

/** `docs:view` файла; `source: true` — с исходником HTML/SVG для режима «Код». */
export function useDocView(source: string, path: string, opts: DocViewOptions = {}, reload = 0, enabled = true): DocLoad<DocView> {
  const withSource = opts.source === true
  return useDocLoad(JSON.stringify([source, path, withSource, reload]), enabled, (api) => api.view(source, path, withSource ? { source: true } : undefined))
}

/** Байты картинки (`docs:bytes`) для `useBlobUrl`. */
export function useDocBytes(source: string, path: string, reload = 0, enabled = true): DocLoad<DocBytes> {
  return useDocLoad(JSON.stringify([source, path, reload]), enabled, (api) => api.bytes(source, path))
}

/** Адрес изолированного фрейма: `url` — страница HTML, `base` — корень для картинок markdown. */
export interface DocPreview {
  url: string
  base?: string
}

/**
 * `docs:previewUrl`. Ответ проверяется `isPreviewUrl`: подменённый или кривой адрес (`https://`, `file://`) во фрейм
 * не ставится — это ошибка, а не страница.
 */
export function useDocPreviewUrl(source: string, path: string, reload = 0, enabled = true): DocLoad<DocPreview> {
  const load = useDocLoad(JSON.stringify([source, path, reload]), enabled, (api) => api.previewUrl(source, path))
  return useMemo(() => {
    if (!load.data) return load.failure ? { failure: load.failure } : {}
    if (!isPreviewUrl(load.data.url)) return { failure: { kind: 'error', title: t('config.docs.err.file.other'), message: t('config.docs.err.badUrl') } }
    return { data: { url: load.data.url, ...(isPreviewUrl(load.data.base) ? { base: load.data.base } : {}) } }
  }, [load])
}

/**
 * Контекст markdown-документа в «Документах»: ссылки на любые файлы источника (`links: 'project'`) и, если в тексте
 * есть картинки, `base` из `docs:previewUrl`. Без картинок IPC не зовётся и документ показывается сразу. Пока адрес
 * не пришёл — undefined (не мигать подписями вместо картинок); не вышло (старый main, скрытый путь) — без `base`:
 * текст виден, относительные картинки заменены подписью.
 */
export function useDocMarkdownAssets(source: string, path: string, text: string, reload = 0): MarkdownAssets | undefined {
  const images = useMemo(() => hasMarkdownImages(text), [text])
  const { data, failure } = useDocPreviewUrl(source, path, reload, images)
  return useMemo(() => {
    if (!images || failure) return { path, links: 'project' }
    return data ? { path, links: 'project', ...(data.base ? { base: data.base } : {}) } : undefined
  }, [images, path, data, failure])
}

/**
 * Исходный текст для режима «Код»/«Исходник»: у markdown и кода он уже в `view.text`, у HTML и SVG main отдаёт его
 * только по `opts.source` — тогда отдельный `docs:view`, и только когда этот режим выбран.
 */
export function useDocSourceText(source: string, path: string, view: DocView, mode: DocMode | undefined, reload = 0): DocLoad<string> {
  const need = needsSourceText(view, mode)
  const load = useDocView(source, path, { source: true }, reload, need)
  if (view.text !== undefined) return { data: view.text }
  if (load.failure) return { failure: load.failure }
  // Ответ без текста (кривой main) — показать пустой файл лучше, чем вечную загрузку.
  return load.data ? { data: load.data.text ?? '' } : {}
}
