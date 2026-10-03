import type { Stats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { DOC_IMAGE_MAX_BYTES, DOC_SNIFF_BYTES, DOC_TEXT_MAX_BYTES, docKindOf, type DocViewKind } from '@orca-board/contracts'
import type { DocBytes, DocPreviewUrl, DocStub, DocView } from '@orca-board/contracts'
import { showcaseFileType, showcaseServedMime } from '@orca-board/contracts'
import type { FileMessages } from './file-messages.ts'
import type { PreviewTokens, PreviewServices } from './preview.ts'
import type { ProjectFileServices } from './project-files.ts'

/** Файл источника: реальный путь (цель симлинка), относительный путь как его видит человек и `stat` цели. */
export interface DocFileRef {
  real: string
  rel: string
  st: Stats
}

export function createDocViewServices(deps: { messages: FileMessages; files: ProjectFileServices; preview: PreviewServices }) {
  const OrcaError = deps.messages.Error
  const { resolveProjectPath, splitSafeSegments } = deps.files
  const { previewBase, previewSegments, previewUrlFor } = deps.preview

  // Просмотр любого файла источника «Документов» (IPC docs:view / bytes / previewUrl / open / reveal,
  // docs/architecture.md → «Просмотр файлов проекта (main)»). Путь из renderer не доверенный: резолвер — общий с
  // вкладкой «Файлы» (`resolveProjectPath`: win32-символы, `..`, симлинки наружу, `.git`), коды отказов — его
  // `files.*` плюс `docs.notOpenable` / `docs.noPreview`. Бинарь, не UTF-8, большой файл и PDF — не ошибки, а `stub`.

  function fsFailed(rel: string, e: unknown): Error {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return new OrcaError('files.notFound', { path: rel })
    // Только код fs: сообщение Node содержит абсолютный путь, а его наружу не отдаём.
    return new OrcaError('files.readFailed', { path: rel, error: code ?? 'EIO' })
  }

  /**
   * Обычный файл `rel` внутри `root`: путь проверяет `resolveProjectPath` (симлинки разворачиваются и не должны уводить
   * за корень или в `.git`), затем `stat` цели **до** открытия — папка, FIFO, сокет или устройство дают `files.notFile`,
   * а не повисший `open`.
   */
  async function resolveDocFile(root: string, rel: unknown): Promise<DocFileRef> {
    const relText = splitSafeSegments(rel).join('/')
    const real = await resolveProjectPath(root, rel, true)
    let st: Stats
    try {
      st = await stat(real)
    } catch (e) {
      throw fsFailed(relText, e)
    }
    if (!st.isFile()) throw new OrcaError('files.notFile', { path: relText || '/' })
    return { real, rel: relText, st }
  }

  const READ_CHUNK_BYTES = 64 * 1024

  /**
   * Не больше `max + 1` байт файла через один дескриптор: `size` из `stat` мог устареть (файл растёт), поэтому лишний
   * байт — признак «больше лимита», а не обрезанное содержимое.
   */
  async function readAtMost(ref: DocFileRef, max: number): Promise<{ bytes: Buffer; over: boolean }> {
    let fh
    try {
      fh = await open(ref.real, 'r')
    } catch (e) {
      throw fsFailed(ref.rel, e)
    }
    try {
      const chunks: Buffer[] = []
      let total = 0
      // Первый кусок — по `stat`; если файл вырос, дочитываем кусками, пока не станет ясно, что он больше лимита.
      let want = Math.min(max, ref.st.size) + 1
      while (total <= max) {
        const buf = Buffer.alloc(Math.min(want, max + 1 - total))
        const { bytesRead } = await fh.read(buf, 0, buf.length, total)
        if (bytesRead === 0) break
        chunks.push(buf.subarray(0, bytesRead))
        total += bytesRead
        want = READ_CHUNK_BYTES
      }
      return { bytes: Buffer.concat(chunks, total).subarray(0, Math.min(total, max)), over: total > max }
    } catch (e) {
      throw fsFailed(ref.rel, e)
    } finally {
      await fh.close()
    }
  }

  /**
   * Текст или причина его не показывать: NUL в первых `DOC_SNIFF_BYTES` — `binary`; невалидный UTF-8 — `notUtf8` (других
   * кодировок не угадываем). BOM UTF-8 срезается (`TextDecoder` делает это сам), переводы строк — как в файле.
   */
  function sniffText(bytes: Uint8Array): { text: string } | { stub: 'binary' | 'notUtf8' } {
    if (bytes.subarray(0, DOC_SNIFF_BYTES).includes(0)) return { stub: 'binary' }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      return { stub: 'notUtf8' }
    }
  }

  /** Можно ли открыть приложением системы: расширение из белого списка показа (`.sh`, `.app`, `.command` — никогда). */
  const openableExt = (p: string): boolean => showcaseFileType(p) !== undefined

  type TextResult = { kind: DocViewKind; text?: string; stub?: DocStub }

  /**
   * Текстовое содержимое для `markdown`, `text`, исходника `html`/SVG и файлов неизвестного вида. `guess` — вид по пути;
   * `unknown` уточняется по содержимому: NUL — `binary`, иначе `text`.
   */
  async function readText(ref: DocFileRef, guess: DocViewKind | 'unknown'): Promise<TextResult> {
    const kind = (fallback: 'text' | 'binary'): DocViewKind => (guess === 'unknown' ? fallback : guess)
    if (ref.st.size > DOC_TEXT_MAX_BYTES) {
      if (guess !== 'unknown') return { kind: guess, stub: 'tooBig' }
      // Большой файл без расширения: вид — по первым байтам, чтобы заглушка сказала «бинарный», а не «текст».
      const head = await readAtMost(ref, DOC_SNIFF_BYTES)
      return { kind: head.bytes.includes(0) ? 'binary' : 'text', stub: 'tooBig' }
    }
    const { bytes, over } = await readAtMost(ref, DOC_TEXT_MAX_BYTES)
    // Вырос между stat и чтением: UTF-8 на границе лимита мог разрезаться, поэтому без проверки декодирования.
    if (over) return { kind: kind(bytes.subarray(0, DOC_SNIFF_BYTES).includes(0) ? 'binary' : 'text'), stub: 'tooBig' }
    const sniffed = sniffText(bytes)
    if ('stub' in sniffed) return { kind: kind(sniffed.stub === 'binary' ? 'binary' : 'text'), stub: sniffed.stub }
    return { kind: kind('text'), text: sniffed.text }
  }

  /**
   * Ответ `docs:view`: вид по пути (`docKindOf`), сведения о цели и, где нужно, текст. `opts.source` — исходник `html` и
   * SVG для вкладки «Код»; у SVG больше `DOC_TEXT_MAX_BYTES` это `stub: 'tooBig'` (картинку покажет `docs:bytes`).
   */
  async function viewDoc(root: string, rel: unknown, opts?: unknown): Promise<DocView> {
    return viewResolved(await resolveDocFile(root, rel), opts)
  }

  /** `viewDoc` по уже проверенному файлу: отдельно, чтобы тест мог изменить файл между `stat` и чтением. */
  async function viewResolved(ref: DocFileRef, opts?: unknown): Promise<DocView> {
    const wantSource = typeof opts === 'object' && opts !== null && (opts as { source?: unknown }).source === true
    const k = docKindOf(ref.rel)
    const base = { size: ref.st.size, mtime: ref.st.mtimeMs, openable: openableExt(ref.rel) && openableExt(ref.real) }
    const mime = k.mime ? { mime: k.mime } : {}
    switch (k.kind) {
      case 'pdf':
        return { ...base, kind: 'pdf', ...mime, stub: 'pdf' }
      case 'binary':
        return { ...base, kind: 'binary', stub: 'binary' }
      case 'image': {
        if (ref.st.size > DOC_IMAGE_MAX_BYTES) return { ...base, kind: 'image', ...mime, stub: 'tooBig' }
        if (!(wantSource && k.mime === 'image/svg+xml')) return { ...base, kind: 'image', ...mime }
        const r = await readText(ref, 'image')
        return { ...base, ...mime, ...r }
      }
      case 'html': {
        if (!wantSource) return { ...base, kind: 'html', ...mime }
        return { ...base, ...mime, ...(await readText(ref, 'html')) }
      }
      default:
        return { ...base, ...(await readText(ref, k.kind)) }
    }
  }

  /** Байты картинки (`docs:bytes`): только вид `image` по пути, не больше `DOC_IMAGE_MAX_BYTES` (в том числе если файл вырос). */
  async function readDocBytes(root: string, rel: unknown): Promise<DocBytes> {
    const ref = await resolveDocFile(root, rel)
    const k = docKindOf(ref.rel)
    if (k.kind !== 'image' || !k.mime) throw new OrcaError('docs.noPreview', { path: ref.rel })
    const tooBig = (): Error => new OrcaError('docs.tooBig', { mb: DOC_IMAGE_MAX_BYTES / 1024 / 1024, path: ref.rel })
    if (ref.st.size > DOC_IMAGE_MAX_BYTES) throw tooBig()
    const { bytes, over } = await readAtMost(ref, DOC_IMAGE_MAX_BYTES)
    if (over) throw tooBig()
    return { mime: k.mime, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  }

  /**
   * Адрес протокола `orca-preview://` для HTML и база для картинок markdown (`docs:previewUrl`). Токен — на корень
   * источника и **всегда без сети**: HTML проекта — недоверенный код, а токен открывает ему весь корень (кроме скрытых
   * сегментов), и с сетью страница вынесла бы файлы наружу. Один корень — один токен (`PreviewTokens.issue`). Не html и
   * не markdown, путь со скрытым сегментом (`.github/…`, `.env.html`) или цель симлинка другого типа — `docs.noPreview`:
   * такую страницу протокол всё равно не отдал бы.
   */
  async function docsPreviewUrl(tokens: PreviewTokens, root: string, rel: unknown): Promise<DocPreviewUrl> {
    const ref = await resolveDocFile(root, rel)
    const k = docKindOf(ref.rel)
    const segments = previewSegments(ref.rel)
    const served = showcaseServedMime(ref.rel)
    if ((k.kind !== 'html' && k.kind !== 'markdown') || !k.mime || !segments || !served || showcaseServedMime(ref.real) !== served) {
      throw new OrcaError('docs.noPreview', { path: ref.rel })
    }
    const token = tokens.issue(root, false)
    return { url: previewUrlFor(token, segments), mime: k.mime, base: previewBase(token) }
  }

  /**
   * Реальный путь для `shell.openPath` (`docs:open`): только расширения `SHOWCASE_FILE_TYPES`, и у пути, и у цели
   * симлинка (`a.png → run.sh` не запустится); иначе `docs.notOpenable`. Расширение пути проверяется до файловой
   * системы: папка `x.app` — тоже `docs.notOpenable`, а не «не файл».
   */
  async function docsOpenPath(root: string, rel: unknown): Promise<string> {
    const relText = splitSafeSegments(rel).join('/')
    if (!openableExt(relText)) throw new OrcaError('docs.notOpenable', { path: relText || '/' })
    const ref = await resolveDocFile(root, rel)
    if (!openableExt(ref.real)) throw new OrcaError('docs.notOpenable', { path: relText })
    return ref.real
  }

  /** Путь для `shell.showItemInFolder` (`docs:reveal`): любой файл источника; симлинк — сам симлинк, не цель. */
  function docsRevealPath(root: string, rel: unknown): Promise<string> {
    return resolveProjectPath(root, rel, false)
  }

  return { resolveDocFile, viewDoc, viewResolved, readDocBytes, docsPreviewUrl, docsOpenPath, docsRevealPath, sniffText }
}
export type DocViewServices = ReturnType<typeof createDocViewServices>
