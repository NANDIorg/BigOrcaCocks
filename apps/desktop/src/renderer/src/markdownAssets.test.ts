import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasMarkdownImages, resolveMarkdownLink, resolveShowcaseRef, showcaseImageSrc, showcaseTextAssets, SHOWCASE_TEXT_PATH } from './markdownAssets'

const BASE = 'orca-preview://0123456789abcdef0123456789abcdef/'

test('относительный адрес — от папки markdown-файла, `..` — в пределах корня показа', () => {
  assert.equal(resolveShowcaseRef('docs/README.md', 'shots/a.png'), 'docs/shots/a.png')
  assert.equal(resolveShowcaseRef('docs/README.md', './shots/a.png'), 'docs/shots/a.png')
  assert.equal(resolveShowcaseRef('docs/README.md', '../design/b.png'), 'design/b.png')
  assert.equal(resolveShowcaseRef('README.md', 'a.png?v=2#x'), 'a.png', 'запрос и якорь отбрасываются')
  assert.equal(resolveShowcaseRef('README.md', 'скрин%20один.png'), 'скрин один.png', '%-кодирование декодируется')
  assert.equal(resolveShowcaseRef('README.md', 'variant-b.html'), 'variant-b.html')
})

test('за корень показа, абсолютные, со схемой, скрытые и кривые адреса — отказ', () => {
  assert.equal(resolveShowcaseRef('README.md', '../secret.png'), undefined, '`..` из корня')
  assert.equal(resolveShowcaseRef('docs/README.md', '../../x.png'), undefined)
  assert.equal(resolveShowcaseRef('docs/README.md', 'a/../../../x.png'), undefined)
  assert.equal(resolveShowcaseRef('README.md', '/etc/passwd.png'), undefined, 'абсолютный путь')
  assert.equal(resolveShowcaseRef('README.md', '//evil.example/a.png'), undefined, 'адрес без схемы')
  assert.equal(resolveShowcaseRef('README.md', 'https://example.com/a.png'), undefined)
  assert.equal(resolveShowcaseRef('README.md', 'data:image/png;base64,AAAA'), undefined)
  assert.equal(resolveShowcaseRef('README.md', 'file:///etc/a.png'), undefined)
  assert.equal(resolveShowcaseRef('README.md', 'C:/a.png'), undefined, 'диск Windows')
  assert.equal(resolveShowcaseRef('README.md', '.git/config.png'), undefined, 'скрытое')
  assert.equal(resolveShowcaseRef('README.md', 'a%2F..%2F..%2Fb.png'), undefined, 'разделитель внутри сегмента')
  assert.equal(resolveShowcaseRef('README.md', '%2e%2e/a.png'), undefined, 'закодированный `..` — тоже выход из корня')
  assert.equal(resolveShowcaseRef('README.md', 'a\\b.png'), undefined)
  assert.equal(resolveShowcaseRef('README.md', '%E0%A4%A.png'), undefined, 'битое %-кодирование')
  assert.equal(resolveShowcaseRef('README.md', ''), undefined)
  assert.equal(resolveShowcaseRef('README.md', '#якорь'), undefined)
  assert.equal(resolveShowcaseRef('docs/README.md', '..'), undefined, 'корень — не файл')
})

test('картинка markdown показа: относительная — из снимка, внешняя и data: — убрать, без base — убрать', () => {
  const assets = { path: 'docs/README.md', base: BASE }
  assert.equal(showcaseImageSrc('shots/скрин 1.png', assets), `${BASE}docs/shots/${encodeURIComponent('скрин 1.png')}`)
  assert.equal(showcaseImageSrc('https://example.com/a.png', assets), undefined)
  assert.equal(showcaseImageSrc('http://example.com/a.png', assets), undefined)
  assert.equal(showcaseImageSrc('data:image/png;base64,AAAA', assets), undefined)
  assert.equal(showcaseImageSrc('orca-preview://чужой-токен/a.png', assets), undefined)
  assert.equal(showcaseImageSrc('../../a.png', assets), undefined)
  assert.equal(showcaseImageSrc('shots/a.png', { path: 'docs/README.md' }), undefined, 'старый main без base')
})

test('описание показа: картинки — от корня репозитория из снимка, внешние и `..` за корень — подписью', () => {
  const a = showcaseTextAssets(BASE)
  assert.deepEqual(a, { path: SHOWCASE_TEXT_PATH, base: BASE })
  assert.equal(showcaseImageSrc('design/a.png', a), `${BASE}design/a.png`)
  assert.equal(showcaseImageSrc('./design/скрин 1.png', a), `${BASE}design/${encodeURIComponent('скрин 1.png')}`)
  assert.equal(showcaseImageSrc('../design/a.png', a), undefined, '`..` за корень показа')
  assert.equal(showcaseImageSrc('https://example.com/a.png', a), undefined)
  assert.equal(showcaseImageSrc('data:image/png;base64,AAAA', a), undefined)
})

