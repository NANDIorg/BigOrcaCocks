import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Dispatch, HumanRequest } from '@orca-board/core'
import { showcaseMarkdown } from '../../shared/showcase'
import type { OrcaApi } from '../../shared/ipc'
import {
  showcaseStaleMessage, bodyWithoutShowcase, latestShowcase, requestShowcase, requestShowcaseTaskId, showcaseApi,
  showcaseErrorText, showcaseFiles, isPreviewUrl, showcasePreviewApi, ShowcaseStaleError, showcaseFailure, onShowcaseFrameEscape,
  showcaseGroup, showcaseOrder, stepShowcase, showcaseIndex, clampShowcasePos, showcaseEntries, thumbsShown, hiddenFiles,
  fitFrame, scalePercent, SHOWCASE_VIEWPORTS, INLINE_VIEWPORTS, type ShowcaseGroup
} from './showcase'

const dispatch = (id: string, extra: Partial<Dispatch> = {}): Dispatch =>
  ({ id, taskId: 't1', ptyId: 'p', startedAt: 1, outcome: 'done', ...extra })

const approval = (extra: Partial<HumanRequest> = {}): HumanRequest => ({
  id: 'r1', runId: 'run', taskId: 't1', kind: 'approval', status: 'pending', title: 'Выбрать вариант', options: [], createdAt: 1, ...extra
})

test('вид файла по расширению: картинки — превью, md — текст, html — страница, pdf — открыть, прочее — только путь', () => {
  const items = showcaseFiles(['design/a.PNG', 'design/b.svg', 'notes.md', 'design/a.html', 'spec.pdf', 'run.sh', 'Makefile'])
  assert.deepEqual(items.map((f) => [f.name, f.view]), [
    ['a.PNG', 'image'], ['b.svg', 'image'], ['notes.md', 'markdown'], ['a.html', 'html'], ['spec.pdf', 'open'], ['run.sh', 'none'], ['Makefile', 'none']
  ])
})

test('подряд идущие картинки — одна запись-сетка, остальные файлы — строками с номером в группе', () => {
  const entries = showcaseEntries(showcaseFiles(['a.html', '1.png', '2.jpg', 'x.md', '3.webp']))
  assert.deepEqual(entries.map((e) => (e.kind === 'images' ? e.files.map((f) => `${f.index}:${f.file.name}`) : `${e.index}:${e.file.name}`)), [
    '0:a.html', ['1:1.png', '2:2.jpg'], '3:x.md', ['4:3.webp']
  ])
})

test('сетка миниатюр: до шести — все, больше — пять и «+N»; «Ещё N файлов» считает файлы, а не записи', () => {
  assert.deepEqual(thumbsShown(6), { shown: 6, more: 0 })
  assert.deepEqual(thumbsShown(9), { shown: 5, more: 4 })
  const entries = showcaseEntries(showcaseFiles(['1.html', '2.html', '3.html', '4.html', '5.html', 'a.png', 'b.png', 'c.md']))
  assert.equal(hiddenFiles(entries, 5), 3)
  assert.equal(hiddenFiles(entries, 10), 0)
})

test('показ approval — из dispatch по showcaseDispatchId, у других запросов нет', () => {
  const showcase = { text: 'два варианта', files: ['a.png'] }
  const dispatches = [dispatch('d1'), dispatch('d2', { showcase })]
  assert.deepEqual(requestShowcase(approval({ showcaseDispatchId: 'd2' }), dispatches), showcase)
  assert.equal(requestShowcase(approval(), dispatches), undefined, 'старый запрос без showcaseDispatchId')
  assert.equal(requestShowcase(approval({ showcaseDispatchId: 'нет' }), dispatches), undefined)
  assert.equal(requestShowcase(approval({ kind: 'answer', showcaseDispatchId: 'd2' }), dispatches), undefined)
  assert.equal(requestShowcase(approval({ showcaseDispatchId: 'd2' }), undefined), undefined)
})

