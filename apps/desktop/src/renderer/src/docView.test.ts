import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocView } from '../../shared/ipc'
import { DOC_TEXT_MAX_BYTES } from '../../shared/docs-view'
import {
  codeText,
  docActions,
  docFindable,
  docIconOf,
  docKindLabel,
  docModes,
  docStatusFacts,
  docStubInfo,
  docStubOf,
  docZoomable,
  effectiveMode,
  gutterText,
  lineCount,
  needsSourceText,
  showsCode
} from './docView'
import { docViewApi, docViewFailure, DocViewStaleError, hasDocView } from './docViewApi'
import { setLocale } from './i18n'

const NOW = new Date(2026, 9, 1, 15, 0).getTime()
const view = (v: Partial<DocView> & Pick<DocView, 'kind'>): DocView => ({ size: 1200, mtime: NOW - 60_000, openable: false, ...v })

test('значок по пути: markdown, код, конфиг, текст, .env, картинка, html, pdf, бинарь, неизвестное', () => {
  assert.equal(docIconOf('docs/architecture.md'), 'doc')
  assert.equal(docIconOf('src/main/index.ts'), 'code')
  assert.equal(docIconOf('Makefile'), 'code')
  assert.equal(docIconOf('package.json'), 'config')
  assert.equal(docIconOf('.github/workflows/ci.yml'), 'config')
  assert.equal(docIconOf('.gitignore'), 'config')
  assert.equal(docIconOf('LICENSE'), 'text')
  assert.equal(docIconOf('notes.txt'), 'text')
  assert.equal(docIconOf('.env'), 'env')
  assert.equal(docIconOf('.env.local'), 'env')
  assert.equal(docIconOf('logo.svg'), 'image')
  assert.equal(docIconOf('design/a.html'), 'html')
  assert.equal(docIconOf('spec.pdf'), 'pdf')
  assert.equal(docIconOf('icon.icns'), 'binary')
  assert.equal(docIconOf('bin/run'), 'file', 'без расширения — общий значок')
  assert.equal(docIconOf('bin/run', 'text'), 'text', 'main распознал текст по содержимому')
  assert.equal(docIconOf('bin/run', 'binary'), 'binary')
})

test('подпись вида: язык, формат картинки, иначе вид словами', () => {
  setLocale('ru')
  assert.equal(docKindLabel('a.ts'), 'TypeScript')
  assert.equal(docKindLabel('Dockerfile.dev'), 'Dockerfile')
  assert.equal(docKindLabel('a.png'), 'PNG')
  assert.equal(docKindLabel('photo.jpg'), 'JPEG')
  assert.equal(docKindLabel('logo.svg'), 'SVG')
  assert.equal(docKindLabel('notes.txt'), 'Текст')
  assert.equal(docKindLabel('bin/run', 'text'), 'Текст')
  assert.equal(docKindLabel('a.ts', 'binary'), 'Бинарный', '.ts с NUL — язык не подписываем')
  assert.equal(docKindLabel('app.exe'), 'Бинарный')
  assert.equal(docKindLabel('dir.v2/run'), 'Файл', 'точка в папке — не расширение')
  setLocale('en')
  assert.equal(docKindLabel('notes.txt'), 'Text')
  setLocale('ru')
})

test('строки и колонка номеров: последний перевод строки новую не начинает, CRLF и CR — как LF', () => {
  assert.equal(lineCount(''), 0)
  assert.equal(lineCount('a'), 1)
  assert.equal(lineCount('a\n'), 1)
  assert.equal(lineCount('a\nb'), 2)
  assert.equal(lineCount('a\n\n'), 2)
  assert.equal(lineCount('\n'), 1)
  assert.equal(codeText('a\r\nb\rc\n'), 'a\nb\nc\n')
  assert.equal(codeText('abc'), 'abc')
  assert.equal(lineCount(codeText('a\r\nb\r\n')), 2)
  assert.equal(gutterText(0), '1', 'пустой файл — одна строка в колонке')
  assert.equal(gutterText(3), '1\n2\n3')
  assert.equal(gutterText(12_000).split('\n').length, 12_000)
})

test('режимы по виду: markdown — документ/исходник, HTML — код по умолчанию, SVG — картинка/код', () => {
  assert.deepEqual(docModes(view({ kind: 'markdown' })), ['doc', 'source'])
  assert.deepEqual(docModes(view({ kind: 'html', mime: 'text/html' })), ['code', 'preview'])
  assert.deepEqual(docModes(view({ kind: 'image', mime: 'image/svg+xml' })), ['image', 'code'])
  assert.deepEqual(docModes(view({ kind: 'image', mime: 'image/png' })), [])
  assert.deepEqual(docModes(view({ kind: 'text' })), [])
  assert.deepEqual(docModes(view({ kind: 'markdown', stub: 'tooBig' })), [], 'у заглушки переключать нечего')
  const html = view({ kind: 'html', mime: 'text/html' })
  assert.equal(effectiveMode(html, undefined), 'code')
  assert.equal(effectiveMode(html, 'preview'), 'preview')
  assert.equal(effectiveMode(html, 'doc'), 'code', 'режим от прошлого файла — по умолчанию')
  assert.equal(effectiveMode(view({ kind: 'text' }), 'preview'), undefined)
})

