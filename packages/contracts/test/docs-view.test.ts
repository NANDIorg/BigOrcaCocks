import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { docKindOf } from '../src/index.ts'

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

