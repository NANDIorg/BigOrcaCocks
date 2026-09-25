import { readFileSync } from 'node:fs'

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const named = /^(feature|fix|sync)\/[a-z0-9]+(?:[a-z0-9._/-]*[a-z0-9])?$/
const releaseVersion = (branch) => /^(release|hotfix)\/(.+)$/.exec(branch)?.[2]
const releaseBranch = (branch) => semver.test(releaseVersion(branch) ?? '')
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

try {
  const version = read('package.json').version
  const desktop = read('apps/desktop/package.json').version
  if (typeof version !== 'string' || !semver.test(version) || desktop !== version) {
    throw new Error('версии package.json и apps/desktop/package.json должны совпадать в формате X.Y.Z')
  }

  const event = process.env.GITHUB_EVENT_PATH ? read(process.env.GITHUB_EVENT_PATH) : {}
  const pr = event.pull_request
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && !pr) {
    throw new Error('в событии pull_request нет данных PR')
  }
  if (pr) {
    const head = pr.head.ref
    const base = pr.base.ref
    const kind = named.exec(head)?.[1]
    const sameRepo = Boolean(pr.head.repo?.full_name) && pr.head.repo.full_name === pr.base.repo?.full_name
    const allowed = base === 'develop'
      ? kind === 'feature' || (kind === 'sync' && sameRepo)
      : base === 'master'
        ? releaseBranch(head) && sameRepo
        : releaseBranch(base) && sameRepo && (kind === 'fix' || (kind === 'sync' && base.startsWith('release/')))
    if (!allowed) throw new Error(`запрещённое направление PR: ${head} → ${base}; см. docs/git-flow.md`)
    if (base === 'master' && releaseVersion(head) !== version) {
      throw new Error(`версия ${version} не совпадает с веткой ${head}`)
    }
    if (releaseBranch(base) && releaseVersion(base) !== version) {
      throw new Error(`версия ${version} не совпадает с целевой веткой ${base}`)
    }
  }

  const ref = process.env.GITHUB_REF ?? ''
  if (ref.startsWith('refs/tags/') && ref !== `refs/tags/v${version}`) {
    throw new Error(`тег ${ref.slice(10)} не совпадает с версией v${version}`)
  }
  process.stdout.write(`Git Flow: версии согласованы (${version})${pr ? ', направление PR допустимо' : ''}.\n`)
} catch (error) {
  process.stderr.write(`Git Flow: ${error.message}\n`)
  process.exitCode = 1
}
