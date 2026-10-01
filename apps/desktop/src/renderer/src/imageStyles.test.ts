// Страж: компоненты вложений (миниатюры, карточки файлов) и просмотра рендерят эти классы, и у каждого должно быть правило в styles.css.
// Однажды правила `.coord-image*` пропали при слиянии двух PR, и скриншоты рисовались в натуральную величину.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function rules(): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(css); m; m = re.exec(css)) out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] })
  return out
}

const exact = (cls: string): { selectors: string[]; body: string }[] => rules().filter((r) => r.selectors.includes(`.${cls}`))

const CLASSES = [
  'attach-images',
  'attach-image',
  'attach-image-open',
  'attach-image-loading',
  'attach-image-remove',
  'attach-file',
  'attach-file-icon',
  'attach-file-ext',
  'attach-file-body',
  'attach-file-name',
  'attach-file-size',
  'attach-file-actions',
  'attach-file-btn',
  'attach-file-remove',
  'attach-error',
  'lightbox',
  'lightbox-btn',
  'lightbox-close',
  'lightbox-prev',
  'lightbox-next'
]

test('у каждого класса миниатюр, карточек файлов и просмотра есть правило', () => {
  assert.deepEqual(CLASSES.filter((c) => exact(c).length === 0), [])
})

test('миниатюра ограничена по ширине и высоте, картинка в ней вписана', () => {
  const body = exact('attach-image').map((r) => r.body).join(';')
  assert.match(body, /(^|[\s;])width:/)
  assert.match(body, /(^|[\s;])height:/)
  assert.match(body, /overflow:\s*hidden/)
  const img = rules().filter((r) => r.selectors.includes('.attach-image img')).map((r) => r.body).join(';')
  assert.match(img, /object-fit:\s*cover/)
})

test('карточка файла ограничена по ширине и высоте, длинное имя обрезается, в тесном виде — 48 px', () => {
  const body = exact('attach-file').map((r) => r.body).join(';')
  assert.match(body, /(^|[\s;])width:/)
  assert.match(body, /(^|[\s;])height:\s*72px/)
  assert.match(body, /overflow:\s*hidden/)
  const name = exact('attach-file-name').map((r) => r.body).join(';')
  assert.match(name, /text-overflow:\s*ellipsis/)
  assert.match(name, /white-space:\s*nowrap/)
  // min-width: 0 у flex-колонки — иначе имя не сожмётся и выдавит кнопки за край карточки.
  assert.match(exact('attach-file-body').map((r) => r.body).join(';'), /min-width:\s*0/)
  const compact = rules().filter((r) => r.selectors.includes('.attach.compact .attach-file')).map((r) => r.body).join(';')
  assert.match(compact, /height:\s*48px/)
})

test('просмотр — fixed-оверлей поверх остальных слоёв', () => {
  const body = exact('lightbox').map((r) => r.body).join(';')
  assert.match(body, /position:\s*fixed/)
  assert.match(body, /z-index:/)
})

test('в стилях не осталось семейства coord-image', () => {
  assert.doesNotMatch(css, /\.coord-image/)
})
