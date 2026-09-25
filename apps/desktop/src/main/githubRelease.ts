// Чтение релизов GitHub без electron: чистый разбор ответа API и выбор файла. Сетевой вызов принимает `fetch`
// параметром, поэтому тестируется в node:test. Используется portable-режимом Windows (winUpdater.ts): electron-updater
// portable-сборку не обновляет и в latest.yml её нет — «есть ли новее» смотрим прямо по релизам.
import type { UpdateInfo } from '../shared/ipc'
import { isNewer } from './updateMachine'

/** Репозиторий релизов (публичный): `publish` в electron-builder.yml. */
export const RELEASES_OWNER = 'NANDIorg'
export const RELEASES_REPO = 'BigOrcaCocks'

/** Ответ `GET /repos/{owner}/{repo}/releases/latest` — только нужные поля. */
export interface GithubRelease {
  tag_name: string
  html_url: string
  body: string | null
  draft: boolean
  prerelease: boolean
  assets: Array<{ name: string; browser_download_url: string }>
}

/** Версия из тега релиза: `v0.4.2` → `0.4.2`. */
export function versionFromTag(tag: string): string {
  return tag.trim().replace(/^v/i, '')
}

/** Страница релиза по версии (тег `v<версия>` — так их создаёт electron-builder). */
export function releasePageUrl(version: string): string {
  return `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/tag/v${version}`
}

/** Portable-exe в релизе: `orca-board-<v>-portable-x64.exe` (`portable.artifactName` в electron-builder.yml). */
export function pickPortableAsset(release: GithubRelease): GithubRelease['assets'][number] | null {
  return release.assets.find((a) => /-portable-.*\.exe$/i.test(a.name)) ?? null
}

/**
 * Что показать в `UpdateInfo` для portable: версия релиза новее `current` и в нём есть portable-exe.
 * Черновики, предрелизы и релизы без exe не считаются (человеку нечего скачать). `releaseUrl` — страница релиза,
 * а не прямая ссылка на файл: там же заметки и остальные сборки.
 */
export function portableUpdateInfo(release: GithubRelease | null, current: string): UpdateInfo | null {
  if (!release || release.draft || release.prerelease) return null
  const version = versionFromTag(release.tag_name)
  if (!isNewer(version, current)) return null
  if (!pickPortableAsset(release)) return null
  return { version, releaseNotes: release.body ?? '', releaseUrl: release.html_url || releasePageUrl(version) }
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/**
 * Последний опубликованный релиз; null — релизов ещё нет (404: черновики API без токена не отдаёт, это «новее нет», а не сбой).
 * Бросает по-русски при сети/статусе/неожиданном ответе.
 */
export async function fetchLatestRelease(fetchFn: FetchLike, timeoutMs = 15_000): Promise<GithubRelease | null> {
  const url = `https://api.github.com/repos/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest`
  const res = await fetchFn(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'orca-board' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub вернул статус ${res.status}`)
  const data = (await res.json()) as Partial<GithubRelease> | null
  if (!data || typeof data.tag_name !== 'string' || !Array.isArray(data.assets)) {
    throw new Error('GitHub вернул неожиданный ответ (нет tag_name или assets)')
  }
  return {
    tag_name: data.tag_name,
    html_url: typeof data.html_url === 'string' ? data.html_url : '',
    body: typeof data.body === 'string' ? data.body : null,
    draft: data.draft === true,
    prerelease: data.prerelease === true,
    assets: data.assets.filter((a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
  }
}

/**
 * Заметки релиза для UI: electron-updater отдаёт строку (тело релиза) или массив по версиям. Для GitHub-провайдера
 * это HTML из atom-ленты релизов; `Markdown.tsx` пропускает его через DOMPurify, так что отдельно конвертировать не нужно.
 */
export function releaseNotesText(notes: string | Array<{ version: string; note?: string | null }> | null | undefined): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  return notes.map((n) => `## ${n.version}\n\n${n.note ?? ''}`).join('\n\n')
}
