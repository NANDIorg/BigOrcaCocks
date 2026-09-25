// Запуск: pnpm --filter @orca-board/desktop test. Разбор релизов GitHub для portable-режима Windows.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchLatestRelease,
  pickPortableAsset,
  portableUpdateInfo,
  releaseNotesText,
  releasePageUrl,
  versionFromTag,
  type FetchLike,
  type GithubRelease
} from './githubRelease'

const release = (over: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: 'v1.3.0',
  html_url: 'https://github.com/NANDIorg/BigOrcaCocks/releases/tag/v1.3.0',
  body: '## Что нового',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'orca-board-1.3.0-x64.exe', browser_download_url: 'https://x/setup.exe' },
    { name: 'orca-board-1.3.0-portable-x64.exe', browser_download_url: 'https://x/portable.exe' }
  ],
  ...over
})

describe('portableUpdateInfo', () => {
  it('новее и есть portable-exe → версия без v, заметки, страница релиза', () => {
    assert.deepEqual(portableUpdateInfo(release(), '1.2.3'), {
      version: '1.3.0',
      releaseNotes: '## Что нового',
      releaseUrl: 'https://github.com/NANDIorg/BigOrcaCocks/releases/tag/v1.3.0'
    })
  })
  it('не новее, черновик, предрелиз, без portable-exe, релиза нет — null', () => {
    assert.equal(portableUpdateInfo(release(), '1.3.0'), null)
    assert.equal(portableUpdateInfo(release({ draft: true }), '1.2.3'), null)
    assert.equal(portableUpdateInfo(release({ prerelease: true }), '1.2.3'), null)
    assert.equal(portableUpdateInfo(release({ assets: [{ name: 'orca-board-1.3.0-x64.exe', browser_download_url: 'u' }] }), '1.2.3'), null)
    assert.equal(portableUpdateInfo(null, '1.2.3'), null)
  })
  it('нет html_url — страница строится по версии; нет body — пустые заметки', () => {
    const info = portableUpdateInfo(release({ html_url: '', body: null }), '1.2.3')
    assert.equal(info?.releaseUrl, releasePageUrl('1.3.0'))
    assert.equal(info?.releaseNotes, '')
  })
})

describe('pickPortableAsset / versionFromTag / releaseNotesText', () => {
  it('portable-exe выбирается по имени, установщик — нет', () => {
    assert.equal(pickPortableAsset(release())?.browser_download_url, 'https://x/portable.exe')
  })
  it('versionFromTag', () => {
    assert.equal(versionFromTag('v0.4.2'), '0.4.2')
    assert.equal(versionFromTag('0.4.2'), '0.4.2')
  })
  it('заметки: строка как есть, массив — по версиям, пусто — пустая строка', () => {
    assert.equal(releaseNotesText('текст'), 'текст')
    assert.equal(releaseNotesText([{ version: '1.3.0', note: 'a' }, { version: '1.2.9', note: null }]), '## 1.3.0\n\na\n\n## 1.2.9\n\n')
    assert.equal(releaseNotesText(null), '')
  })
})

describe('fetchLatestRelease', () => {
  const ok = (data: unknown, status = 200): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, json: async () => data })

  it('разбирает ответ и запрашивает releases/latest репозитория с User-Agent', async () => {
    let url = ''
    let ua: string | undefined
    const f: FetchLike = async (u, init) => {
      url = u
      ua = init?.headers?.['User-Agent']
      return { ok: true, status: 200, json: async () => release() }
    }
    const r = await fetchLatestRelease(f)
    assert.equal(url, 'https://api.github.com/repos/NANDIorg/BigOrcaCocks/releases/latest')
    assert.equal(ua, 'orca-board')
    assert.equal(r?.tag_name, 'v1.3.0')
    assert.equal(r?.assets.length, 2)
  })
  it('404 — релизов нет (null), другие статусы и мусор — ошибка по-русски', async () => {
    assert.equal(await fetchLatestRelease(ok({}, 404)), null)
    await assert.rejects(fetchLatestRelease(ok({}, 403)), /GitHub вернул статус 403/)
    await assert.rejects(fetchLatestRelease(ok({ foo: 1 })), /неожиданный ответ/)
  })
})
