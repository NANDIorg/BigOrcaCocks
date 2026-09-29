import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReferences, checkVersions, collectReferences, documentAnchors, slugify } from './readme-check.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const none = (problems) => assert.equal(problems.length, 0, `\n${problems.join('\n')}`)

// Git-фикстуры и файлы — только во временной папке, рабочий репозиторий не трогаем.
function fixture(t, files) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-readme-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
  return directory
}

test('README.md: относительные ссылки и картинки (markdown, <img>, <source srcset>) ведут на существующие файлы', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const local = collectReferences(readme).filter((r) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r))
  assert.ok(local.length > 0, 'парсер не нашёл ни одной относительной ссылки — README или разбор сломаны')
  none(checkReferences(root).files)
})

test('README.md: якоря #… есть среди заголовков README и целевых документов', () => {
  none(checkReferences(root).anchors)
})

test('README.md: версии Node и pnpm совпадают с .nvmrc, engines и packageManager', () => {
  none(checkVersions(root))
})

test('slugify: как на GitHub — пробелы в дефисы без схлопывания, пунктуация и символы вырезаются', () => {
  assert.equal(slugify('Как это работает'), 'как-это-работает')
  assert.equal(slugify('Фон, трей, обновления, ru/en'), 'фон-трей-обновления-ruen')
  // «→» вырезается, пробелы вокруг остаются — двойной дефис; этот якорь стоит в README.
  assert.equal(
    slugify('Ветка глобальной задачи (src/main/run-branch.ts чистая часть → packages/core/src/run-branch.ts)'),
    'ветка-глобальной-задачи-srcmainrun-branchts-чистая-часть--packagescoresrcrun-branchts'
  )
})

test('documentAnchors: заголовки без разметки, повторы с суффиксом, код и комментарии пропускаются', () => {
  const anchors = documentAnchors(
    ['# Заголовок `code` и [ссылка](x.md)', '## Повтор', '## Повтор', '```', '# комментарий в примере', '```', '<!-- ## Скрытый -->', '<a id="ручной"></a>'].join('\n')
  )
  assert.deepEqual([...anchors].sort(), ['заголовок-code-и-ссылка', 'повтор', 'повтор-1', 'ручной'].sort())
})

test('collectReferences: ссылки, картинки, [x]: url, href/src/srcset; код и внешние адреса не мешают', () => {
  const found = collectReferences(
    [
      '[док](docs/a.md#раздел) и ![схема](docs/b.svg) в [![бейдж](https://img.example/x.svg)](https://example.com)',
      '[ref]: docs/c.md',
      '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/d-dark.svg"><source srcset="docs/e.svg 1x, docs/f.svg 2x">',
      '<img src="docs/g.svg" alt="a → b"></picture>',
      '<a href="#якорь">к якорю</a>',
      'В тексте `[не ссылка](docs/нет.md)` и блок:',
      '```',
      '[тоже](docs/нет2.md) <img src="docs/нет3.svg">',
      '```'
    ].join('\n')
  )
  assert.deepEqual(found, ['docs/a.md#раздел', 'docs/b.svg', 'https://img.example/x.svg', 'https://example.com', 'docs/c.md', 'docs/d-dark.svg', 'docs/e.svg', 'docs/f.svg', 'docs/g.svg', '#якорь'])
})

test('checkReferences: находит битые файлы, папки, регистр, выход за репозиторий и несуществующие якоря', (t) => {
  const directory = fixture(t, {
    'README.md': [
      '# Название',
      '',
      '[есть](docs/guide.md) [папка](docs/dir/) [якорь](#название) [чужой якорь](docs/guide.md#раздел)',
      '![есть](docs/pic.svg) <img src="docs/pic.svg">',
      '[нет файла](docs/missing.md) ![нет картинки](docs/missing.svg) <source srcset="docs/missing-dark.svg">',
      '[не тот регистр](docs/Guide.md) [файл как папка](docs/guide.md/) [наружу](../secret.md)',
      '[нет якоря](#нет-такого) [нет якоря в доке](docs/guide.md#нет-раздела)'
    ].join('\n'),
    'docs/guide.md': '# Гайд\n\n## Раздел\n',
    'docs/dir/index.md': '',
    'docs/pic.svg': '<svg/>'
  })
  const { files, anchors } = checkReferences(directory)
  assert.equal(files.length, 6, files.join('\n'))
  for (const target of ['docs/missing.md', 'docs/missing.svg', 'docs/missing-dark.svg', 'docs/Guide.md', 'docs/guide.md/', '../secret.md']) {
    assert.ok(files.some((problem) => problem.includes(`«${target}»`)), `не найдена ошибка про ${target}`)
  }
  assert.equal(anchors.length, 2, anchors.join('\n'))
  assert.ok(anchors.some((problem) => problem.includes('#нет-такого')))
  assert.ok(anchors.some((problem) => problem.includes('#нет-раздела')))
})

test('checkReferences: корректный README без замечаний', (t) => {
  const directory = fixture(t, {
    'README.md': '# Установка\n\n[к разделу](#установка) [док](docs/a.md#часть) ![лого](docs/l.svg) [сайт](https://example.com/x#y)\n',
    'docs/a.md': '## Часть\n',
    'docs/l.svg': '<svg/>'
  })
  assert.deepEqual(checkReferences(directory), { files: [], anchors: [] })
})

test('checkVersions: расхождение с .nvmrc, engines и packageManager ловится, совместимые формы — нет', (t) => {
  const manifest = JSON.stringify({ engines: { node: '24.x' }, packageManager: 'pnpm@10.33.0' })
  const ok = fixture(t, { 'README.md': 'Нужны **Node.js 24**, Node 24.15.0 и pnpm 10.33.0 (pnpm@10.33.0). Node не нужен пользователю.', '.nvmrc': '24\n', 'package.json': manifest })
  none(checkVersions(ok))

  const bad = fixture(t, { 'README.md': 'Нужны Node.js 22 и pnpm 9.15.0.', '.nvmrc': '24\n', 'package.json': manifest })
  const problems = checkVersions(bad)
  assert.equal(problems.length, 3, problems.join('\n'))
  assert.equal(problems.filter((p) => p.includes('Node 22')).length, 2, 'и .nvmrc, и engines')
  assert.ok(problems.some((p) => p.includes('pnpm 9.15.0') && p.includes('10.33.0')))

  const untracked = fixture(t, { 'README.md': 'pnpm 10.33.0', 'package.json': '{}' })
  assert.equal(checkVersions(untracked).length, 1, 'версия указана, а сверять не с чем')
})
