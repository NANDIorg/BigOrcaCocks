import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('root без явного ROOT не начинает загрузку и не создаёт установку', { skip: process.platform === 'win32' }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orca-bootstrap-refusal-')); const tools = join(fixture, 'tools'); mkdirSync(tools)
  try {
    writeFileSync(join(tools, 'id'), '#!/bin/sh\nif [ "$1" = -un ]; then echo root; else echo 0; fi\n', { mode: 0o755 })
    writeFileSync(join(tools, 'uname'), '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n', { mode: 0o755 })
    writeFileSync(join(tools, 'curl'), '#!/bin/sh\necho forbidden-download > "$ORCA_TEST_DOWNLOAD"\nexit 99\n', { mode: 0o755 })
    const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, ORCA_WEB_HOME: join(fixture, 'installed'), ORCA_WEB_NO_SETUP: '1', ORCA_TEST_DOWNLOAD: join(fixture, 'download') }
    delete env.ORCA_WEB_ACK_ROOT
    const result = spawnSync('bash', [resolve('apps/web/install-orca-web.sh')], { input: '\n', encoding: 'utf8', env })
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /ROOT/)
    assert.equal(existsSync(join(fixture, 'download')), false)
    assert.equal(existsSync(join(fixture, 'installed')), false)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})

test('root проверяет потомков каталога установки до загрузки и привилегированных записей', { skip: process.platform !== 'linux' || process.getuid?.() !== 0 }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orca-root-paths-')); const tools = join(fixture, 'tools'); const base = join(fixture, 'installed')
  mkdirSync(tools); mkdirSync(join(base, 'bin'), { recursive: true })
  try {
    const protectedFile = join(fixture, 'protected'); writeFileSync(protectedFile, 'preserve root file', { mode: 0o600 }); symlinkSync(protectedFile, join(base, 'bin/orca-web'))
    writeFileSync(join(tools, 'curl'), '#!/bin/sh\necho forbidden > "$ORCA_TEST_DOWNLOAD"\nexit 99\n', { mode: 0o755 })
    const result = spawnSync('bash', [resolve('apps/web/install-orca-web.sh')], { encoding: 'utf8', env: { ...process.env, HOME: join(fixture, 'home'), PATH: `${tools}:${process.env.PATH}`, ORCA_WEB_HOME: base, ORCA_WEB_VERSION: '2.0.1', ORCA_WEB_NO_SETUP: '1', ORCA_WEB_ACK_ROOT: '1', ORCA_TEST_DOWNLOAD: join(fixture, 'download') } })
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /симлинк/i)
    assert.equal(existsSync(join(fixture, 'download')), false); assert.equal(readFileSync(protectedFile, 'utf8'), 'preserve root file')
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
