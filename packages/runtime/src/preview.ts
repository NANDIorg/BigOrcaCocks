import { randomBytes } from 'node:crypto'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { MAX_SHOWCASE_SNAPSHOT_FILE_BYTES } from '@orca-board/core'
import { showcaseServedMime } from '@orca-board/contracts'
import { isInside } from './path-safety.ts'

/** Сколько корней помнит протокол: старые токены вытесняются (LRU), их фреймы получают 404 — «Обновить» выдаст новый. */
export const PREVIEW_TOKEN_LIMIT = 100

/** На что выдан токен: корень показа (снимок запуска или worktree) и открыта ли странице сеть. */
export interface PreviewGrant {
  root: string
  network: boolean
}

/**
 * Токены протокола: 128 случайных бит в hex (нижний регистр — хост standard-схемы Chromium приводит к нему), живут до
 * выхода из приложения. Один корень с одним режимом сети — один токен: «Обновить» и соседние файлы показа не плодят
 * записи. Сеть — отдельный токен, потому что CSP ответа зависит от него, а не от страницы.
 */
export class PreviewTokens {
  private readonly grants = new Map<string, PreviewGrant>()

  private readonly limit: number
  private readonly random: () => string

  constructor(limit = PREVIEW_TOKEN_LIMIT, random: () => string = () => randomBytes(16).toString('hex')) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Preview token limit must be positive')
    this.limit = limit; this.random = random
  }

  issue(root: string, network: boolean): string {
    for (const [token, g] of this.grants) {
      if (g.root === root && g.network === network) return this.touch(token, g)
    }
    let token = this.random()
    while (this.grants.has(token)) token = this.random()
    this.grants.set(token, { root, network })
    while (this.grants.size > this.limit) this.grants.delete(this.grants.keys().next().value!)
    return token
  }

  get(token: string): PreviewGrant | undefined {
    const g = this.grants.get(token)
    if (g) this.touch(token, g)
    return g
  }

  get size(): number {
    return this.grants.size
  }

  private touch(token: string, g: PreviewGrant): string {
    this.grants.delete(token)
    this.grants.set(token, g)
    return token
  }
}

export type PreviewRefusal = 'method' | 'url' | 'token' | 'path' | 'type' | 'outside' | 'notFound' | 'notFile' | 'tooBig'

export type PreviewResolution =
  | { ok: true; file: string; size: number; head: boolean; headers: Record<string, string> }
  | { ok: false; status: number; reason: PreviewRefusal }

const REFUSAL_STATUS: Record<PreviewRefusal, number> = {
  method: 405, url: 400, token: 404, path: 403, type: 403, outside: 403, notFound: 404, notFile: 404, tooBig: 413
}

export interface PreviewAddress {
  /** Разрешённый источник CSP, заданный доверенным хостом (scheme: либо отдельный origin). */
  cspSource: string
  base(token: string): string
  urlFor(token: string, segments: string[]): string
  /** path сохраняет исходное percent encoding: нормализация dot segments до guards запрещена. */
  parse(url: string): { token: string; path: string } | undefined
}

