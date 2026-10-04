import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, chmod, rm, symlink, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWebSessions, SESSION_IDLE_MS, SESSION_TTL_MS } from '../src/server/sessions.ts'
import { createLoginLimits } from '../src/server/login-limits.ts'
import { createWebAccount, verifyWebPassword, initializeWebAccount, loadWebAccounts, addWebAccount } from '../src/server/accounts.ts'
import { parseWebConfig } from '../src/server/config.ts'
import { createProjectRootPolicy } from '../src/server/project-roots.ts'
import { createWebRouter, type WebRouter } from '../src/server/http.ts'
import type { OperatorHttpHandler } from '@orca-board/runtime'
import type { UpdateState } from '@orca-board/client/desktop-settings'

test('sessions: idle/absolute expiry, revocation и лимит не оставляют клиентов', () => {
  let now = 0; const revoked: string[] = []
  const sessions = createWebSessions({ now: () => now, onRevoke: value => revoked.push(value.token) })
  const first = sessions.create('one'); const second = sessions.create('two')
  for (let count = 0; count < 62; count++) sessions.create('other')
  assert.throws(() => sessions.create('three'))
  assert.equal(sessions.get(first.token)?.accountId, 'one')
  now = SESSION_IDLE_MS; assert.equal(sessions.get(first.token), null); assert.equal(sessions.size, 0); assert.equal(revoked.length, 64)
  const active = sessions.create('one')
  for (let time = now; time < active.createdAt + SESSION_TTL_MS; time += SESSION_IDLE_MS / 2) { now = time; sessions.get(active.token) }
  now = active.createdAt + SESSION_TTL_MS; assert.equal(sessions.get(active.token), null)
  sessions.revoke(second.token); sessions.stop(); assert.equal(sessions.size, 0)
})
test('login limiter сохраняет inflight попытки и освобождает успешные', () => {
  let now = 0; const limits = createLoginLimits({ now: () => now })
  const reserved = Array.from({ length: 5 }, () => limits.reserve('peer')!)
  assert.equal(limits.reserve('peer'), null); now = 60_001; assert.equal(limits.reserve('peer'), null)
  reserved[0].success(); assert.ok(limits.reserve('peer')); reserved[1].failure()
})
test('password/accounts: private файлы, Unicode без нормализации, второй аккаунт', async t => {
  const root = await mkdtemp(join(tmpdir(), 'orca-auth-')); t.after(() => rm(root, { recursive: true, force: true }))
  const config = join(root, 'config'); const password = 'é'.repeat(12)
  await initializeWebAccount({ configDir: config, login: 'first', password })
  const [account] = await loadWebAccounts(join(config, 'accounts.json'))
  assert.equal(await verifyWebPassword(account, password), true); assert.equal(await verifyWebPassword(account, 'e\u0301'.repeat(12)), false)
  await addWebAccount({ configDir: config, login: 'second', password: 'second-password-123' })
  assert.equal((await loadWebAccounts(join(config, 'accounts.json'))).length, 2)
  await assert.rejects(createWebAccount('short', '1234'))
  if (process.platform !== 'win32') { await chmod(join(config, 'accounts.json'), 0o644); await assert.rejects(loadWebAccounts(join(config, 'accounts.json'))); await chmod(join(config, 'accounts.json'), 0o600) }
  await symlink(join(config, 'accounts.json'), join(config, 'linked.json')); await assert.rejects(loadWebAccounts(join(config, 'linked.json')))
})
test('root policy проверяет raw RPC, canonical paths и symlink escape', async t => {
  const root = await mkdtemp(join(tmpdir(), 'orca-roots-')); t.after(() => rm(root, { recursive: true, force: true }))
  const allowed = join(root, 'allowed'); const outside = join(root, 'outside'); await mkdir(allowed); await mkdir(outside)
  await symlink(outside, join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const policy = await createProjectRootPolicy([allowed])
  await assert.rejects(policy.beforeCall(null, { method: 'profile.addProject', args: [outside] }))
  await assert.rejects(policy.beforeCall(null, { method: 'profile.detectTaskType', args: [join(allowed, 'escape')] }))
  assert.deepEqual((await policy.list()).roots, [await realpath(allowed)]); assert.deepEqual((await policy.list(allowed)).directories, [])
  assert.equal(parseWebConfig({ schemaVersion: 1, configDir: root, dataDir: root, projectRoots: [allowed] }).previewOrigin, 'http://127.0.0.1:3738')
  assert.throws(() => parseWebConfig({ schemaVersion: 1, configDir: root, dataDir: root, projectRoots: [allowed], previewOrigin: 'http://localhost:3738' }))
})
test('HTTP auth: host/origin/CSRF, isolated tabs, cookie и logout', async t => {
  const account = await createWebAccount('operator', 'test-password-123')
  const config = parseWebConfig({ schemaVersion: 1, configDir: '/tmp/orca', dataDir: '/tmp/profile', projectRoots: ['/tmp'] })
  let router: WebRouter; const detached: string[] = []
  const operator: OperatorHttpHandler = {
    handle(request, response) { const context = router.authenticateOperator(request)!; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(context)) },
    detach(context) { detached.push(context.clientId) }, stop: async () => {}
  }
  let installs = 0
  const updateState: UpdateState = { status: 'ready', currentVersion: '2.0.0', availableVersion: '2.1.0', releaseNotes: '', releaseUrl: null, percent: null, installPending: null, mode: 'server', unsupportedReason: null, error: null }
  const sessions = createWebSessions({ onRevoke: session => router.revokeClients(session) }); router = createWebRouter({ config, accounts: [account], sessions, operator,
    updates: { getState: async () => updateState, check: async () => updateState, download: async () => updateState, install: async version => { assert.equal(version, '2.1.0'); installs++; return updateState }, stop() {} } })
  const server = createServer(router.handle); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await router.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`
  const fetch = (url: string, options: { method: string; headers: Record<string, string>; body: string }): Promise<Response> => new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method, headers: options.headers }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', (bytes: Buffer) => chunks.push(bytes)); incoming.once('error', reject)
      incoming.once('end', () => { const result = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) for (const part of Array.isArray(value) ? value : [value]) result.append(name, part); resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers: result })) })
    }); req.once('error', reject); req.end(options.body)
  })
  const headers = { host: 'localhost:3737', origin: config.origin, 'content-type': 'application/json' }
  const post = (path: string, body: unknown, extra = {}) => fetch(url + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  assert.equal((await post('/call', {})).status, 401)
  assert.equal((await post('/auth/login', { login: account.login, password: 'test-password-123' }, { origin: 'https://other.invalid' })).status, 403)
  const logged = await post('/auth/login', { login: account.login, password: 'test-password-123' }); assert.equal(logged.status, 200)
  const cookie = logged.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.doesNotMatch(cookie, /Domain=/)
  const publicSession = await logged.json() as { csrfToken: string }; assert.doesNotMatch(JSON.stringify(publicSession), /password|scrypt|configDir|dataDir|token"/)
  const authenticated = { cookie: cookie.split(';')[0], 'x-orca-client': 'tab', 'x-orca-csrf': publicSession.csrfToken }
  assert.equal((await post('/updates/install', { version: '2.1.0' })).status, 401)
  assert.equal((await post('/updates/install', { version: '2.1.0' }, { ...authenticated, 'x-orca-csrf': 'wrong' })).status, 403)
  assert.equal((await post('/updates/install', { version: '2.1.0' }, { ...authenticated, origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await post('/updates/install', { version: '2.1.0', command: 'arbitrary' }, authenticated)).status, 400)
  assert.equal(installs, 0); assert.equal((await post('/updates/install', { version: '2.1.0' }, authenticated)).status, 202); assert.equal(installs, 1)
  assert.equal((await post('/hello', {}, { ...authenticated, 'x-orca-csrf': 'wrong' })).status, 403)
  assert.equal((await post('/hello', {}, { ...authenticated, host: 'evil.invalid' })).status, 403)
  const one = await (await post('/hello', {}, authenticated)).json() as { clientId: string; actor: { id: string } }
  const two = await (await post('/hello', {}, { ...authenticated, 'x-orca-client': 'tab-2' })).json() as { clientId: string }
  assert.notEqual(one.clientId, two.clientId); assert.equal(one.actor.id, `web:${account.id}`)
  assert.equal((await post('/auth/logout', {}, authenticated)).status, 204); assert.equal(detached.length, 2)
  assert.equal((await post('/hello', {}, authenticated)).status, 401)
  assert.equal((await post('/auth/login', { login: 'unknown', password: 'test-password-123' })).status, 401)
  assert.equal((await post('/auth/login', { login: account.login, password: 'wrong-password-123' })).status, 401)
  const oversized = await fetch(url + '/auth/login', { method: 'POST', headers, body: JSON.stringify({ login: 'operator', password: 'x'.repeat(17 * 1024) }) }); assert.equal(oversized.status, 413)
})
