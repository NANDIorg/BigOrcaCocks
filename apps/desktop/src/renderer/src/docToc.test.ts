import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorId, buildDocToc, findDocHeading, slugify } from './docToc'

test('slugify — как у GitHub: строчные, без пунктуации, кириллица остаётся', () => {
  assert.equal(slugify('Роли и колонки'), 'роли-и-колонки')
  assert.equal(slugify('IPC: main ↔ renderer'), 'ipc-main--renderer')
  assert.equal(slugify('  v1.2 — план  '), 'v12--план')
})

test('buildDocToc — только h2/h3, текст без разметки, id с префиксом', () => {
  const md = '# Заголовок\n\n## Процессы\n\nтекст\n\n### Роли и `kind`\n\n#### Глубже\n\n## **Важно** [ссылка](a.md)\n'
  assert.deepEqual(buildDocToc(md), [
    { level: 2, text: 'Процессы', id: 'doc-процессы' },
    { level: 3, text: 'Роли и kind', id: 'doc-роли-и-kind' },
    { level: 2, text: 'Важно ссылка', id: 'doc-важно-ссылка' }
  ])
})

test('buildDocToc — повторы получают -1, -2; пустой слаг — section; код-блоки не заголовки', () => {
  const md = '## Итог\n\n## Итог\n\n```\n## не заголовок\n```\n\n### Итог\n\n## ???\n\nНастройки\n---\n'
  assert.deepEqual(
    buildDocToc(md).map((h) => h.id),
    ['doc-итог', 'doc-итог-1', 'doc-итог-2', 'doc-section', 'doc-настройки']
  )
})

test('anchorId — #якорь из ссылки в id заголовка, с percent-encoding и регистром', () => {
  assert.equal(anchorId('#процессы'), 'doc-процессы')
  assert.equal(anchorId('#%D0%9F%D1%80%D0%BE%D1%86%D0%B5%D1%81%D1%81%D1%8B'), 'doc-процессы')
  assert.equal(anchorId('#%E0%A4%A'), 'doc-%e0%a4%a')
})

test('findDocHeading — якорь из ссылки, из другого документа и текстом заголовка ведут к id из buildDocToc', () => {
  const ids = buildDocToc('## Роли и колонки\n\n## IPC: main ↔ renderer\n').map((t) => t.id)
  const els = ids.map((id) => ({ id }))
  const root = { querySelectorAll: () => els } as unknown as ParentNode
  assert.equal(findDocHeading(root, '#роли-и-колонки'), els[0])
  assert.equal(findDocHeading(root, 'Роли-и-колонки'), els[0])
  assert.equal(findDocHeading(root, 'Роли и колонки'), els[0])
  assert.equal(findDocHeading(root, '#ipc-main--renderer'), els[1])
  assert.equal(findDocHeading(root, '#нет-такого'), null)
})