export function createSchemePreviewAddress(scheme: string): PreviewAddress {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) throw new TypeError('Invalid preview scheme')
  const canonical = scheme.toLowerCase()
  const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}:\\/\\/([^/?#]+)(\\/[^?#]*)?(?:[?#].*)?$`, 'i')
  const base = (token: string) => `${canonical}://${token}/`
  return {
    cspSource: `${canonical}:`, base,
    urlFor: (token, segments) => `${base(token)}${segments.map(encodeURIComponent).join('/')}`,
    parse: url => {
      const match = pattern.exec(url)
      return match ? { token: match[1].toLowerCase(), path: match[2] ?? '/' } : undefined
    }
  }
}

export function createPreviewServices(address: PreviewAddress) {
  // Протокол `orca-preview://<токен>/<путь>` — страницы показа человеку (HTML, SVG, картинки для markdown) в
  // изолированном фрейме renderer'а (docs/workflow.md → «Показ человеку», docs/architecture.md → «Протокол показа»).
  // HTML агента — недоверенный код: он видит только корень, на который выдан токен, без сети (по умолчанию) и без
  // ухода фрейма наружу. Здесь — чистые функции без electron (тестируются в node:test на временной папке);
  // регистрация схемы и `protocol.handle` — тонкая обвязка в index.ts.

  /** Источники, которые открывает «Интернет-ресурсы»: только https (http-CDN — смешанный контент, не нужен). */
  const NETWORK_SOURCES = ' https:'

  /**
   * CSP ответа протокола. Сеть закрыта: всё — только из своего снимка (`orca-preview:`), inline и eval разрешены (макеты
   * агентов ими живут). `sandbox allow-scripts` дублирует атрибут фрейма: страница, открытая по URL в обход iframe,
   * всё равно получает opaque-origin. `navigate-to` Chromium не поддерживает — уход фрейма режет `allowFrameNavigation`.
   */
  function buildPreviewCsp(network: boolean): string {
    const net = network ? NETWORK_SOURCES : ''
    return [
      "default-src 'none'",
      `script-src ${address.cspSource} 'unsafe-inline' 'unsafe-eval'${net}`,
      `style-src ${address.cspSource} 'unsafe-inline'${net}`,
      `img-src ${address.cspSource} data: blob:${net}`,
      `font-src ${address.cspSource} data:${net}`,
      `media-src ${address.cspSource} data: blob:${net}`,
      `connect-src ${address.cspSource}${net}`,
      `worker-src ${address.cspSource} blob:`,
      "frame-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      'sandbox allow-scripts'
    ].join('; ')
  }

  /** Возможности браузера, которые странице показа не нужны ни при каком режиме сети. */
  const PERMISSIONS_POLICY = [
    'camera', 'microphone', 'geolocation', 'display-capture', 'usb', 'serial', 'hid', 'bluetooth', 'payment',
    'clipboard-read', 'clipboard-write', 'publickey-credentials-get', 'screen-wake-lock', 'idle-detection'
  ].map((f) => `${f}=()`).join(', ')

  /** Текстовые типы — с `charset=utf-8`: агенты пишут по-русски, а без charset Chromium угадывает кодировку. */
  function contentType(mime: string): string {
    return mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml' ? `${mime}; charset=utf-8` : mime
  }

  /**
   * Заголовки ответа протокола. `Content-Type` — из таблицы расширений, не по содержимому (+ `nosniff`: HTML под видом
   * картинки не исполнится). ACAO `*` и CORP `cross-origin` нужны самому показу: фрейм без `allow-same-origin` —
   * opaque-origin, и его шрифты, `fetch()` и `<script type=module>` из своего же снимка идут как cross-origin.
   * CSP — на каждом ответе: для не-документов он безвреден, а для HTML/SVG закрывает сеть.
   */
  function previewHeaders(mime: string, network: boolean): Record<string, string> {
    return {
      'Content-Type': contentType(mime),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': PERMISSIONS_POLICY,
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Content-Security-Policy': buildPreviewCsp(network)
    }
  }

  /**
   * Сегменты относительного пути показа, пригодные для URL протокола; `undefined` — путь не отдаётся: пустой сегмент,
   * `.`/`..` и любые скрытые (`.env`, `.git/…`), разделители и NUL внутри сегмента, `:` (диск Windows, потоки NTFS).
   */
  function previewSegments(relPath: string): string[] | undefined {
    const segments = relPath.split('/')
    return segments.every(segmentOk) ? segments : undefined
  }

  function segmentOk(s: string): boolean {
    return s !== '' && !s.startsWith('.') && !/[\\/:\0]/.test(s)
  }

  /** URL файла показа: `orca-preview://<токен>/<путь>` с процентным кодированием сегментов (пробелы, кириллица). */
  function previewUrlFor(token: string, segments: string[]): string {
    return address.urlFor(token, segments)
  }

  /** Корень снимка в протоколе: к нему renderer разрешает относительные картинки markdown. */
  function previewBase(token: string): string {
    return address.base(token)
  }

  function refuse(reason: PreviewRefusal): PreviewResolution {
    return { ok: false, status: REFUSAL_STATUS[reason], reason }
  }

  /**
   * Разбор запроса протокола: какой файл отдать и с какими заголовками — или отказ. URL разбирается вручную, а не через
   * `URL`: тот нормализует `..` и `%2e%2e` до проверки, а здесь такой путь должен быть отказом, а не «соседним файлом».
   * Проверки как у `resolveShowcasePath`, но по белому списку протокола (точки входа + ассеты): расширение и по пути,
   * и по realpath (симлинк `a.png → run.sh`), realpath внутри корня токена, обычный файл, не больше лимита снимка.
   */
  function resolvePreviewRequest(req: { method: string; url: string }, tokens: PreviewTokens): PreviewResolution {
    const method = req.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return refuse('method')
    const ref = address.parse(req.url)
    if (!ref) return refuse('url')
    const grant = tokens.get(ref.token)
    if (!grant) return refuse('token')
    let segments: string[]
    try {
      segments = ref.path.slice(1).split('/').map(decodeURIComponent)
    } catch {
      return refuse('url')
    }
    // Сегменты проверяются после декодирования: `%2e%2e`, `%2F` и `%5C` внутри сегмента — тоже отказ.
    if (!segments.every(segmentOk)) return refuse('path')
    const rel = segments.join('/')
    const mime = showcaseServedMime(rel)
    if (!mime) return refuse('type')
    const abs = resolve(grant.root, ...segments)
    let real: string
    let rootReal: string
    try {
      rootReal = realpathSync(grant.root)
      real = realpathSync(abs)
    } catch {
      return refuse('notFound')
    }
    if (!isInside(rootReal, real)) return refuse('outside')
    if (showcaseServedMime(real) !== mime) return refuse('type')
    const st = statSync(real)
    if (!st.isFile()) return refuse('notFile')
    if (st.size > MAX_SHOWCASE_SNAPSHOT_FILE_BYTES) return refuse('tooBig')
    return { ok: true, file: real, size: st.size, head: method === 'HEAD', headers: previewHeaders(mime, grant.network) }
  }

  /** Один диапазон `Range: bytes=…` (перемотка видео и аудио): `[start, end]` включительно; не разобрали — `undefined`, не выполнить — `'unsatisfiable'`. */
  function parseRange(header: string, size: number): [number, number] | 'unsatisfiable' | undefined {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (!m || (m[1] === '' && m[2] === '')) return undefined
    let start: number
    let end: number
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    } else {
      start = Number(m[1])
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    }
    return start > end || start >= size ? 'unsatisfiable' : [start, end]
  }

  /**
   * Ответ протокола на запрос фрейма. Отказ — пустое тело со статусом: путь и причину странице не раскрываем. Файл
   * читается потоком сам, а не `net.fetch(file://…)`: тот в Electron 38 игнорирует `Range` (видео не перематывается)
   * и угадывает тип сам, а нам нужен табличный и CSP.
   */
  function handlePreviewRequest(request: Request, tokens: PreviewTokens): Response {
    const r = resolvePreviewRequest({ method: request.method, url: request.url }, tokens)
    if (!r.ok) return new Response(null, { status: r.status })
    const headers = { ...r.headers, 'Accept-Ranges': 'bytes' }
    const rangeHeader = request.headers.get('range')
    const range = rangeHeader === null ? undefined : parseRange(rangeHeader, r.size)
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${r.size}` } })
    const [start, end] = range ?? [0, r.size - 1]
    const partial = range !== undefined
    const length = r.size === 0 ? 0 : end - start + 1
    const status = partial ? 206 : 200
    const all = { ...headers, 'Content-Length': String(length), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${r.size}` } : {}) }
    if (r.head || length === 0) return new Response(null, { status, headers: all })
    const body = Readable.toWeb(createReadStream(r.file, { start, end })) as ReadableStream<Uint8Array>
    return new Response(body, { status, headers: all })
  }

  /**
   * Можно ли фрейму окна перейти на `url` (`will-frame-navigate`). Подфреймы — только страницы показа (и `about:blank`,
   * когда renderer сбрасывает фрейм): атрибут `sandbox` навигацию самого фрейма не запрещает, и `location = 'https://…'`
   * или `<meta refresh>` увели бы макет на чужой сайт внутри приложения. Главный фрейм — только в пределах страницы
   * приложения (`appUrl`: dev-сервер или `file://…/index.html`); остальное — мимо окна.
   */
  function allowFrameNavigation(nav: { url: string; isMainFrame: boolean; appUrl: string }): boolean {
    if (!nav.isMainFrame) return Boolean(address.parse(nav.url)) || nav.url === 'about:blank'
    let target: URL
    let app: URL
    try {
      target = new URL(nav.url)
      app = new URL(nav.appUrl)
    } catch {
      return false
    }
    if (app.protocol === 'file:') return target.protocol === 'file:' && target.pathname === app.pathname
    return target.origin === app.origin
  }

  /** Внешние ссылки из окна (`setWindowOpenHandler`, отменённая навигация) — только http(s): не `file:`, не схемы приложений. */
  function isExternalWebUrl(url: string): boolean {
    return /^https?:\/\//i.test(url)
  }

  return { previewBase, previewUrlFor, previewSegments, buildPreviewCsp, previewHeaders, resolvePreviewRequest, handlePreviewRequest, parseRange, allowFrameNavigation, isExternalWebUrl }
}
export type PreviewServices = ReturnType<typeof createPreviewServices>