test('описание показа без базы (нет снимка и worktree, старый API, кривой ответ) — картинки подписью', () => {
  for (const base of [null, undefined, '', 'https://evil.example/', 'orca-preview://t', 42]) {
    const a = showcaseTextAssets(base)
    assert.deepEqual(a, { path: SHOWCASE_TEXT_PATH }, String(base))
    assert.equal(showcaseImageSrc('design/a.png', a), undefined)
  }
})

test('картинки в тексте описания: только тогда нужна база снимка', () => {
  assert.equal(hasMarkdownImages('Вариант A\n\n![A](design/a.png)'), true)
  assert.equal(hasMarkdownImages('![A][shot]\n\n[shot]: design/a.png'), true)
  assert.equal(hasMarkdownImages('<IMG src="a.png">'), true)
  assert.equal(hasMarkdownImages('Вариант A — [ссылка](design/a.html), восклицание! [нет]'), false)
})

test('ссылка markdown показа: путь от корня показа и `#якорь`, скрытое закрыто', () => {
  const assets = { path: 'docs/README.md', base: BASE }
  assert.deepEqual(resolveMarkdownLink(assets, 'plan.md#Этапы'), { path: 'docs/plan.md', hash: 'Этапы' })
  assert.deepEqual(resolveMarkdownLink(assets, 'plan.md#%D0%AD%D1%82%D0%B0%D0%BF%D1%8B'), { path: 'docs/plan.md', hash: 'Этапы' }, 'якорь декодируется')
  assert.deepEqual(resolveMarkdownLink(assets, '../variant-b.html'), { path: 'variant-b.html' }, 'без якоря — без поля hash')
  assert.deepEqual(resolveMarkdownLink(assets, 'plan.md#'), { path: 'docs/plan.md' }, 'пустой якорь')
  assert.deepEqual(resolveMarkdownLink(assets, 'plan.md#%E0%A4%A'), { path: 'docs/plan.md' }, 'битый якорь отбрасывается, ссылка остаётся')
  assert.equal(resolveMarkdownLink(assets, '#раздел'), undefined, 'только якорь — переход внутри документа')
  assert.equal(resolveMarkdownLink(assets, ' #раздел'), undefined)
  assert.equal(resolveMarkdownLink(assets, '.env'), undefined, 'в показе скрытое недоступно')
  assert.equal(resolveMarkdownLink(assets, 'https://example.com/a.md#x'), undefined)
  assert.equal(resolveMarkdownLink(assets, '../../a.md#x'), undefined, 'за корень')
})

test('ссылка markdown в «Документах» (`links: project`): любые файлы и точечные, кроме `.git`', () => {
  const assets = { path: 'docs/architecture.md', links: 'project' as const }
  assert.deepEqual(resolveMarkdownLink(assets, '../apps/desktop/src/shared/ipc.ts'), { path: 'apps/desktop/src/shared/ipc.ts' })
  assert.deepEqual(resolveMarkdownLink(assets, '../.github/workflows/ci.yml#L10'), { path: '.github/workflows/ci.yml', hash: 'L10' })
  assert.deepEqual(resolveMarkdownLink(assets, '../.env.example'), { path: '.env.example' })
  assert.deepEqual(resolveMarkdownLink(assets, 'git-flow.md#Работа%20через%20Orca'), { path: 'docs/git-flow.md', hash: 'Работа через Orca' })
  assert.equal(resolveMarkdownLink(assets, '../.git/config'), undefined, '.git закрыт')
  assert.equal(resolveMarkdownLink(assets, '../.GIT/config'), undefined, '.git в другом регистре')
  assert.equal(resolveMarkdownLink(assets, '../a/.git/HEAD'), undefined, 'вложенный .git')
  assert.equal(resolveMarkdownLink(assets, '../../outside.md'), undefined, 'за корень источника')
  assert.equal(resolveMarkdownLink(assets, '/etc/passwd'), undefined)
  assert.equal(resolveMarkdownLink(assets, 'mailto:a@b.c'), undefined)
  assert.equal(resolveMarkdownLink(assets, '%2e%2e/%2e%2e/x.md'), undefined)
  assert.equal(resolveMarkdownLink(assets, 'a%2Fb.md'), undefined, 'разделитель внутри сегмента')
})

test('картинки в «Документах» — как в показе: из корня источника, без скрытого', () => {
  const assets = { path: 'docs/architecture.md', base: BASE, links: 'project' as const }
  assert.equal(showcaseImageSrc('design/a.png', assets), `${BASE}docs/design/a.png`)
  assert.equal(showcaseImageSrc('../.github/a.png', assets), undefined, 'протокол скрытое не отдаёт')
  assert.equal(showcaseImageSrc('https://example.com/a.png', assets), undefined)
  assert.equal(showcaseImageSrc('design/a.png', { path: 'docs/architecture.md', links: 'project' }), undefined, 'без base (старый main)')
})
