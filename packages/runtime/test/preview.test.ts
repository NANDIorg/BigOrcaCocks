import * as runtime from '../src/index.ts'
import { OrcaError as runtimeFixtureError, fileServices } from './fixtures/file-services.ts'
// Запуск: pnpm --filter @orca-board/runtime test. Протокол orca-preview:// на настоящих файлах во временной папке.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_SHOWCASE_SNAPSHOT_FILE_BYTES } from '@orca-board/core'
import {
  PreviewTokens, allowFrameNavigation, buildPreviewCsp, handlePreviewRequest, isExternalWebUrl, parseRange, previewSegments,
  previewUrlFor, resolvePreviewRequest
} from './fixtures/file-services.ts'

let tmp: string
let root: string
let tokens: PreviewTokens
let token: string

function write(rel: string, data: string | Uint8Array = 'x'): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), data)
}

const get = (p: string, method = 'GET'): ReturnType<typeof resolvePreviewRequest> =>
  resolvePreviewRequest({ method, url: `orca-preview://${token}/${p}` }, tokens)

function refused(p: string, reason: string, status: number, method = 'GET'): void {
  assert.deepEqual(get(p, method), { ok: false, status, reason }, p)
}

beforeEach(() => {
  fileServices()
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-preview-')))
  root = path.join(tmp, 'snap')
  mkdirSync(root)
  write('design/a.html', '<link rel="stylesheet" href="./a.css"><p>A</p>')
  write('design/a.css', 'p{color:red}')
  write('design/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  write('design/font.woff2', new Uint8Array([1, 2, 3]))
  write('design/мой макет.html', '<p>Б</p>')
  write('design/run.sh', 'echo hi')
  write('design/.env', 'SECRET=1')
  write('design/.git/config', 'x')
  write('design/data.bin', 'x')
  writeFileSync(path.join(tmp, 'outside.css'), 'секрет снаружи')
  tokens = new PreviewTokens()
  token = tokens.issue(root, false)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('PreviewTokens', () => {
  it('128 бит hex, уникальны; тот же корень и режим сети — тот же токен, сеть — отдельный', () => {
    assert.match(token, /^[0-9a-f]{32}$/)
    assert.equal(tokens.issue(root, false), token)
    const net = tokens.issue(root, true)
    assert.notEqual(net, token)
    const other = tokens.issue(path.join(tmp, 'other'), false)
    assert.equal(new Set([token, net, other]).size, 3)
    assert.deepEqual(tokens.get(net), { root, network: true })
    assert.equal(tokens.get('0'.repeat(32)), undefined)
  })

  it('LRU: сверх лимита вытесняется давно не использованный токен; get обновляет свежесть', () => {
    const t = new PreviewTokens(3)
    const a = t.issue('/a', false)
    const b = t.issue('/b', false)
    const c = t.issue('/c', false)
    t.get(a)
    const d = t.issue('/d', false)
    assert.equal(t.size, 3)
    assert.equal(t.get(b), undefined)
    assert.ok(t.get(a) && t.get(c) && t.get(d))
  })

  it('совпадение случайного значения с живым токеном — берётся следующее', () => {
    const seq = ['x', 'x', 'y']
    const t = new PreviewTokens(10, () => seq.shift()!)
    assert.equal(t.issue('/a', false), 'x')
    assert.equal(t.issue('/b', false), 'y')
  })
})

describe('buildPreviewCsp', () => {
  it('сеть закрыта: только orca-preview:, data:, blob:; ни https:, ни фреймов, ни форм; sandbox', () => {
    const csp = buildPreviewCsp(false)
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src orca-preview: 'unsafe-inline' 'unsafe-eval'(;|$)/)
    assert.match(csp, /connect-src orca-preview:(;|$)/)
    assert.match(csp, /frame-src 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.match(csp, /base-uri 'none'/)
    assert.match(csp, /sandbox allow-scripts/)
    assert.doesNotMatch(csp, /https?:/)
  })

  it('сеть открыта: https: в script/style/img/font/media/connect, фреймы и формы по-прежнему закрыты', () => {
    const csp = buildPreviewCsp(true)
    for (const d of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src']) {
      assert.match(csp, new RegExp(`${d} [^;]*https:`), d)
    }
    assert.match(csp, /frame-src 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.doesNotMatch(csp, /http:/)
  })
})

describe('resolvePreviewRequest', () => {
  it('HTML: табличный тип с charset, nosniff, no-store, CSP без сети, ACAO и CORP для opaque-origin фрейма', () => {
    const r = get('design/a.html')
    assert.ok(r.ok)
    assert.equal(r.file, path.join(root, 'design/a.html'))
    assert.equal(r.head, false)
    assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8')
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff')
    assert.equal(r.headers['Cache-Control'], 'no-store')
    assert.equal(r.headers['Referrer-Policy'], 'no-referrer')
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*')
    assert.equal(r.headers['Cross-Origin-Resource-Policy'], 'cross-origin')
    assert.match(r.headers['Permissions-Policy'], /camera=\(\)/)
    assert.equal(r.headers['Content-Security-Policy'], buildPreviewCsp(false))
  })

  it('ассеты и SVG: свой тип; SVG — с CSP; токен с сетью меняет CSP', () => {
    const css = get('design/a.css')
    assert.ok(css.ok && css.headers['Content-Type'] === 'text/css; charset=utf-8')
    const font = get('design/font.woff2')
    assert.ok(font.ok && font.headers['Content-Type'] === 'font/woff2')
    const svg = get('design/logo.svg')
    assert.ok(svg.ok && svg.headers['Content-Type'] === 'image/svg+xml; charset=utf-8')
    assert.equal(svg.headers['Content-Security-Policy'], buildPreviewCsp(false))
    token = tokens.issue(root, true)
    const net = get('design/a.html')
    assert.ok(net.ok && net.headers['Content-Security-Policy'] === buildPreviewCsp(true))
  })

  it('кириллица и пробелы в имени — через процентное кодирование; query и hash не мешают; HEAD', () => {
    const r = resolvePreviewRequest({ method: 'GET', url: previewUrlFor(token, ['design', 'мой макет.html']) + '?v=2#top' }, tokens)
    assert.ok(r.ok && r.file.endsWith('мой макет.html'))
    const head = get('design/a.html', 'head')
    assert.ok(head.ok && head.head && head.size > 0)
  })

  it('отказы: метод, чужой токен, .., %2e%2e, закодированный слэш, dot-файлы, неизвестное расширение, нет файла', () => {
    refused('design/a.html', 'method', 405, 'POST')
    refused('design/a.html', 'method', 405, 'PUT')
    assert.deepEqual(resolvePreviewRequest({ method: 'GET', url: `orca-preview://${'0'.repeat(32)}/design/a.html` }, tokens), { ok: false, status: 404, reason: 'token' })
    assert.deepEqual(resolvePreviewRequest({ method: 'GET', url: `https://${token}/design/a.html` }, tokens), { ok: false, status: 400, reason: 'url' })
    refused('design/../design/a.html', 'path', 403)
    refused('../outside.css', 'path', 403)
    refused('design/%2e%2e/%2E%2E/outside.css', 'path', 403)
    refused('design%2F..%2F..%2Foutside.css', 'path', 403)
    refused('design%5C..%5Coutside.css', 'path', 403)
    refused('design/a.html%00.png', 'path', 403)
    refused('design//a.html', 'path', 403)
    refused('design/', 'path', 403)
    refused('', 'path', 403)
    refused('design/.env', 'path', 403)
    refused('design/.git/config', 'path', 403)
    refused('design/%E0%A4%A', 'url', 400)
    refused('design/run.sh', 'type', 403)
    refused('design/data.bin', 'type', 403)
    refused('design/nope.html', 'notFound', 404)
  })

  it('симлинки: наружу — отказ; на исполняемое под видом картинки — отказ; каталог под видом файла — отказ', () => {
    symlinkSync(path.join(tmp, 'outside.css'), path.join(root, 'design/leak.css'))
    refused('design/leak.css', 'outside', 403)
    symlinkSync(path.join(root, 'design/run.sh'), path.join(root, 'design/pic.png'))
    refused('design/pic.png', 'type', 403)
    mkdirSync(path.join(root, 'design/dir.css'))
    refused('design/dir.css', 'notFile', 404)
  })

  it('файл больше лимита снимка — 413', () => {
    write('design/big.mp4', new Uint8Array(MAX_SHOWCASE_SNAPSHOT_FILE_BYTES + 1))
    refused('design/big.mp4', 'tooBig', 413)
  })
})

describe('handlePreviewRequest', () => {
  const req = (p: string, init?: RequestInit): Response => handlePreviewRequest(new Request(`orca-preview://${token}/${p}`, init), tokens)

  it('GET: тело файла с нашими заголовками и длиной', async () => {
    const res = req('design/a.css')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'p{color:red}')
    assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8')
    assert.equal(res.headers.get('content-length'), '12')
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })

  it('Range: 206 с Content-Range; суффикс и открытый конец; за пределами файла — 416', async () => {
    const a = req('design/a.css', { headers: { Range: 'bytes=2-6' } })
    assert.equal(a.status, 206)
    assert.equal(a.headers.get('content-range'), 'bytes 2-6/12')
    assert.equal(await a.text(), 'color')
    assert.equal(await req('design/a.css', { headers: { Range: 'bytes=-3' } }).text(), 'ed}')
    assert.equal(await req('design/a.css', { headers: { Range: 'bytes=11-' } }).text(), '}')
    const bad = req('design/a.css', { headers: { Range: 'bytes=50-60' } })
    assert.equal(bad.status, 416)
    assert.equal(bad.headers.get('content-range'), 'bytes */12')
    // Непонятный Range (несколько диапазонов) — весь файл.
    assert.equal(req('design/a.css', { headers: { Range: 'bytes=0-1,3-4' } }).status, 200)
  })

  it('отказ — пустое тело со статусом; HEAD — только заголовки', async () => {
    const post = req('design/a.html', { method: 'POST', body: 'x' })
    assert.equal(post.status, 405)
    assert.equal(await post.text(), '')
    assert.equal(req('design/.env').status, 403)
    const head = req('design/a.html', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(readFileSync(path.join(root, 'design/a.html')).length))
    assert.match(head.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    assert.equal(await head.text(), '')
  })
})

describe('parseRange', () => {
  it('один диапазон; мусор — undefined; вне файла — unsatisfiable', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), [0, 9])
    assert.deepEqual(parseRange('bytes=90-200', 100), [90, 99])
    assert.deepEqual(parseRange('bytes=-10', 100), [90, 99])
    assert.deepEqual(parseRange('bytes=5-', 100), [5, 99])
    assert.equal(parseRange('bytes=-', 100), undefined)
    assert.equal(parseRange('items=0-1', 100), undefined)
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
    assert.equal(parseRange('bytes=9-2', 100), 'unsatisfiable')
  })
})

describe('previewSegments', () => {
  it('обычный путь — сегменты; пустые, точечные, со слэшем, двоеточием или NUL — undefined', () => {
    assert.deepEqual(previewSegments('design/v 1/a.html'), ['design', 'v 1', 'a.html'])
    for (const p of ['', '/a.html', 'a//b.html', './a.html', 'a/../b.html', '.env', 'a\\b.html', 'C:/a.html', 'a\0.html']) {
      assert.equal(previewSegments(p), undefined, p)
    }
  })
})

describe('allowFrameNavigation', () => {
  const dev = 'http://localhost:5173/'
  const file = 'file:///Applications/orca-board.app/Contents/Resources/app.asar/out/renderer/index.html'

  it('подфрейм — только orca-preview: и about:blank; https, file, data, javascript — нет', () => {
    assert.equal(allowFrameNavigation({ url: `orca-preview://${token}/design/b.html`, isMainFrame: false, appUrl: dev }), true)
    assert.equal(allowFrameNavigation({ url: 'about:blank', isMainFrame: false, appUrl: dev }), true)
    for (const url of ['https://evil.example/', 'http://localhost:5173/', file, 'data:text/html,<p>x', 'javascript:alert(1)', 'blob:null/x']) {
      assert.equal(allowFrameNavigation({ url, isMainFrame: false, appUrl: dev }), false, url)
    }
  })

  it('главный фрейм — только страница приложения (origin dev-сервера или тот же index.html)', () => {
    assert.equal(allowFrameNavigation({ url: 'http://localhost:5173/?x=1', isMainFrame: true, appUrl: dev }), true)
    assert.equal(allowFrameNavigation({ url: 'https://example.com/', isMainFrame: true, appUrl: dev }), false)
    assert.equal(allowFrameNavigation({ url: `${file}#inbox`, isMainFrame: true, appUrl: file }), true)
    assert.equal(allowFrameNavigation({ url: 'file:///etc/passwd', isMainFrame: true, appUrl: file }), false)
    assert.equal(allowFrameNavigation({ url: `orca-preview://${token}/design/a.html`, isMainFrame: true, appUrl: file }), false)
    assert.equal(allowFrameNavigation({ url: 'not a url', isMainFrame: true, appUrl: file }), false)
  })
})

describe('isExternalWebUrl', () => {
  it('только http(s)', () => {
    assert.equal(isExternalWebUrl('https://github.com/x'), true)
    assert.equal(isExternalWebUrl('HTTP://a.b/'), true)
    for (const u of ['file:///etc/passwd', 'orca-preview://t/a.html', 'javascript:1', 'smb://host/share', 'vscode://x']) assert.equal(isExternalWebUrl(u), false, u)
  })
})


describe('host address и независимые registries', () => {
  it('host HTTPS address использует общий resolver и CSP отдельного origin', async () => {
    const base = (id: string) => `https://preview.test/p/${id}/`
    const preview = runtime.createPreviewServices({
      cspSource: 'https://preview.test', base,
      urlFor: (id, segments) => `${base(id)}${segments.map(encodeURIComponent).join('/')}`,
      parse: url => {
        const match = /^https:\/\/preview\.test\/p\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url)
        return match ? { token: match[1], path: match[2] ?? '/' } : undefined
      }
    })
    const url = preview.previewUrlFor(token, ['design', 'a.html'])
    const result = preview.handlePreviewRequest(new Request(url), tokens)
    assert.equal(result.status, 200)
    assert.equal(await result.text(), readFileSync(path.join(root, 'design/a.html'), 'utf8'))
    const csp = result.headers.get('content-security-policy')!
    assert.ok(csp.includes('https://preview.test')); assert.ok(!csp.includes('orca-preview:'))
    assert.ok(!csp.includes('https://app.test'))
    assert.deepEqual(preview.resolvePreviewRequest({ method: 'GET', url: base(token) + '%2e%2e/outside.css' }, tokens), { ok: false, status: 403, reason: 'path' })
    assert.deepEqual(preview.resolvePreviewRequest({ method: 'GET', url: url.replace('preview.test/', 'preview.test.attacker/') }, tokens), { ok: false, status: 400, reason: 'url' })
  })
  it('custom scheme экранируется, dot segments остаются видимы guards, public address без server root', async () => {
    const address = runtime.createSchemePreviewAddress('custom.orca-preview+1')
    const preview = runtime.createPreviewServices(address)
    const url = preview.previewUrlFor(token, ['design', 'мой макет.html'])
    assert.ok(!url.includes(root)); assert.ok(url.startsWith('custom.orca-preview+1://'))
    assert.deepEqual(address.parse(url), { token, path: '/design/%D0%BC%D0%BE%D0%B9%20%D0%BC%D0%B0%D0%BA%D0%B5%D1%82.html' })
    assert.equal(address.parse(url.replace('custom.orca-preview+1', 'customXorca-preview111')), undefined)
    assert.deepEqual(preview.resolvePreviewRequest({ method: 'GET', url: address.base(token) + 'design/%2e%2e/a.html' }, tokens), { ok: false, status: 403, reason: 'path' })
    assert.ok(preview.resolvePreviewRequest({ method: 'GET', url }, tokens).ok)
    assert.match(preview.buildPreviewCsp(false), /custom\.orca-preview\+1:/)
    assert.ok(!preview.buildPreviewCsp(false).includes('orca-preview:'))
    const services = fileServices()
    const view = runtime.createDocViewServices({ messages: { Error: runtimeFixtureError }, files: services.projectFiles, preview })
    const doc = await view.docsPreviewUrl(tokens, root, 'design/a.html')
    assert.ok(doc.url.startsWith('custom.orca-preview+1://')); assert.ok(!JSON.stringify(doc).includes(root))
  })
  it('same token двух registries адресует их собственные root, LRU вытесняет лишь свой grant', () => {
    const left = new PreviewTokens(1, (() => { let n = 0; return () => (++n).toString(16).padStart(32, '0') })())
    const right = new PreviewTokens(1, () => '1'.padStart(32, '0'))
    const id = left.issue(root, false)
    assert.equal(right.get(id), undefined)
    assert.equal(right.issue(tmp, true), id)
    assert.deepEqual(left.get(id), { root, network: false }); assert.deepEqual(right.get(id), { root: tmp, network: true })
    left.issue(tmp, false)
    assert.equal(left.get(id), undefined); assert.equal(right.get(id)?.root, tmp)
  })
  it('невалидные scheme/registry limits отклонены при construction', () => {
    for (const scheme of ['', 'a:b', 'bad scheme', 'x://', '1invalid', 'x\n']) assert.throws(() => runtime.createSchemePreviewAddress(scheme), TypeError)
    for (const limit of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => new PreviewTokens(limit), RangeError)
  })
})
