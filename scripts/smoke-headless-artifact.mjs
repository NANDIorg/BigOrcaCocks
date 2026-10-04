import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const artifact = resolve(process.argv[2]); assert.equal(process.versions.node.split('.')[0], '24')
assert.equal(process.env.DISPLAY, undefined); assert.equal(process.versions.electron, undefined)
const module = await import(pathToFileURL(join(artifact, 'index.mjs')).href)
const root = mkdtempSync(join(tmpdir(), 'orca-installed-smoke-')); const profile = join(root, 'profile'); const repo = join(root, 'repo')
mkdirSync(profile); mkdirSync(repo)
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
git(['init', '--quiet']); git(['-c', 'user.name=Orca smoke', '-c', 'user.email=smoke@orca.invalid', 'commit', '--allow-empty', '-qm', 'init'])
let host
try {
  host = await module.startHeadless({ dataDir: profile, resourceDir: artifact })
  const project = await host.runtime.value.projects.add(repo)
  const info = JSON.parse(readFileSync(join(profile, 'operator-endpoint.json'), 'utf8'))
  const headers = { authorization: `Bearer ${info.token}`, 'x-orca-client': 'installed-smoke', 'content-type': 'application/json' }
  const post = async (path, input) => { const response = await fetch(info.url + path, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(response.status, 200); return response.json() }
  await post('/hello', { protocolMajor: 1, schemaVersion: 1, product: { name: 'smoke', version: '9.0.0' } })
  await post('/select', { projectId: project.id }); const initial = await post('/snapshot', {})
  assert.equal(initial.snapshot.projects.projects[0].root, project.root)
  const { stdout: oldCli } = await promisify(execFile)(process.execPath, [join(artifact, 'cli/orca-board.js'), 'projects', 'list', '--json'], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ORCA_SOCKET: info.socketPath } })
  assert.match(oldCli, /repo/)
  let output = ''; const observed = host.runtime.value.sessions.subscribe(event => { if (event.type === 'data') output += event.data })
  const result = await post('/call', { id: 'native-pty', issuedAt: Date.now(), method: 'session.spawn', revision: host.runtime.value.revision,
    args: [{ cols: 80, rows: 24, projectId: project.id, command: '/bin/sh', args: ['-c', 'printf ORCA_REAL_PTY; while IFS= read -r line; do printf \"OUT_%s\\n\" \"$line\"; done'], cwd: repo }] })
  assert.equal(result.ok, true)
  const deadline = Date.now() + 5000
  while (!output.includes('ORCA_REAL_PTY') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(output, /ORCA_REAL_PTY/); assert.equal(host.runtime.value.sessions.isAlive(result.result), true)
  const lease = await post('/call', { id: 'writer-lease', issuedAt: Date.now(), method: 'session.claimWriter', revision: host.runtime.value.revision, args: [result.result] }); assert.equal(lease.ok, true)
  const writerHeaders = { ...headers, 'x-orca-pty': result.result, 'x-orca-lease': lease.result.id, 'x-orca-sequence': '1' }
  for (let i = 0; i < 2; i++) { const response = await fetch(info.url + '/pty/write', { method: 'POST', headers: writerHeaders, body: 'ONCE\n' }); assert.equal(response.status, 200); await response.json() }
  const writtenDeadline = Date.now() + 3000
  while (!output.includes('OUT_ONCE') && Date.now() < writtenDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(output.match(/OUT_ONCE/g)?.length, 1)
  await fetch(info.url + '/session', { method: 'DELETE', headers }); assert.equal(host.runtime.value.sessions.isAlive(result.result), true)
  await assert.rejects(module.startHeadless({ dataDir: profile, resourceDir: artifact }), /владел|owner|занят|друг/i)
  const branch = await host.runtime.value.resources.git.currentBranch(repo); assert.ok(branch)
  observed(); await host.stop(); host = undefined
  const next = await module.startHeadless({ dataDir: profile, resourceDir: artifact }); await next.stop()
  process.stdout.write(`Installed Node24 smoke PASS (${process.platform}): native PTY, Git, legacy CLI, operator snapshot/disconnect, ownership/restart\n`)
} finally { if (host) await host.stop(); rmSync(root, { recursive: true, force: true }) }
