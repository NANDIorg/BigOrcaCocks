// Запуск: pnpm --filter @orca-board/desktop test. Просмотр любого файла «Документов» (main/docs-view.ts) на временном
// git-репозитории: виды и заглушки, лимиты, превью без сети, белый список «Открыть», отказы пути кодами.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DOC_IMAGE_MAX_BYTES, DOC_SNIFF_BYTES, DOC_TEXT_MAX_BYTES } from '../shared/docs-view'
import { OrcaError } from './i18n'
import { PreviewTokens, resolvePreviewRequest } from './preview-protocol'
import { splitSafeSegments } from './project-files'
import {
  docsOpenPath, docsPreviewUrl, docsRevealPath, readDocBytes, resolveDocFile, sniffText, viewDoc, viewResolved
} from './docs-view'

let tmp: string
let repo: string

function write(root: string, rel: string, data: string | Uint8Array = 'x\n'): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), data)
}

/** Пустой файл заданного размера без записи байтов (разреженный): лимиты в 10 МиБ без нагрузки на диск. */
function sized(rel: string, size: number): void {
  write(repo, rel, '')
  truncateSync(path.join(repo, rel), size)
}

/** Отказ с кодом (ключ словаря main) и без абсолютного пути в тексте: наружу не отдаём, где лежит проект. */
async function rejectsWith(p: Promise<unknown>, code: string, echo = false): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof OrcaError, String(e))
    assert.equal(e.key, code, e.message)
    // echo — вызывающий сам прислал абсолютный путь (или это корень проекта): ошибка его повторяет, это не утечка.
    if (!echo) assert.ok(!e.message.includes(tmp), `абсолютный путь в ошибке: ${e.message}`)
    return true
  })
}

