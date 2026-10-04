import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { auditContractImports } from './import-boundaries.ts'

function fixture(files: Record<string, string>, check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'orca-contracts-'))
  try {
    for (const [file, source] of Object.entries(files)) {
      const target = join(root, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
    }
    check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const entry = 'packages/contracts/src/index.ts'

test('относительные imports/reexports, literal dynamic import и JSON asset core допустимы', () => {
  fixture({
    [entry]: `import type { Item } from '@orca-board/core'
export { value } from './helper.ts'
export type { Item } from '../../core/src/types.ts'
export const load = () => import('./helper.ts')`,
    'packages/contracts/src/helper.ts': 'export const value = 1',
    'packages/core/src/index.ts': `export type { Item } from './types'`,
    'packages/core/src/types.ts': 'export interface Item { id: string }',
    'packages/core/src/release-codenames.ts': `import names from './release-codenames.json'; export { names }`,
    'packages/core/src/release-codenames.json': '{"1.1":"Orca"}',
    'packages/contracts/src/codenames.ts': `export { names } from '../../core/src/release-codenames.ts'`
  }, root => assert.deepEqual(auditContractImports(root), []))
})

for (const [specifier, reason] of [
  ['node:fs', 'node'], ['fs', 'node'], ['fs/promises', 'node'], ['net', 'node'],
  ['electron', 'electron'], ['electron/main', 'electron'], ['some-package', 'outside'],
  ['./missing.ts', 'outside'], ['../../../apps/desktop/src/host.ts', 'desktop']
] as const) {
  test(`import ${specifier} отклоняется с причиной ${reason}`, () => {
    fixture({ [entry]: `import '${specifier}'`, 'apps/desktop/src/host.ts': 'export const host = 1' }, root => {
      assert.deepEqual(auditContractImports(root), [{ file: entry, specifier, reason }])
    })
  })
}

for (const [source, specifier, reason] of [
  ["export * from 'node:fs'", 'node:fs', 'node'],
  ["import type { Stats } from 'fs'", 'fs', 'node'],
  ["export type { Host } from '../../../apps/desktop/src/host.ts'", '../../../apps/desktop/src/host.ts', 'desktop'],
  ["export const load = () => import('electron')", 'electron', 'electron'],
  ["export type Stats = import('node:fs').Stats", 'node:fs', 'node'],
  ["const target = './helper.ts'; export const load = () => import(target)", 'target', 'dynamic'],
  ["const target = './helper.ts'; export const load = () => require(target)", 'target', 'dynamic'],
  ["export const value = require('./helper.ts')", './helper.ts', 'dynamic'],
  ["import value = require('./helper.ts')", './helper.ts', 'dynamic']
] as const) {
  test(`AST видит границу: ${source}`, () => {
    fixture({ [entry]: source, 'apps/desktop/src/host.ts': 'export interface Host {}' }, root => {
      assert.deepEqual(auditContractImports(root), [{ file: entry, specifier, reason }])
    })
  })
}

test('проверяются транзитивные imports core и файлы contracts вне barrel, tests исключаются', () => {
  fixture({
    [entry]: "export type { Item } from '@orca-board/core'",
    'packages/core/src/index.ts': "export type { Item } from './types'",
    'packages/core/src/types.ts': "import type { Stats } from 'node:fs'; export interface Item { stat: Stats }",
    'packages/contracts/src/unexported.ts': "import 'electron'",
    'packages/contracts/src/ignored.test.ts': "import 'node:os'",
    'packages/contracts/src/test/ignored.ts': "import 'node:path'"
  }, root => {
    assert.deepEqual(auditContractImports(root), [
      { file: 'packages/contracts/src/unexported.ts', specifier: 'electron', reason: 'electron' },
      { file: 'packages/core/src/types.ts', specifier: 'node:fs', reason: 'node' }
    ])
  })
})

const root = resolve(import.meta.dirname, '../../..')

test('production import graph contracts и core не зависит от платформы', () => {
  assert.deepEqual(auditContractImports(root), [])
})

test('public surface исключает store, платформенный API и provider driver, включая type-only exports', () => {
  const configPath = join(root, 'packages/contracts/tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(join(root, entry))
  assert.ok(source)
  const moduleSymbol = checker.getSymbolAtLocation(source)
  assert.ok(moduleSymbol)
  const names = new Set(checker.getExportsOfModule(moduleSymbol).map(symbol => symbol.getName()))
  for (const name of ['TaskStore', 'Persistence', 'OrcaApi', 'AppSettings', 'UpdateState', 'WindowChromeMode',
    'AssistantConversation', 'ConversationOptions', 'ThemeColors', 'TaskTypeExportResult', 'PERMISSION_MODES',
    'AppMenuItem', 'auditContractImports']) {
    assert.equal(names.has(name), false, `${name} не является общим DTO`)
  }
  assert.deepEqual(parsed.options.types, [])
  assert.equal(program.getSourceFiles().some(file => /(?:lib\.dom(?:\.iterable)?\.d\.ts|@types[/\\]node[/\\])/.test(file.fileName)), false)
})
