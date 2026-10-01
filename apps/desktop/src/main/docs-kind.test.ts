// Запуск: pnpm --filter @orca-board/desktop test. Классификация файлов «Документов» (`shared/docs-view.ts`):
// тест лежит в main, потому что из `shared/` тесты не запускаются.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DOC_IMAGE_MAX_BYTES, DOC_SNIFF_BYTES, DOC_TEXT_MAX_BYTES, DOCS_LIST_LIMIT, docKindOf } from '../shared/docs-view'
import { SHOWCASE_READ_MAX_BYTES } from '../shared/showcase'
import { DOC_VIEW_ERROR_CODES, PROJECT_FILES_ERROR_CODES } from '../shared/ipc'
import ru from './strings/ru'
import en from './strings/en'

const kind = (p: string): string => docKindOf(p).kind

describe('docKindOf', () => {
  it('виды по расширению', () => {
    assert.deepEqual(docKindOf('docs/README.md'), { kind: 'markdown', mime: 'text/markdown', language: 'Markdown' })
    assert.equal(kind('notes.markdown'), 'markdown')
    assert.deepEqual(docKindOf('src/index.html'), { kind: 'html', mime: 'text/html', language: 'HTML' })
    assert.equal(kind('a.htm'), 'html')
    assert.deepEqual(docKindOf('spec.pdf'), { kind: 'pdf', mime: 'application/pdf' })
    assert.deepEqual(docKindOf('img/logo.png'), { kind: 'image', mime: 'image/png' })
    assert.equal(docKindOf('a.jpg').mime, 'image/jpeg')
    assert.deepEqual(docKindOf('icon.svg'), { kind: 'image', mime: 'image/svg+xml', language: 'SVG' })
    for (const ext of ['webp', 'gif', 'avif', 'ico', 'bmp']) assert.equal(kind(`x.${ext}`), 'image', ext)
    assert.deepEqual(docKindOf('src/main.ts'), { kind: 'text', language: 'TypeScript' })
    assert.equal(docKindOf('package.json').language, 'JSON')
    assert.equal(docKindOf('ci.yml').language, 'YAML')
    assert.deepEqual(docKindOf('notes.txt'), { kind: 'text' })
    for (const ext of ['zip', 'exe', 'woff2', 'mp4', 'sqlite', 'tiff', 'docx']) assert.equal(kind(`x.${ext}`), 'binary', ext)
  })

  it('регистр расширения и имени не важен', () => {
    assert.equal(kind('PHOTO.PNG'), 'image')
    assert.equal(kind('Docs/Guide.MD'), 'markdown')
    assert.equal(docKindOf('App.TSX').language, 'TypeScript')
    assert.equal(docKindOf('MAKEFILE').language, 'Makefile')
  })

  it('составные расширения — по последнему', () => {
    assert.equal(docKindOf('src/types.d.ts').language, 'TypeScript')
    assert.equal(docKindOf('src/docs.test.ts').language, 'TypeScript')
    assert.equal(docKindOf('archive.tar.gz').kind, 'binary')
    assert.equal(docKindOf('.eslintrc.json').language, 'JSON')
    assert.equal(kind('LICENSE.md'), 'markdown')
  })

  it('файлы без расширения — по имени', () => {
    assert.equal(docKindOf('Makefile').language, 'Makefile')
    assert.equal(docKindOf('docker/Dockerfile').language, 'Dockerfile')
    assert.equal(docKindOf('Dockerfile.dev').language, 'Dockerfile')
    assert.equal(kind('LICENSE'), 'text')
    assert.equal(kind('LICENSE-MIT'), 'text')
    assert.equal(kind('.github/CODEOWNERS'), 'text')
    assert.equal(docKindOf('Gemfile').language, 'Ruby')
  })

  it('точечные файлы показываются как обычные', () => {
    assert.deepEqual(docKindOf('.env'), { kind: 'text', language: 'dotenv' })
    assert.equal(docKindOf('apps/api/.env.local').language, 'dotenv')
    assert.equal(docKindOf('.gitignore').language, 'gitignore')
    assert.equal(kind('.editorconfig'), 'text')
    assert.equal(kind('.nvmrc'), 'text')
    assert.equal(docKindOf('.github/workflows/ci.yml').language, 'YAML')
  })

  it('неизвестное — unknown: решает содержимое в main', () => {
    assert.deepEqual(docKindOf('bin/tool'), { kind: 'unknown' })
    assert.equal(kind('data.xyz123'), 'unknown')
    assert.equal(kind('.somerc'), 'unknown')
    assert.equal(kind('trailing.'), 'unknown')
    assert.equal(kind(''), 'unknown')
    assert.equal(kind('dir/'), 'unknown')
  })

  it('имена свойств Object.prototype не находятся в таблицах', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'x.constructor', 'a.__proto__']) {
      assert.deepEqual(docKindOf(name), { kind: 'unknown' }, name)
    }
  })

  it('разделитель — и `/`, и `\\`: вид по имени, а не по папке', () => {
    assert.equal(kind('a.md/readme'), 'text')
    assert.equal(kind('a.png\\notes.md'), 'markdown')
    assert.equal(kind('Makefile.d/x.bin'), 'binary')
  })
})

describe('контракт docs:view', () => {
  it('лимиты', () => {
    assert.equal(DOC_TEXT_MAX_BYTES, 1024 * 1024)
    assert.equal(DOC_IMAGE_MAX_BYTES, SHOWCASE_READ_MAX_BYTES)
    assert.equal(DOCS_LIST_LIMIT, 100_000)
    assert.equal(DOC_SNIFF_BYTES, 8192)
  })

  it('files.notFile и коды docs:* есть в словарях main ru и en', () => {
    const codes: readonly string[] = [...DOC_VIEW_ERROR_CODES, 'files.notFile']
    assert.ok((PROJECT_FILES_ERROR_CODES as readonly string[]).includes('files.notFile'))
    for (const code of codes) {
      assert.ok(Object.hasOwn(ru, code), `ru: ${code}`)
      assert.ok(Object.hasOwn(en, code), `en: ${code}`)
    }
  })

  it('shared/docs-view.ts без импортов: его грузит renderer', () => {
    const src = readFileSync(path.join(import.meta.dirname, '../shared/docs-view.ts'), 'utf8')
    assert.doesNotMatch(src, /^\s*import\s/m)
    assert.doesNotMatch(src, /require\(/)
  })
})
