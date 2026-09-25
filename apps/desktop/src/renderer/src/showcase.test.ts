import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Dispatch, HumanRequest } from '@orca-board/core'
import { showcaseMarkdown } from '../../shared/showcase'
import {
  showcaseStaleMessage, autoPreviewPaths, bodyWithoutShowcase, latestShowcase, requestShowcase, showcaseApi,
  showcaseErrorText, showcaseFiles
} from './showcase'

const dispatch = (id: string, extra: Partial<Dispatch> = {}): Dispatch =>
  ({ id, taskId: 't1', ptyId: 'p', startedAt: 1, outcome: 'done', ...extra })

const approval = (extra: Partial<HumanRequest> = {}): HumanRequest => ({
  id: 'r1', runId: 'run', taskId: 't1', kind: 'approval', status: 'pending', title: 'Выбрать вариант', options: [], createdAt: 1, ...extra
})

test('вид файла по расширению: картинки — превью, md — текст, html/pdf — открыть, прочее — только путь', () => {
  const items = showcaseFiles(['design/a.PNG', 'design/b.svg', 'notes.md', 'design/a.html', 'spec.pdf', 'run.sh', 'Makefile'])
  assert.deepEqual(items.map((f) => [f.name, f.view]), [
    ['a.PNG', 'image'], ['b.svg', 'image'], ['notes.md', 'markdown'], ['a.html', 'open'], ['spec.pdf', 'open'], ['run.sh', 'none'], ['Makefile', 'none']
  ])
})

test('сразу превьюятся только первые картинки по порядку воркера', () => {
  const items = showcaseFiles(['a.html', '1.png', '2.jpg', 'x.md', '3.webp', '4.gif'])
  assert.deepEqual([...autoPreviewPaths(items, 3)], ['1.png', '2.jpg', '3.webp'])
  assert.equal(autoPreviewPaths(showcaseFiles(['a.html', 'b.md'])).size, 0)
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
