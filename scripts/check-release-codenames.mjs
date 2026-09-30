import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { releaseTitle, validateReleaseCodenames } from '../packages/core/src/release-codenames.ts'

const registryPath = 'packages/core/src/release-codenames.json'
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sha = /^[0-9a-f]{40}$/u
const stableTag = /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

// Отсутствие файла в старом выпуске допустимо. Недоступный commit не скрываем этим исключением.
function registryAt(ref) {
  const path = git(['ls-tree', '--name-only', ref, '--', registryPath])
  return path ? JSON.parse(git(['show', `${ref}:${registryPath}`])) : []
}

function compareTags(a, b) {
  const left = stableTag.exec(a).slice(1).map(BigInt)
  const right = stableTag.exec(b).slice(1).map(BigInt)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1
  return 0
}

try {
  if (process.argv.slice(2).some((arg) => arg !== '--github-output')) throw new Error('неизвестный аргумент проверки кодовых имён')
  const version = read('package.json').version
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) || read('apps/desktop/package.json').version !== version) throw new Error('версии приложения должны совпадать в формате X.Y.Z')
  const entries = validateReleaseCodenames(read(registryPath))
  const previous = new Set(['HEAD'])
  const event = process.env.GITHUB_EVENT_PATH ? read(process.env.GITHUB_EVENT_PATH) : {}
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && !event.pull_request?.base?.sha) throw new Error('нет SHA базы PR для проверки истории имён')
  const base = event.pull_request?.base?.sha ?? event.before
  if (base && base !== '0'.repeat(40)) {
    if (!sha.test(base)) throw new Error('некорректный SHA базы для проверки истории имён')
    previous.add(base)
  }
  const tags = git(['for-each-ref', '--format=%(refname)', 'refs/tags']).split('\n').filter((tag) => stableTag.test(tag)).sort(compareTags)
  const head = git(['rev-parse', 'HEAD'])
  for (const tag of tags) {
    if (git(['rev-parse', `${tag}^{commit}`]) === head) continue
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', tag, 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
    if (ancestor.error) throw ancestor.error
    if (ancestor.status === 1) continue
    if (ancestor.status !== 0) throw new Error(`не удалось проверить релизный тег ${tag}`)
    previous.add(tag)
    break
  }
  for (const ref of previous) validateReleaseCodenames(entries, registryAt(ref))
  const title = releaseTitle(version, entries)
  if (process.argv.includes('--github-output')) {
    if (!process.env.GITHUB_OUTPUT) throw new Error('не задан GITHUB_OUTPUT')
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntitle=${title}\n`)
  }
  process.stdout.write(`Кодовые имена: ${title}; реестр и история согласованы.\n`)
} catch (error) {
  process.stderr.write(`Кодовые имена: ${error.message}\n`)
  process.exitCode = 1
}
