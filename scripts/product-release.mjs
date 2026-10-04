import { readFileSync } from 'node:fs'

export const products = {
  desktop: { manifest: 'apps/desktop/package.json', prefix: '', name: 'Orca', makeLatest: 'true' },
  cli: { manifest: 'packages/cli/package.json', prefix: 'cli/', name: 'Orca CLI', makeLatest: 'false' },
  web: { manifest: 'apps/web/package.json', prefix: 'web/', name: 'Orca Web', makeLatest: 'false' }
}
const semver = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)'
export function releaseBranch(branch) {
  const match = new RegExp(`^(release|hotfix)/(?:(cli|web)/)?(${semver})$`).exec(branch)
  return match ? { kind: match[1], product: match[2] ?? 'desktop', version: match[3] } : undefined
}
export function releaseTag(tag) {
  const match = new RegExp(`^(?:(cli|web)/)?v(${semver})$`).exec(tag)
  return match ? { product: match[1] ?? 'desktop', version: match[2] } : undefined
}
export function productVersion(product, root = '.') {
  const path = products[product]?.manifest
  if (!path) throw new Error(`неизвестный продукт: ${product}`)
  const { version } = JSON.parse(readFileSync(`${root}/${path}`, 'utf8'))
  if (typeof version !== 'string' || !new RegExp(`^${semver}$`).test(version)) throw new Error(`версия ${path} должна быть X.Y.Z`)
  return version
}
/** CLI/Web не могут стать Desktop update feed или GitHub Latest. */
export function productReleasePolicy(product, version) {
  const definition = products[product]
  if (!definition || !new RegExp(`^${semver}$`).test(version)) throw new Error('некорректный product release')
  return { tag: `${definition.prefix}v${version}`, manifest: definition.manifest, make_latest: definition.makeLatest, desktopFeed: product === 'desktop', title: `${definition.name} ${version}` }
}
export function assertProductReleaseAssets(product, files) {
  if (!products[product]) throw new Error('неизвестный продукт')
  if (product === 'desktop' && files.some(file => /(?:^|[/\\])(?:orca-web-[^/\\]*|install-orca-web\.sh)$/.test(file))) throw new Error('Desktop release не может содержать Web assets')
  if (product === 'cli' && files.some(file => /(?:^|[/\\])(?:orca-web-[^/\\]*|install-orca-web\.sh)$/.test(file))) throw new Error('CLI release не может содержать Web assets')
  if (product !== 'desktop' && files.some(file => /(?:^|[/\\])(?:latest[^/\\]*\.yml|orca-board-[^/\\]*)$/.test(file))) throw new Error('CLI/Web release не может содержать Desktop update assets')
}
