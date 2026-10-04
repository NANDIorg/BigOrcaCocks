import test from 'node:test'
import assert from 'node:assert/strict'
import { productReleasePolicy, assertProductReleaseAssets, releaseTag } from './product-release.mjs'

test('CLI/Web release policy сохраняет Desktop Latest/feed, версия и codename принадлежат продукту', () => {
  for (const product of ['cli', 'web']) {
    const policy = productReleasePolicy(product, '7.8.9')
    assert.equal(policy.make_latest, 'false'); assert.equal(policy.desktopFeed, false); assert.equal(policy.tag, `${product}/v7.8.9`)
    assert.throws(() => assertProductReleaseAssets(product, ['latest-mac.yml']), /Desktop/)
    assert.throws(() => assertProductReleaseAssets(product, ['path/orca-board-1.1.3.zip']), /Desktop/)
    assert.doesNotThrow(() => assertProductReleaseAssets(product, [`orca-${product}-7.8.9.tgz`, 'SHA256SUMS']))
  }
  assert.equal(productReleasePolicy('desktop', '1.1.3').make_latest, 'true'); assert.deepEqual(releaseTag('v1.1.3'), { product: 'desktop', version: '1.1.3' })
})