test('последний показ задачи — последний done с показом этой задачи', () => {
  const s = (text: string) => ({ text, files: [] })
  const list = [
    dispatch('old', { startedAt: 1, showcase: s('первый') }),
    dispatch('new', { startedAt: 3, showcase: s('после «Вернуть»') }),
    dispatch('failed', { startedAt: 4, outcome: 'failed', showcase: s('упал') }),
    dispatch('noshow', { startedAt: 5 }),
    dispatch('other', { startedAt: 6, taskId: 't2', showcase: s('чужой') })
  ]
  assert.equal(latestShowcase(list, 't1')?.id, 'new')
  assert.equal(latestShowcase(list, 't3'), undefined)
})

test('из body approval вычитается раздел «## Показ» с разделителем', () => {
  const showcase = { text: 'Вариант A — плотный\n\nВариант B — воздушный', files: ['design/a.png', 'design/b.html'] }
  const body = ['Выберите вариант', '**Итог воркера:** два макета', showcaseMarkdown(showcase), 'Ветка: `orca/t1`'].join('\n\n')
  assert.equal(bodyWithoutShowcase(body, showcase), 'Выберите вариант\n\n**Итог воркера:** два макета\n\nВетка: `orca/t1`')
  assert.equal(bodyWithoutShowcase(`${showcaseMarkdown(showcase)}\n\nВетка`, showcase), 'Ветка', 'раздел первым')
  assert.equal(bodyWithoutShowcase(showcaseMarkdown(showcase), showcase), undefined, 'body — только показ')
  assert.equal(bodyWithoutShowcase(body, { files: ['другой.png'] }), body, 'не совпало — body как есть')
  assert.equal(bodyWithoutShowcase(body, undefined), body)
})

test('старые main/preload — понятная ошибка «перезапустите приложение»', () => {
  assert.throws(() => showcaseApi({}), { message: showcaseStaleMessage() })
  assert.throws(() => showcaseApi(undefined), { message: showcaseStaleMessage() })
  assert.equal(showcaseErrorText("No handler registered for 'showcase:read'"), showcaseStaleMessage())
  assert.equal(showcaseErrorText('показ: файл не найден: a.png'), 'показ: файл не найден: a.png')
})

test('requestShowcaseTaskId: у approval задачи — она сама; у approval прогона без задачи — задача dispatch, сдавшего показ', () => {
  const dispatches = [dispatch('d1', { taskId: 't9' })]
  assert.equal(requestShowcaseTaskId(approval({ showcaseDispatchId: 'd1' }), dispatches), 't1')
  const { taskId: _taskId, ...runLevel } = approval({ showcaseDispatchId: 'd1' })
  assert.equal(requestShowcaseTaskId(runLevel, dispatches), 't9')
  assert.equal(requestShowcaseTaskId({ ...runLevel, showcaseDispatchId: 'gone' }, dispatches), undefined)
  assert.equal(requestShowcaseTaskId({ ...runLevel, showcaseDispatchId: undefined }, dispatches), undefined)
  assert.equal(requestShowcaseTaskId(runLevel, undefined), undefined)
})

const group = (dispatchId: string, files: string[], title?: string): ShowcaseGroup =>
  showcaseGroup('t1', dispatchId, { files }, title)

test('порядок вариантов — как сдал воркер, через группы подзадач; ←/→ не зацикливаются', () => {
  const groups = [group('d1', ['a.html', 'b.html']), group('d2', ['c.png'], 'Подзадача 2'), group('d3', [])]
  assert.deepEqual(showcaseOrder(groups), [{ group: 0, file: 0 }, { group: 0, file: 1 }, { group: 1, file: 0 }])
  assert.deepEqual(stepShowcase(groups, { group: 0, file: 1 }, 1), { group: 1, file: 0 }, 'через границу группы')
  assert.deepEqual(stepShowcase(groups, { group: 1, file: 0 }, 1), { group: 1, file: 0 }, 'на последнем — остаёмся')
  assert.deepEqual(stepShowcase(groups, { group: 0, file: 0 }, -1), { group: 0, file: 0 }, 'на первом — остаёмся')
  assert.equal(showcaseIndex(groups, { group: 1, file: 0 }), 2)
  assert.equal(groups[1].title, 'Подзадача 2')
  assert.equal(groups[0].title, undefined)
  assert.deepEqual(clampShowcasePos(groups, { group: 5, file: 0 }), { group: 0, file: 0 }, 'группы сменились — первый файл')
  assert.equal(clampShowcasePos([group('d', [])], { group: 0, file: 0 }), undefined, 'файлов нет')
})

