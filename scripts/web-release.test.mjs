import test from 'node:test'
import assert from 'node:assert/strict'
import { readYaml } from './macos-release.mjs'
import { assertProductReleaseAssets, productReleasePolicy } from './product-release.mjs'

test('Web release is independent, checks installed Linux package before draft and preserves Desktop Latest', () => {
  const workflow = readYaml('.github/workflows/web-release.yml')
  assert.deepEqual(workflow.on.push.tags, ['web/v*']); assert.deepEqual(workflow.permissions, { contents: 'read' })
  const validate = workflow.jobs.validate.steps.map(step => step.run ?? '').join('\n')
  assert.match(validate, /check-git-flow.mjs/); assert.match(validate, /is-ancestor HEAD origin\/master/)
  assert.match(validate, /apps\/web\/package.json/); assert.match(validate, /docs\/releases\/web\/v/)
  const packageJob = workflow.jobs.package; assert.equal(packageJob['runs-on'], 'ubuntu-24.04'); assert.equal(packageJob.needs, 'validate')
  const bundle = packageJob.steps.findIndex(step => step.run === 'pnpm --filter @orca-board/web run bundle:linux')
  const smoke = packageJob.steps.findIndex(step => step.run === 'node scripts/smoke-web-bundle.mjs apps/web/release')
  const upload = packageJob.steps.findIndex(step => step.with?.name === 'web-installers')
  assert.ok(bundle >= 0 && smoke > bundle && upload > smoke)
  const draft = workflow.jobs.draft; assert.deepEqual(draft.needs, ['validate', 'package']); assert.deepEqual(draft.permissions, { contents: 'write' })
  const run = draft.steps.find(step => step.run)?.run
  assert.match(run, /sha256sum --check --strict/); assert.match(run, /--verify-tag --draft --latest=false/); assert.match(run, /\.draft.*true/)
  assert.doesNotMatch(run, /orca-board-|latest-mac.yml/)
  assert.equal(productReleasePolicy('web', '2.3.4').tag, 'web/v2.3.4'); assert.equal(productReleasePolicy('web', '2.3.4').make_latest, 'false')
  assert.throws(() => assertProductReleaseAssets('web', ['latest.yml']))
  assert.throws(() => assertProductReleaseAssets('desktop', ['orca-web-linux-x64-2.3.4.tar.gz']))
  assert.throws(() => assertProductReleaseAssets('cli', ['install-orca-web.sh']))
})