test('что показывает код, что ищется ⌘F, где масштаб, когда нужен исходник', () => {
  const md = view({ kind: 'markdown', text: '# A' })
  const html = view({ kind: 'html', mime: 'text/html' })
  const svg = view({ kind: 'image', mime: 'image/svg+xml' })
  const png = view({ kind: 'image', mime: 'image/png' })
  const code = view({ kind: 'text', text: 'x' })
  assert.equal(showsCode(code, undefined), true)
  assert.equal(showsCode(md, 'doc'), false)
  assert.equal(showsCode(md, 'source'), true)
  assert.equal(showsCode(html, undefined), true)
  assert.equal(showsCode(html, 'preview'), false)
  assert.equal(showsCode(svg, 'code'), true)
  assert.equal(showsCode(png, undefined), false)
  assert.equal(showsCode(view({ kind: 'text', stub: 'notUtf8' }), undefined), false)

  assert.equal(docFindable(md, 'doc'), true)
  assert.equal(docFindable(md, 'source'), true)
  assert.equal(docFindable(code, undefined), true)
  assert.equal(docFindable(html, 'preview'), false)
  assert.equal(docFindable(png, undefined), false)
  assert.equal(docFindable(view({ kind: 'text', stub: 'tooBig' }), undefined), false)

  assert.equal(docZoomable(png, undefined), true)
  assert.equal(docZoomable(svg, 'image'), true)
  assert.equal(docZoomable(svg, 'code'), false)
  assert.equal(docZoomable(view({ kind: 'image', mime: 'image/png', stub: 'tooBig' }), undefined), false)

  assert.equal(needsSourceText(html, 'code'), true)
  assert.equal(needsSourceText(html, 'preview'), false, 'превью исходник не нужен')
  assert.equal(needsSourceText({ ...html, text: '<p>' }, 'code'), false, 'уже пришёл с opts.source')
  assert.equal(needsSourceText(svg, 'code'), true)
  assert.equal(needsSourceText(svg, 'image'), false)
  assert.equal(needsSourceText(md, 'source'), false, 'у markdown текст есть всегда')
})

test('действия: абсолютный путь — у проекта, «Открыть» — только по белому списку', () => {
  assert.deepEqual(docActions('project', view({ kind: 'image', openable: true })), { copy: true, copyAbs: true, reveal: true, open: true })
  assert.deepEqual(docActions('task_1', view({ kind: 'text', openable: false })), { copy: true, copyAbs: false, reveal: true, open: false })
  assert.equal(docActions('project', undefined).open, false, 'вида ещё нет — без «Открыть»')
})

test('заглушки: причина, лимит и размер в тексте; PDF и бинарный вид без stub — тоже заглушка', () => {
  setLocale('ru')
  assert.equal(docStubOf(view({ kind: 'pdf' })), 'pdf')
  assert.equal(docStubOf(view({ kind: 'binary' })), 'binary')
  assert.equal(docStubOf(view({ kind: 'text', text: 'x' })), undefined)

  const big = docStubInfo(view({ kind: 'text', stub: 'tooBig', size: 3.4 * 1024 * 1024 }), 'trace.log')
  assert.equal(big?.title, 'Файл слишком большой для просмотра')
  assert.equal(big?.text, 'Текстовые файлы показываются до 1 МБ, этот весит 3,4 МБ.')
  assert.equal(big?.icon, 'text')
  const bigImg = docStubInfo(view({ kind: 'image', stub: 'tooBig', size: 14 * 1024 * 1024 }), 'board.png')
  assert.equal(bigImg?.text, 'Картинки показываются до 10 МБ, эта весит 14,0 МБ.')
  assert.equal(docStubInfo(view({ kind: 'text', stub: 'binary' }), 'a.ts')?.icon, 'binary')
  assert.equal(docStubInfo(view({ kind: 'text', stub: 'notUtf8' }), 'a.csv')?.tone, 'warn')
  assert.equal(docStubInfo(view({ kind: 'pdf', stub: 'pdf' }), 'spec.pdf')?.icon, 'pdf')
  assert.equal(docStubInfo(view({ kind: 'text', text: 'x' }), 'a.ts'), undefined)
  assert.ok(DOC_TEXT_MAX_BYTES === 1024 * 1024)
})