test('isPreviewUrl: во фрейм ставится только orca-preview://', () => {
  assert.equal(isPreviewUrl('orca-preview://0123abcd/design/a.html'), true)
  assert.equal(isPreviewUrl('orca-preview://0123abcd/%D0%BC%D0%B0%D0%BA%D0%B5%D1%82.html'), true)
  for (const bad of ['https://evil.example/a.html', 'javascript:alert(1)', 'file:///etc/passwd', 'ORCA-PREVIEW://x/a.html', ' orca-preview://x/a', 'orca-preview:a.html', '', undefined, null, 42]) {
    assert.equal(isPreviewUrl(bad), false, String(bad))
  }
})

test('showcasePreviewApi: в старом preload нет previewUrl — «перезапустите», а не падение', () => {
  assert.throws(() => showcasePreviewApi(undefined), ShowcaseStaleError)
  const oldPreload = { showcase: { read: async () => ({ mime: '', bytes: new Uint8Array() }), open: async () => {}, reveal: async () => {} } } as unknown as Partial<OrcaApi>
  assert.throws(() => showcasePreviewApi(oldPreload), ShowcaseStaleError)
  assert.equal(showcaseFailure(new ShowcaseStaleError()).kind, 'stale')
  const calls: unknown[][] = []
  const api = { showcase: { previewUrl: async (...args: unknown[]) => { calls.push(args); return { url: 'orca-preview://t/a.html', mime: 'text/html', base: 'orca-preview://t/' } } } } as unknown as Partial<OrcaApi>
  void showcasePreviewApi(api)('d1', 'a.html', { network: false })
  assert.deepEqual(calls, [['d1', 'a.html', { network: false }]])
  assert.doesNotThrow(() => onShowcaseFrameEscape(oldPreload, () => {})(), 'нет onFrameEscape — пустая отписка')
})

test('ошибка IPC → состояние просмотрщика по коду OrcaError, не по тексту', () => {
  const ipc = (code: string, text: string): Error => new Error(`Error invoking remote method 'showcase:read': OrcaError[${code}]: ${text}`)
  assert.deepEqual(showcaseFailure(ipc('showcase.notFound', 'file not found: a.png')), { kind: 'missing', message: 'file not found: a.png' })
  assert.equal(showcaseFailure(ipc('showcase.noWorktree', 'x')).kind, 'missing')
  assert.equal(showcaseFailure(ipc('showcase.tooBig', 'x')).kind, 'big')
  assert.equal(showcaseFailure(ipc('showcase.outside', 'x')).kind, 'error')
  assert.equal(showcaseFailure(new Error("Error invoking remote method 'showcase:previewUrl': Error: No handler registered for 'showcase:previewUrl'")).kind, 'stale')
  assert.deepEqual(showcaseFailure(new Error('EACCES')), { kind: 'error', message: 'EACCES' })
})

test('виртуальная ширина: страница видит пресет, в место вписывается масштабом', () => {
  const desk = fitFrame(SHOWCASE_VIEWPORTS.desktop, 834, 600)
  assert.equal(desk.frameWidth, 1280)
  assert.equal(Math.round(desk.scale * 100), 65)
  assert.equal(Math.round(desk.outerWidth), 834)
  assert.equal(Math.round(desk.frameHeight * desk.scale), 598, 'высота — всё доступное место')
  const phone = fitFrame(SHOWCASE_VIEWPORTS.mobile, 834, 600)
  assert.equal(phone.scale, 1, 'телефон помещается без масштаба')
  assert.equal(phone.outerHeight, 600, 'высота устройства ограничена местом')
  const tall = fitFrame(SHOWCASE_VIEWPORTS.mobile, 834, 2000)
  assert.equal(tall.frameHeight, 812, 'не выше самого устройства')
  const inline = fitFrame(INLINE_VIEWPORTS.desktop, 400, 360)
  assert.equal(scalePercent(inline.scale), 39)
  assert.equal(inline.outerHeight, 360)
  assert.equal(scalePercent(fitFrame(INLINE_VIEWPORTS.mobile, 400, 360).scale), 100)
  assert.equal(fitFrame(SHOWCASE_VIEWPORTS.desktop, 10, 10).scale, 0.1, 'масштаб не уходит в ноль')
})
