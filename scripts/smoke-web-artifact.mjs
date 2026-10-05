import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, request as httpRequest } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'

const artifact = resolve(process.argv[2]); assert.equal(process.versions.node.split('.')[0], '24'); assert.equal(process.versions.electron, undefined)
delete process.env.DISPLAY
const module = await import(pathToFileURL(join(artifact, 'index.mjs')).href)
const manifest = JSON.parse(await readFile(join(artifact, 'package.json'), 'utf8'))
const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-web-smoke-')))
const repo = join(root, 'projects', 'repo'); const outside = join(root, 'outside'); const configDir = join(root, 'config'); const dataDir = join(root, 'profile')
for (const directory of [repo, outside]) await mkdir(directory, { recursive: true })
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
git(['init', '--quiet']); git(['-c', 'user.name=Orca smoke', '-c', 'user.email=smoke@orca.invalid', 'commit', '--allow-empty', '-qm', 'init'])
await writeFile(join(repo, 'index.html'), '<!doctype html><p>ORCA_PREVIEW</p>')
await writeFile(join(repo, 'note.txt'), 'ORCA_DOWNLOAD')
await writeFile(join(repo, '.env'), 'PRIVATE_ENV')
const freePort = async () => { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port }
const port = await freePort(); const previewPort = await freePort()
const config = module.parseWebConfig({ schemaVersion: 1, configDir, dataDir, projectRoots: [join(root, 'projects')], port, origin: `http://localhost:${port}`, previewPort, previewOrigin: `http://127.0.0.1:${previewPort}` })
await module.initializeWebAccount({ configDir, login: 'operator', password: 'smoke-password-123' })
await module.addWebAccount({ configDir, login: 'partner', password: 'partner-password-123' })
await writeFile(join(configDir, 'config.json'), JSON.stringify(config), { mode: 0o600 })
function request(path, { method = 'GET', data, headers = {}, targetPort = port, host = `localhost:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: targetPort, path, method, headers: { host, origin: config.origin, ...headers } }, incoming => {
      const chunks = []; incoming.on('data', bytes => chunks.push(bytes)); incoming.once('error', reject)
      incoming.once('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: incoming.statusCode, headers: incoming.headers, bytes, json: () => JSON.parse(bytes.toString('utf8')) }) })
    }); req.setTimeout(30_000, () => req.destroy(new Error('Smoke timeout'))); req.once('error', reject); req.end(data)
  })
}
const post = (path, value, headers = {}) => request(path, { method: 'POST', data: JSON.stringify(value), headers: { 'content-type': 'application/json', ...headers } })
let host; let cli
try {
  host = await module.startWeb({ config, resourceDir: artifact })
  const health = (await request('/health')).json(); assert.equal(health.version, manifest.version)
  if (health.instance) {
    const previewHealth = (await request('/health', { targetPort: previewPort, host: new URL(config.previewOrigin).host })).json()
    assert.equal(previewHealth.instance, health.instance); assert.equal(previewHealth.version, manifest.version); assert.equal(previewHealth.service, 'orca-web-preview')
  }
  assert.equal((await request('/')).status, 200)
  assert.equal((await request('/auth/session')).status, 401)
  assert.equal((await request('/package.json')).status, 404)
  const login = await post('/auth/login', { login: 'operator', password: 'smoke-password-123' }); assert.equal(login.status, 200)
  const partner = await post('/auth/login', { login: 'partner', password: 'partner-password-123' }); assert.equal(partner.status, 200)
  const credentials = (response, client) => ({ cookie: response.headers['set-cookie'][0].split(';')[0], 'x-orca-csrf': response.json().csrfToken, 'x-orca-client': client })
  const one = credentials(login, 'same-label'); const two = credentials(partner, 'same-label')
  assert.notEqual(one.cookie, two.cookie)
  const hello = { protocolMajor: 1, schemaVersion: 1, product: { name: 'smoke', version: '1.0.0' } }
  for (const credentials of [one, two]) assert.equal((await post('/hello', hello, credentials)).status, 200)
  let serial = 0
  const call = async (method, args, extra = {}, credentials = one) => {
    const response = await post('/call', { id: `smoke-${++serial}`, issuedAt: Date.now(), method, args, revision: host.host.runtime.value.revision, ...extra }, credentials)
    assert.equal(response.status, 200); const reply = response.json(); assert.equal(reply.ok, true, JSON.stringify(reply.error)); return reply.result
  }
  const denied = await post('/call', { id: 'outside', issuedAt: Date.now(), method: 'profile.addProject', args: [outside], revision: host.host.runtime.value.revision }, one)
  assert.notEqual(denied.status, 200)
  const project = await call('profile.addProject', [repo])
  await post('/select', { projectId: project.id }, one); await post('/select', { projectId: project.id }, two)
  const initial = (await post('/snapshot', {}, one)).json(); await post('/snapshot', {}, two)
  assert.equal(initial.snapshot.projects.projects[0].root, repo)
  const mutation = { id: 'duplicate-group', issuedAt: Date.now(), method: 'profile.createGroup', args: ['Smoke group'], revision: host.host.runtime.value.revision }
  const original = (await post('/call', mutation, one)).json(); assert.equal(original.ok, true)
  assert.deepEqual((await post('/call', mutation, one)).json(), original)
  const uploaded = await request('/upload', { method: 'POST', headers: { ...one, 'x-orca-file-name': 'note.txt', 'content-type': 'text/plain' }, data: 'ATTACHMENT_BYTES' }); assert.equal(uploaded.status, 200)
  const task = await call('globalTask.create', [{ title: 'Smoke', description: 'Installed Web smoke' }, [{ uploadId: uploaded.json().uploadId }]], { projectId: project.id })
  const attachment = await request(`/binary?${new URLSearchParams({ projectId: project.id, kind: 'attachment', id: task.id, imageId: task.images[0].id })}`, { headers: one })
  assert.equal(attachment.bytes.toString(), 'ATTACHMENT_BYTES'); assert.equal(attachment.headers['content-disposition'], 'attachment')
  const downloaded = await request(`/binary?${new URLSearchParams({ projectId: project.id, kind: 'download', source: 'project', path: 'note.txt' })}`, { headers: one }); assert.equal(downloaded.bytes.toString(), 'ORCA_DOWNLOAD')
  const preview = await call('files.docPreview', ['project', 'index.html'], { projectId: project.id })
  const previewUrl = new URL(preview.url)
  const page = await request(previewUrl.pathname, { targetPort: previewPort, host: previewUrl.host }); assert.equal(page.status, 200); assert.match(page.bytes.toString(), /ORCA_PREVIEW/)
  assert.match(page.headers['content-security-policy'], /sandbox allow-scripts/); assert.equal(page.headers['set-cookie'], undefined)
  assert.equal((await request(previewUrl.pathname, { headers: one })).status, 404)
  const token = previewUrl.pathname.split('/')[1]
  assert.equal((await request(`/${token}/%2e%2e/index.html`, { targetPort: previewPort, host: previewUrl.host })).status, 403)
  assert.equal((await request(`/${token}/.env`, { targetPort: previewPort, host: previewUrl.host })).status, 403)
  const pty = await call('session.spawn', [{ cols: 80, rows: 24, projectId: project.id, cwd: repo, args: ['-c', 'printf ORCA_PTY_READY; while IFS= read -r line; do printf "OUT_%s\\n" "$line"; done'] }])
  const lease = await call('session.claimWriter', [pty])
  const conflict = await post('/call', { id: 'writer-other', issuedAt: Date.now(), method: 'session.claimWriter', args: [pty], revision: host.host.runtime.value.revision }, two)
  assert.equal(conflict.json().ok, false)
  let output = ''; const off = host.host.runtime.value.sessions.subscribe(event => { if (event.type === 'data' && event.ptyId === pty) output += event.data })
  const writerHeaders = { ...one, 'x-orca-pty': pty, 'x-orca-lease': lease.id, 'x-orca-sequence': '1' }
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await request('/pty/write', { method: 'POST', headers: writerHeaders, data: 'ONCE\n' })).status, 200)
  const deadline = Date.now() + 5000
  while (!output.includes('OUT_ONCE') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(output.match(/OUT_ONCE/g)?.length, 1)
  const events = (await request('/events?wait=20000', { headers: one })).json(); assert.ok(events.some(delivery => delivery.event?.topic === 'session.data'))
  assert.equal((await post('/auth/logout', {}, one)).status, 204)
  assert.equal((await post('/hello', hello, one)).status, 401)
  assert.equal(host.host.runtime.value.sessions.isAlive(pty), true)
  const partnerLease = await call('session.claimWriter', [pty], {}, two); assert.notEqual(partnerLease.id, lease.id)
  await request('/session', { method: 'DELETE', headers: two }); assert.equal(host.host.runtime.value.sessions.isAlive(pty), true)
  off()
  await assert.rejects(module.startWeb({ config, resourceDir: artifact }), /владел|owner|занят|друг/i)
  await host.stop(); host = undefined
  host = await module.startWeb({ config, resourceDir: artifact })
  assert.equal((await post('/hello', hello, two)).status, 401)
  assert.equal(host.host.runtime.value.sessions.terminalSnapshots().length, 0)
  await host.stop(); host = undefined
  const env = { ...process.env, ORCA_WEB_CONFIG: join(configDir, 'config.json'), NODE_OPTIONS: '' }
  cli = spawn(process.execPath, [join(artifact, 'control.mjs'), 'start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''; cli.stdout.on('data', bytes => { diagnostics += bytes }); cli.stderr.on('data', bytes => { diagnostics += bytes })
  const cliExit = once(cli, 'exit'); const readyDeadline = Date.now() + 10_000; let ready = false
  while (!ready && Date.now() < readyDeadline && cli.exitCode === null) {
    ready = await request('/health').then(response => response.status === 200).catch(() => false)
    if (!ready) await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(ready, true, diagnostics)
  for (const command of ['status', 'doctor']) execFileSync(process.execPath, [join(artifact, 'control.mjs'), command], { cwd: root, env, stdio: 'pipe', timeout: 10_000 })
  cli.kill('SIGTERM'); assert.deepEqual(await cliExit, [0, null], diagnostics); cli = undefined
  process.stdout.write(`Installed Web smoke PASS (${process.platform}): auth/CSRF, two principals, RPC replay, upload/download, isolated preview, native PTY/writer, logout/detach and restart\n`)
} finally { if (cli) cli.kill('SIGTERM'); if (host) await host.stop(); await rm(root, { recursive: true, force: true }) }