beforeEach(() => {
  // `.native`: на Windows обычный realpathSync оставляет короткое 8.3-имя (`RUNNER~1`), а код отдаёт полный путь.
  tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'orca-docs-view-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  write(repo, 'README.md', '# readme\n')
  write(repo, 'src/index.ts', 'export const a = 1\n')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe('sniffText', () => {
  it('NUL в первых байтах — binary, после окна — не смотрим; BOM срезается; не UTF-8 — notUtf8', () => {
    assert.deepEqual(sniffText(new Uint8Array([0x61, 0, 0x62])), { stub: 'binary' })
    const late = new Uint8Array(DOC_SNIFF_BYTES + 2).fill(0x61)
    late[DOC_SNIFF_BYTES + 1] = 0
    assert.ok('text' in sniffText(late))
    assert.deepEqual(sniffText(new Uint8Array([0xef, 0xbb, 0xbf, 0x70, 0x72])), { text: 'pr' })
    assert.deepEqual(sniffText(new Uint8Array([0xc0, 0xaf])), { stub: 'notUtf8' })
    assert.deepEqual(sniffText(Buffer.from('привет\r\n', 'utf8')), { text: 'привет\r\n' })
    assert.deepEqual(sniffText(new Uint8Array()), { text: '' })
  })
})

describe('viewDoc: виды', () => {
  it('markdown и код — с текстом, язык не нужен main, openable по белому списку', async () => {
    const md = await viewDoc(repo, 'README.md')
    assert.equal(md.kind, 'markdown')
    assert.equal(md.text, '# readme\n')
    assert.equal(md.openable, true)
    assert.equal(md.stub, undefined)
    const ts = await viewDoc(repo, 'src/index.ts')
    assert.deepEqual({ kind: ts.kind, text: ts.text, openable: ts.openable, size: ts.size }, {
      kind: 'text', text: 'export const a = 1\n', openable: false, size: 19
    })
    assert.ok(ts.mtime > 0)
  })

  it('.env и файл без расширения — текст; неизвестный с NUL — binary', async () => {
    write(repo, '.env', 'KEY=1\n')
    write(repo, 'NOEXT', 'plain text\n')
    write(repo, 'blob', new Uint8Array([1, 2, 0, 3]))
    assert.equal((await viewDoc(repo, '.env')).text, 'KEY=1\n')
    const noext = await viewDoc(repo, 'NOEXT')
    assert.deepEqual([noext.kind, noext.text], ['text', 'plain text\n'])
    const blob = await viewDoc(repo, 'blob')
    assert.deepEqual([blob.kind, blob.stub, blob.text], ['binary', 'binary', undefined])
  })

  it('картинка — без текста, с mime; SVG с source — исходник', async () => {
    write(repo, 'img/a.png', PNG)
    write(repo, 'img/i.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const png = await viewDoc(repo, 'img/a.png', { source: true })
    assert.deepEqual([png.kind, png.mime, png.text, png.stub, png.openable], ['image', 'image/png', undefined, undefined, true])
    const svg = await viewDoc(repo, 'img/i.svg')
    assert.deepEqual([svg.kind, svg.mime, svg.text], ['image', 'image/svg+xml', undefined])
    assert.equal((await viewDoc(repo, 'img/i.svg', { source: true })).text, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  })

  it('HTML — текст только с source; PDF и бинарное расширение — заглушки', async () => {
    write(repo, 'page.html', '<h1>hi</h1>')
    write(repo, 'doc.pdf', '%PDF-1.4')
    write(repo, 'a.zip', 'PK')
    const html = await viewDoc(repo, 'page.html')
    assert.deepEqual([html.kind, html.mime, html.text, html.openable], ['html', 'text/html', undefined, true])
    assert.equal((await viewDoc(repo, 'page.html', { source: true })).text, '<h1>hi</h1>')
    // мусор вместо opts — как без них
    assert.equal((await viewDoc(repo, 'page.html', 'source')).text, undefined)
    const pdf = await viewDoc(repo, 'doc.pdf')
    assert.deepEqual([pdf.kind, pdf.stub, pdf.text, pdf.openable], ['pdf', 'pdf', undefined, true])
    const zip = await viewDoc(repo, 'a.zip')
    assert.deepEqual([zip.kind, zip.stub, zip.openable], ['binary', 'binary', false])
  })

  it('.ts с NUL — вид text, заглушка binary; не UTF-8 — notUtf8; BOM срезан; пустой файл — пустой текст', async () => {
    write(repo, 'nul.ts', new Uint8Array([0x61, 0, 0x62]))
    write(repo, 'cp1251.txt', new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))
    write(repo, 'bom.json', new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{}')]))
    write(repo, 'empty.txt', '')
    const nul = await viewDoc(repo, 'nul.ts')
    assert.deepEqual([nul.kind, nul.stub, nul.text], ['text', 'binary', undefined])
    const cp = await viewDoc(repo, 'cp1251.txt')
    assert.deepEqual([cp.kind, cp.stub, cp.text], ['text', 'notUtf8', undefined])
    const bom = await viewDoc(repo, 'bom.json')
    assert.deepEqual([bom.text, bom.size], ['{}', 5])
    const empty = await viewDoc(repo, 'empty.txt')
    assert.deepEqual([empty.kind, empty.text, empty.size], ['text', '', 0])
  })
})

describe('viewDoc: лимиты', () => {
  it('текст больше DOC_TEXT_MAX_BYTES — tooBig без текста, ровно лимит — текст', async () => {
    write(repo, 'edge.txt', 'a'.repeat(DOC_TEXT_MAX_BYTES))
    write(repo, 'big.md', 'a'.repeat(DOC_TEXT_MAX_BYTES + 1))
    assert.equal((await viewDoc(repo, 'edge.txt')).text?.length, DOC_TEXT_MAX_BYTES)
    const big = await viewDoc(repo, 'big.md')
    assert.deepEqual([big.kind, big.stub, big.text, big.size], ['markdown', 'tooBig', undefined, DOC_TEXT_MAX_BYTES + 1])
  })

  it('большой файл без расширения — вид по первым байтам', async () => {
    write(repo, 'bigtext', 'a'.repeat(DOC_TEXT_MAX_BYTES + 1))
    sized('bigbin', DOC_TEXT_MAX_BYTES + 1) // нули
    const text = await viewDoc(repo, 'bigtext')
    assert.deepEqual([text.kind, text.stub], ['text', 'tooBig'])
    const bin = await viewDoc(repo, 'bigbin')
    assert.deepEqual([bin.kind, bin.stub], ['binary', 'tooBig'])
  })

  it('картинка больше DOC_IMAGE_MAX_BYTES — tooBig', async () => {
    sized('huge.png', DOC_IMAGE_MAX_BYTES + 1)
    const v = await viewDoc(repo, 'huge.png')
    assert.deepEqual([v.kind, v.stub], ['image', 'tooBig'])
  })

  it('файл вырос между stat и чтением — tooBig, а не обрезанный текст', async () => {
    write(repo, 'grow.log', 'small\n')
    const ref = await resolveDocFile(repo, 'grow.log')
    appendFileSync(path.join(repo, 'grow.log'), 'b'.repeat(DOC_TEXT_MAX_BYTES))
    const v = await viewResolved(ref)
    assert.deepEqual([v.kind, v.stub, v.text], ['text', 'tooBig', undefined])
    // вырос, но в пределах лимита — читается целиком, не по старому размеру
    write(repo, 'grow2.txt', 'ab')
    const ref2 = await resolveDocFile(repo, 'grow2.txt')
    appendFileSync(path.join(repo, 'grow2.txt'), 'cd')
    assert.equal((await viewResolved(ref2)).text, 'abcd')
  })
})

describe('viewDoc: пути и не-файлы', () => {
  it('нет файла, папка, .. , абсолютный путь, NUL, .git — коды без абсолютных путей', async () => {
    await rejectsWith(viewDoc(repo, 'nope.txt'), 'files.notFound')
    await rejectsWith(viewDoc(repo, 'src'), 'files.notFile')
    await rejectsWith(viewDoc(repo, ''), 'files.notFile')
    await rejectsWith(viewDoc(repo, '../x'), 'files.badPath')
    await rejectsWith(viewDoc(repo, 'src/../README.md'), 'files.badPath')
    await rejectsWith(viewDoc(repo, path.join(repo, 'README.md')), 'files.badPath', true)
    await rejectsWith(viewDoc(repo, 'a\0b'), 'files.badPath')
    await rejectsWith(viewDoc(repo, 42), 'files.badPath')
    await rejectsWith(viewDoc(repo, '.git/config'), 'files.hidden')
    await rejectsWith(viewDoc(repo, '.GIT/HEAD'), 'files.hidden')
    await rejectsWith(viewDoc(path.join(tmp, 'нет'), 'README.md'), 'files.rootMissing', true)
  })

  it('win32: `\\` и `:` — badPath', () => {
    for (const bad of ['a\\..\\..\\x', 'C:x', 'file.txt:stream', '.git./config']) {
      assert.throws(() => splitSafeSegments(bad, path.win32), (e: unknown) => e instanceof OrcaError && ['files.badPath', 'files.hidden'].includes(e.key))
    }
  })

  it('симлинк на файл внутри — по цели; наружу (файл и папка), на .git и битый — отказ', async () => {
    write(repo, 'data.json', '{"a":1}')
    write(tmp, 'secret.txt', 'secret')
    symlinkSync(path.join(repo, 'data.json'), path.join(repo, 'alias.json'))
    symlinkSync(path.join(tmp, 'secret.txt'), path.join(repo, 'out.txt'))
    symlinkSync(tmp, path.join(repo, 'outdir'))
    symlinkSync(path.join(repo, '.git'), path.join(repo, 'gitlink'))
    symlinkSync(path.join(repo, 'nope'), path.join(repo, 'broken.txt'))
    const alias = await viewDoc(repo, 'alias.json')
    assert.deepEqual([alias.text, alias.size], ['{"a":1}', 7])
    await rejectsWith(viewDoc(repo, 'out.txt'), 'files.outside')
    await rejectsWith(viewDoc(repo, 'outdir/secret.txt'), 'files.outside')
    await rejectsWith(viewDoc(repo, 'gitlink/config'), 'files.hidden')
    await rejectsWith(viewDoc(repo, 'broken.txt'), 'files.notFound')
  })

  it('FIFO — files.notFile без зависания на open', { skip: process.platform === 'win32' }, async () => {
    execFileSync('mkfifo', [path.join(repo, 'pipe.txt')])
    await rejectsWith(viewDoc(repo, 'pipe.txt'), 'files.notFile')
    await rejectsWith(readDocBytes(repo, 'pipe.txt'), 'files.notFile')
  })
})

describe('readDocBytes', () => {
  it('картинка — байты и mime; не картинка — noPreview; больше лимита — tooBig', async () => {
    write(repo, 'a.png', PNG)
    const b = await readDocBytes(repo, 'a.png')
    assert.equal(b.mime, 'image/png')
    assert.ok(b.bytes instanceof Uint8Array)
    assert.deepEqual([...b.bytes], [...PNG])
    await rejectsWith(readDocBytes(repo, 'src/index.ts'), 'docs.noPreview')
    write(repo, 'page.html', '<p>')
    await rejectsWith(readDocBytes(repo, 'page.html'), 'docs.noPreview')
    sized('huge.webp', DOC_IMAGE_MAX_BYTES + 1)
    await rejectsWith(readDocBytes(repo, 'huge.webp'), 'docs.tooBig')
    await rejectsWith(readDocBytes(repo, '../a.png'), 'files.badPath')
  })
})

describe('docsPreviewUrl', () => {
  it('HTML — адрес протокола без сети, один токен на корень; протокол отдаёт страницу', async () => {
    write(repo, 'site/index.html', '<h1>x</h1>')
    write(repo, 'docs/guide.md', '# g')
    const tokens = new PreviewTokens()
    const p = await docsPreviewUrl(tokens, repo, 'site/index.html')
    assert.equal(p.mime, 'text/html')
    assert.match(p.url, /^orca-preview:\/\/[0-9a-f]{32}\/site\/index\.html$/)
    assert.ok(p.url.startsWith(p.base))
    const token = p.base.slice('orca-preview://'.length, -1)
    assert.equal(tokens.get(token)?.network, false)
    const md = await docsPreviewUrl(tokens, repo, 'docs/guide.md')
    assert.equal(md.base, p.base)
    assert.equal(tokens.size, 1)
    const r = resolvePreviewRequest({ method: 'GET', url: p.url }, tokens)
    assert.ok(r.ok)
    assert.ok(!r.headers['Content-Security-Policy'].includes('https:'))
  })

  it('не html/markdown, скрытый сегмент, цель другого типа — noPreview', async () => {
    write(repo, '.github/page.html', '<p>')
    write(repo, '.env', 'K=1')
    write(repo, 'a.png', PNG)
    write(repo, 'notes.txt', 't')
    symlinkSync(path.join(repo, 'notes.txt'), path.join(repo, 'fake.html'))
    const tokens = new PreviewTokens()
    await rejectsWith(docsPreviewUrl(tokens, repo, 'src/index.ts'), 'docs.noPreview')
    await rejectsWith(docsPreviewUrl(tokens, repo, 'a.png'), 'docs.noPreview')
    await rejectsWith(docsPreviewUrl(tokens, repo, '.github/page.html'), 'docs.noPreview')
    await rejectsWith(docsPreviewUrl(tokens, repo, '.env'), 'docs.noPreview')
    await rejectsWith(docsPreviewUrl(tokens, repo, 'fake.html'), 'docs.noPreview')
    await rejectsWith(docsPreviewUrl(tokens, repo, 'missing.html'), 'files.notFound')
    assert.equal(tokens.size, 0)
  })
})

describe('docsOpenPath / docsRevealPath', () => {
  it('открывается только белый список, по пути и по цели симлинка', async () => {
    write(repo, 'a.png', PNG)
    write(repo, 'page.html', '<p>')
    write(repo, 'run.sh', '#!/bin/sh\n')
    write(repo, 'go.command', 'echo')
    mkdirSync(path.join(repo, 'Evil.app/Contents'), { recursive: true })
    symlinkSync(path.join(repo, 'run.sh'), path.join(repo, 'trap.png'))
    symlinkSync(path.join(repo, 'a.png'), path.join(repo, 'alias.png'))
    assert.equal(await docsOpenPath(repo, 'a.png'), path.join(repo, 'a.png'))
    assert.equal(await docsOpenPath(repo, 'page.html'), path.join(repo, 'page.html'))
    assert.equal(await docsOpenPath(repo, 'README.md'), path.join(repo, 'README.md'))
    assert.equal(await docsOpenPath(repo, 'alias.png'), path.join(repo, 'a.png'))
    await rejectsWith(docsOpenPath(repo, 'run.sh'), 'docs.notOpenable')
    await rejectsWith(docsOpenPath(repo, 'go.command'), 'docs.notOpenable')
    await rejectsWith(docsOpenPath(repo, 'Evil.app'), 'docs.notOpenable')
    await rejectsWith(docsOpenPath(repo, 'trap.png'), 'docs.notOpenable')
    await rejectsWith(docsOpenPath(repo, 'src/index.ts'), 'docs.notOpenable')
    await rejectsWith(docsOpenPath(repo, '../x.png'), 'files.badPath')
    const v = await viewDoc(repo, 'trap.png')
    assert.equal(v.openable, false)
  })

  it('показать в папке — любой файл, симлинк — сам симлинк', async () => {
    write(repo, 'run.sh', 'x')
    symlinkSync(path.join(repo, 'run.sh'), path.join(repo, 'link.sh'))
    assert.equal(await docsRevealPath(repo, 'run.sh'), path.join(repo, 'run.sh'))
    assert.equal(await docsRevealPath(repo, 'link.sh'), path.join(repo, 'link.sh'))
    await rejectsWith(docsRevealPath(repo, '.git'), 'files.hidden')
    await rejectsWith(docsRevealPath(repo, 'nope'), 'files.notFound')
  })
})