test('строка статуса: тип, кодировка, строки, размер, время; картинка — размеры и масштаб; превью — изоляция', () => {
  setLocale('ru')
  const keys = (f: { key: string }[]): string[] => f.map((x) => x.key)
  const code = docStatusFacts({ path: 'a.ts', view: view({ kind: 'text', text: 'a\nb\n' }), mode: undefined, zoom: 'fit', lines: 2, now: NOW })
  assert.deepEqual(keys(code), ['type', 'encoding', 'lines', 'size', 'modified', 'nowrap'])
  assert.equal(code[0].text, 'TypeScript')
  assert.equal(code[2].text, '2 строки')
  assert.equal(code[3].text, '1 КБ')
  assert.equal(code[4].text, 'изменён сегодня в 14:59')
  assert.equal(code.find((f) => f.key === 'nowrap')?.optional, true)

  const md = docStatusFacts({ path: 'README.md', view: view({ kind: 'markdown', text: '# A' }), mode: 'doc', zoom: 'fit', lines: 1, now: NOW })
  assert.deepEqual(keys(md), ['type', 'encoding', 'lines', 'size', 'modified'], 'у документа нет «без переноса»')

  const png = docStatusFacts({ path: 'a.png', view: view({ kind: 'image', mime: 'image/png' }), mode: undefined, zoom: 'actual', dims: { width: 1280, height: 800 }, now: NOW })
  assert.deepEqual(keys(png), ['type', 'dims', 'zoom', 'size', 'modified'])
  assert.equal(png[1].text, '1280 × 800')
  assert.equal(png[2].text, '100 %')

  const preview = docStatusFacts({ path: 'a.html', view: view({ kind: 'html', mime: 'text/html' }), mode: 'preview', zoom: 'fit', now: NOW })
  assert.deepEqual(keys(preview), ['type', 'size', 'modified', 'isolated'])
  assert.equal(preview[3].text, 'изолировано, без сети')

  const noTime = docStatusFacts({ path: 'a.ts', view: view({ kind: 'text', text: '', mtime: 0 }), mode: undefined, zoom: 'fit', lines: 0, now: NOW })
  assert.equal(noTime.some((f) => f.key === 'modified'), false, 'нет времени — нет пункта')
  assert.equal(noTime[2].text, '0 строк')
})

test('API просмотра: старый preload — «перезапустите», новый — методы на месте', async () => {
  assert.throws(() => docViewApi(undefined), DocViewStaleError)
  assert.throws(() => docViewApi({}), DocViewStaleError)
  const read = async (): Promise<string> => ''
  const old = { docs: { list: async () => [], read, open: async () => {}, reveal: async () => {} } }
  assert.equal(hasDocView(old as never), false)
  const calls: unknown[] = []
  const fresh = {
    docs: {
      ...old.docs,
      view: async (s: string, p: string, o?: unknown) => (calls.push(['view', s, p, o]), view({ kind: 'text', text: 'x' })),
      bytes: async (s: string, p: string) => (calls.push(['bytes', s, p]), { mime: 'image/png', bytes: new Uint8Array() }),
      previewUrl: async (s: string, p: string) => (calls.push(['previewUrl', s, p]), { url: 'orca-preview://t/a.html', mime: 'text/html', base: 'orca-preview://t/' })
    }
  }
  assert.equal(hasDocView(fresh as never), true)
  const api = docViewApi(fresh as never)
  await api.view('project', 'a.ts', { source: true })
  await api.bytes('task_1', 'a.png')
  await api.previewUrl('project', 'a.html')
  assert.deepEqual(calls, [['view', 'project', 'a.ts', { source: true }], ['bytes', 'task_1', 'a.png'], ['previewUrl', 'project', 'a.html']])
})

test('ошибки по коду, а не по тексту: нет файла, наружу, не файл, старый main, прочее', () => {
  setLocale('ru')
  const wrap = (code: string, text: string): Error => new Error(`Error invoking remote method 'docs:view': OrcaError[${code}]: ${text}`)
  const missing = docViewFailure(wrap('files.notFound', 'не найдено: a.ts'))
  assert.deepEqual(missing, { kind: 'missing', code: 'files.notFound', title: 'Файл не найден', message: 'не найдено: a.ts' })
  assert.equal(docViewFailure(wrap('files.outside', 'путь вне проекта: x')).kind, 'outside')
  assert.equal(docViewFailure(wrap('files.outside', 'x')).title, 'Ссылка ведёт за пределы проекта')
  assert.equal(docViewFailure(wrap('files.notFile', 'не файл: src')).kind, 'notFile')
  assert.equal(docViewFailure(wrap('docs.noTaskSource', 'задача не в работе')).kind, 'missing')
  assert.equal(docViewFailure(wrap('docs.notOpenable', 'нельзя')).title, 'Этот файл нельзя открыть из приложения')
  assert.equal(docViewFailure(new Error("Error invoking remote method 'docs:view': Error: No handler registered for 'docs:view'")).kind, 'stale')
  assert.equal(docViewFailure(new DocViewStaleError()).kind, 'stale')
  const other = docViewFailure(new Error('EIO'))
  assert.deepEqual(other, { kind: 'error', title: 'Не удалось показать файл', message: 'EIO' })
  assert.equal(docViewFailure(wrap('files.readFailed', 'нет доступа')).message, 'нет доступа', 'текст main — как есть')
})
