import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWebConfig } from '../src/server/config.ts'

const config = parseWebConfig({ schemaVersion: 1, configDir: '/home/orca/.config/orca-web', dataDir: '/home/orca/.orca-board/profiles/default', projectRoots: ['/home/orca/projects'], mode: 'proxy', origin: 'https://orca.example.com', previewOrigin: 'https://preview.example.com' })
async function provision() { return import('../src/server/provision.ts') }

test('Nginx разделяет панель/preview, сохраняет HTTPS Host и убирает preview cookies', async () => {
  const { nginxConfig } = await provision(); const result = nginxConfig(config, true)
  assert.match(result, /server_name orca\.example\.com/)
  assert.match(result, /server_name preview\.example\.com/)
  assert.match(result, /proxy_pass http:\/\/127\.0\.0\.1:3737/)
  assert.match(result, /proxy_pass http:\/\/127\.0\.0\.1:3738/)
  assert.match(result, /proxy_set_header X-Forwarded-Proto https/)
  assert.match(result, /proxy_set_header Cookie ""/)
  assert.match(result, /ssl_protocols TLSv1\.2 TLSv1\.3/)
  assert.doesNotMatch(nginxConfig(config, false), /proxy_pass/)
  assert.match(result, /listen \[::\]:80/)
  assert.match(result, /listen \[::\]:443 ssl/)
})

test('Nginx renewal hook проверяет конфигурацию и применяет обновлённый сертификат', async () => {
  const { nginxRenewalHook } = await provision()
  assert.match(nginxRenewalHook(), /RENEWED_LINEAGE/)
  assert.match(nginxRenewalHook(), /\/usr\/sbin\/nginx -t/)
  assert.match(nginxRenewalHook(), /\/usr\/bin\/systemctl reload nginx/)
})

test('Nginx не перехватывает точные, wildcard и regex имена существующего сайта', async () => {
  const { assertNginxHostsAvailable } = await provision()
  for (const names of ['orca.example.com', '*.example.com', '.example.com', 'orca.example.*', '~^orca\\.example\\.com$']) {
    assert.throws(() => assertNginxHostsAvailable(`server { server_name ${names}; }`, ['orca.example.com']), /занят|wildcard|regex/i, names)
  }
  assert.doesNotThrow(() => assertNginxHostsAvailable('server { server_name vortex.example.net _; }', ['orca.example.com']))
})

test('публичная готовность требует TLS/health обоих origin и идентификатор именно этого экземпляра', async () => {
  const { publicOriginsReady } = await provision()
  const expected = { version: '2.1.0', instance: 'this-installation' }
  const fetcher = async (url: string) => Response.json({ status: 'ready', ...expected, ...(url.startsWith(config.previewOrigin) ? { service: 'orca-web-preview' } : {}) })
  assert.equal(await publicOriginsReady(config, expected, fetcher), true)
  assert.equal(await publicOriginsReady(config, expected, async url => url.startsWith(config.previewOrigin) ? Response.json({ status: 'ready', ...expected, instance: 'other-server', service: 'orca-web-preview' }) : fetcher(url)), false)
  assert.equal(await publicOriginsReady(config, expected, async url => { if (url.startsWith(config.previewOrigin)) throw new Error('TLS failed'); return fetcher(url) }), false)
})

test('сбой полного provision восстанавливает proxy, origin и работающий legacy сервис', async () => {
  const { provisionTransaction } = await provision(); const root = await mkdtemp(join(tmpdir(), 'orca-provision-rollback-'))
  try {
    const file = join(root, 'proxy.conf'); const settings = join(root, 'config.json')
    await writeFile(file, 'old proxy'); await writeFile(settings, 'old origin')
    let legacyActive = true
    await assert.rejects(provisionTransaction([file], async () => {
      await writeFile(file, 'new proxy'); await writeFile(settings, 'new origin'); legacyActive = false
      throw new Error('new HTTPS failed')
    }, async () => { await writeFile(settings, 'old origin'); legacyActive = true }), /new HTTPS failed/)
    assert.equal(await readFile(file, 'utf8'), 'old proxy'); assert.equal(await readFile(settings, 'utf8'), 'old origin'); assert.equal(legacyActive, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('ошибка validation или reload возвращает файл и сохраняет соседний сайт', async () => {
  const { applyManagedFiles } = await provision(); const root = await mkdtemp(join(tmpdir(), 'orca-proxy-'))
  try {
    const file = join(root, 'orca.conf'); const other = join(root, 'site.conf')
    await writeFile(file, '# Orca Web: managed file\nold\n'); await writeFile(other, 'existing site\n')
    await assert.rejects(applyManagedFiles([{ file, content: '# Orca Web: managed file\nnew\n' }], () => { throw new Error('invalid') }, () => {}), /invalid/)
    assert.equal(await readFile(file, 'utf8'), '# Orca Web: managed file\nold\n')
    await assert.rejects(applyManagedFiles([{ file, content: '# Orca Web: managed file\nnew\n' }], () => {}, () => { throw new Error('reload failed') }), /reload failed/)
    assert.equal(await readFile(file, 'utf8'), '# Orca Web: managed file\nold\n')
    assert.equal(await readFile(other, 'utf8'), 'existing site\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('чужой файл и symlink не перезаписываются, новые файлы убираются при отказе', async () => {
  const { applyManagedFiles } = await provision(); const root = await mkdtemp(join(tmpdir(), 'orca-conflict-'))
  try {
    const file = join(root, 'site.conf'); const link = join(root, 'link.conf'); const fresh = join(root, 'new.conf')
    await writeFile(file, 'existing site')
    if (process.platform !== 'win32') await symlink(file, link)
    for (const path of process.platform === 'win32' ? [file] : [file, link]) await assert.rejects(applyManagedFiles([{ file: path, content: '# Orca Web: managed file\nnew' }], () => {}, () => {}), /чуж|симлинк/i)
    await assert.rejects(applyManagedFiles([{ file: fresh, content: '# Orca Web: managed file\nnew' }], () => { throw new Error('invalid') }, () => {}))
    await assert.rejects(readFile(fresh), { code: 'ENOENT' })
    assert.equal(await readFile(file, 'utf8'), 'existing site')
  } finally { await rm(root, { recursive: true, force: true }) }
})
