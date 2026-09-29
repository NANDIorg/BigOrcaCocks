import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Dispatch, HumanRequest } from '@orca-board/core'
import { showcaseMarkdown } from '../../shared/showcase'
import type { OrcaApi } from '../../shared/ipc'
import {
  showcaseStaleMessage, bodyWithoutShowcase, bodyWithoutShowcases, latestShowcase, requestShowcase, requestShowcases, requestShowcaseGroups,
  requestShowcaseTaskId, showcaseTaskState, showcaseApi,
  showcaseErrorText, showcaseFiles, isPreviewUrl, showcasePreviewApi, showcasePreviewBaseApi, ShowcaseStaleError, showcaseFailure, onShowcaseFrameEscape,
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

test('requestShowcases: approval прогона — по showcaseDispatchIds, с названием и состоянием подзадачи', () => {
  const a = { text: 'макеты', files: ['design/a.html'] }
  const b = { files: ['shots/1.png', 'shots/2.png'] }
  const dispatches = [dispatch('d1', { taskId: 'ta', showcase: a }), dispatch('d2', { taskId: 'tb', showcase: b }), dispatch('d3', { taskId: 'tc' })]
  const tasks = [{ id: 'ta', title: 'Экран настроек', status: 'done' }, { id: 'tb', title: 'Иконки', status: 'review' }]
  const kindOf = (status: string) => (status === 'done' ? 'done' : status === 'review' ? 'review' : undefined)
  const { taskId: _taskId, ...runLevel } = approval({ showcaseDispatchId: 'd2', showcaseDispatchIds: ['d1', 'd2', 'd3', 'gone', 'd1'] })
  assert.deepEqual(requestShowcases(runLevel, dispatches, tasks, kindOf), [
    { dispatchId: 'd1', taskId: 'ta', showcase: a, title: 'Экран настроек', state: 'done' },
    { dispatchId: 'd2', taskId: 'tb', showcase: b, title: 'Иконки', state: 'review' }
  ], 'без показа, пропавший и повтор — пропускаются, порядок — как в запросе')
  // Подзадачи ещё нет в снимке — заголовок её id, состояния нет.
  assert.deepEqual(requestShowcases(runLevel, dispatches).map((x) => [x.title, x.state]), [['ta', undefined], ['tb', undefined]])
  assert.deepEqual(requestShowcaseGroups(requestShowcases(runLevel, dispatches, tasks)).map((g) => [g.title, g.dispatchId, g.files.length]), [
    ['Экран настроек', 'd1', 1], ['Иконки', 'd2', 2]
  ])
  assert.equal(requestShowcaseTaskId(runLevel, dispatches), 'ta', 'approval прогона — задача первого показа')
})

test('requestShowcases: старый запрос — только showcaseDispatchId; approval задачи — без заголовка; answer — по dispatchId', () => {
  const s = { files: ['a.png'] }
  const dispatches = [dispatch('d1', { showcase: s }), dispatch('d2', { showcase: { files: ['b.md'] } }), dispatch('d3')]
  assert.deepEqual(requestShowcases(approval({ showcaseDispatchId: 'd1' }), dispatches), [{ dispatchId: 'd1', taskId: 't1', showcase: s }])
  const { taskId: _t, ...oldRunLevel } = approval({ showcaseDispatchId: 'd1' })
  assert.deepEqual(requestShowcases(oldRunLevel, dispatches).map((x) => [x.dispatchId, x.taskId, x.title]), [['d1', 't1', 't1']])
  const answer = approval({ kind: 'answer', dispatchId: 'd2', showcaseDispatchId: 'd1' })
  assert.deepEqual(requestShowcases(answer, dispatches).map((x) => x.dispatchId), ['d2'], 'answer — показ запуска, сдавшего ответ')
  assert.deepEqual(requestShowcases(approval({ kind: 'answer', dispatchId: 'd3' }), dispatches), [], 'ответ без --show')
  assert.deepEqual(requestShowcases(approval({ kind: 'question', dispatchId: 'd1' }), dispatches), [])
  assert.deepEqual(requestShowcases(approval({ showcaseDispatchId: 'd1' }), undefined), [])
  assert.equal(requestShowcase(answer, dispatches), undefined, 'requestShowcase — только approval')
})

test('состояние подзадачи блока показа — по виду колонки', () => {
  assert.equal(showcaseTaskState('done'), 'done')
  assert.equal(showcaseTaskState('review'), 'review')
  assert.equal(showcaseTaskState('in_progress'), 'work')
  assert.equal(showcaseTaskState('custom'), 'work')
  assert.equal(showcaseTaskState(undefined), undefined)
})

test('из body approval прогона вычитаются разделы показа всех подзадач вместе с заголовками', () => {
  const a = { text: 'макеты', files: ['a.html'] }
  const b = { files: ['b.png'] }
  const body = ['Проверьте', `### Экран\n\n${showcaseMarkdown(a)}`, `### Иконки\n\n${showcaseMarkdown(b)}`, 'Ветка: `feature/x`'].join('\n\n')
  assert.equal(bodyWithoutShowcases(body, [{ showcase: a, title: 'Экран' }, { showcase: b, title: 'Иконки' }]), 'Проверьте\n\nВетка: `feature/x`')
  // Заголовок не совпал (подзадачу переименовали) — вычитается хотя бы раздел, заголовок остаётся.
  assert.equal(bodyWithoutShowcases(body, [{ showcase: b, title: 'Другое' }]), ['Проверьте', `### Экран\n\n${showcaseMarkdown(a)}`, '### Иконки', 'Ветка: `feature/x`'].join('\n\n'))
  assert.equal(bodyWithoutShowcases(body, []), body)
  assert.equal(bodyWithoutShowcases(undefined, [{ showcase: a }]), undefined)
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
  const net = showcaseFailure(ipc('showcase.networkNoSnapshot', 'показ: интернет недоступен'))
  assert.equal(net.kind, 'noNetwork', 'отказ в сети показу без снимка — своё состояние, а не общая ошибка')
  assert.notEqual(net.message, 'показ: интернет недоступен', 'текст — из словаря renderer')
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

test('previewBase: старый preload — undefined (картинки описания подписью), новый — вызов с dispatchId', async () => {
  assert.equal(showcasePreviewBaseApi(undefined), undefined)
  assert.equal(showcasePreviewBaseApi({ showcase: { previewUrl: async () => ({}) } } as unknown as Partial<OrcaApi>), undefined)
  const calls: unknown[] = []
  const api = { showcase: { previewBase: async (id: string) => { calls.push(id); return 'orca-preview://t/' } } } as unknown as Partial<OrcaApi>
  assert.equal(await showcasePreviewBaseApi(api)?.('d1'), 'orca-preview://t/')
  assert.deepEqual(calls, ['d1'])
})
