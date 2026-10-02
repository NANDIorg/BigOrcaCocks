import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditRuntimeImports } from './import-boundaries.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-runtime-boundaries-'))
  write('packages/runtime/src/index.ts', '')
  write('packages/core/src/index.ts', '')
  write('packages/contracts/src/index.ts', '')
  write('apps/desktop/src/types.ts', 'export interface Desktop {}')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function write(file: string, text: string): void {
  const path = join(dir, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

it('runtime разрешает Node и общие пакеты', () => {
  write('packages/runtime/src/index.ts', "import 'node:fs'; import 'path'; export * from '@orca-board/core'; export type { Project } from '@orca-board/contracts'; import('./leaf.ts')")
  write('packages/contracts/src/index.ts', 'export interface Project {}')
  write('packages/runtime/src/leaf.ts', "import 'node:child_process'")
  assert.deepEqual(auditRuntimeImports(dir), [])
})

for (const declaration of [
  "import 'electron'", "export type { BrowserWindow } from 'electron'",
  "type Window = import('electron').BrowserWindow", "import('electron')"
]) {
  it(`runtime запрещает Electron edge: ${declaration}`, () => {
    write('packages/runtime/src/index.ts', declaration)
    assert.deepEqual(auditRuntimeImports(dir), [{ file: 'packages/runtime/src/index.ts', specifier: 'electron', reason: 'electron' }])
  })
}

it('type-only импорт Desktop также нарушает границу', () => {
  write('packages/runtime/src/index.ts', "import type { Desktop } from '../../../apps/desktop/src/types.ts'")
  assert.deepEqual(auditRuntimeImports(dir), [{ file: 'packages/runtime/src/index.ts', specifier: '../../../apps/desktop/src/types.ts', reason: 'outside' }])
})

it('транзитивный импорт Desktop через core обнаруживается', () => {
  write('packages/runtime/src/index.ts', "export * from '@orca-board/core'")
  write('packages/core/src/index.ts', "export type { Desktop } from '../../../apps/desktop/src/types.ts'")
  assert.deepEqual(auditRuntimeImports(dir), [{ file: 'packages/core/src/index.ts', specifier: '../../../apps/desktop/src/types.ts', reason: 'outside' }])
})

it('неэкспортируемый файл runtime проверяется', () => {
  write('packages/runtime/src/orphan.ts', "import 'electron'")
  assert.deepEqual(auditRuntimeImports(dir), [{ file: 'packages/runtime/src/orphan.ts', specifier: 'electron', reason: 'electron' }])
})

for (const declaration of ["import(target)", "require('electron')", "require.resolve('electron')", "import x = require('electron')"]) {
  it(`неявная зависимость запрещена: ${declaration}`, () => {
    write('packages/runtime/src/index.ts', declaration)
    const issues = auditRuntimeImports(dir)
    assert.equal(issues.length, 1)
    assert.equal(issues[0].reason, 'dynamic')
  })
}

it('относительный выход за общие пакеты запрещён', () => {
  write('other.ts', 'export const value = 1')
  write('packages/runtime/src/index.ts', "export * from '../../../other.ts'")
  assert.deepEqual(auditRuntimeImports(dir), [{ file: 'packages/runtime/src/index.ts', specifier: '../../../other.ts', reason: 'outside' }])
})

it('symlink не маскирует Desktop под relative runtime import', () => {
  symlinkSync(join(dir, 'apps/desktop/src'), join(dir, 'packages/runtime/src/linked'), 'junction')
  write('packages/runtime/src/index.ts', "export type { Desktop } from './linked/types.ts'")
  assert.deepEqual(auditRuntimeImports(dir), [{ file: 'packages/runtime/src/index.ts', specifier: './linked/types.ts', reason: 'outside' }])
})

it('настоящий runtime не зависит от Electron/Desktop', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  assert.deepEqual(auditRuntimeImports(repo), [])
})

it('package entrypoint сохраняет данные в обычном Node без Electron loader', () => {
  const runtime = fileURLToPath(new URL('../', import.meta.url))
  const file = join(dir, 'plain-node.json')
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileAtomic, readJsonFile, createGitOperations } from '@orca-board/runtime'
    writeFileAtomic(process.argv[1], '{"headless":true}')
    if (readJsonFile(process.argv[1], 'test').status !== 'ok') process.exit(2)
    const git = createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'Untracked:' })
    if (git.projectBranchInfo(process.argv[2]).isGitRepo) process.exit(3)
  `, file, dir], { cwd: runtime, stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' } })
  assert.equal(readFileSync(file, 'utf8'), '{"headless":true}')
})
