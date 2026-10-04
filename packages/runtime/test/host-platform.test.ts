import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { defaultShell } from '../src/sessions.ts'

test('headless использует Windows named pipe с сохранёнными разделителями', () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../../../apps/headless/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let expression: ts.Expression | undefined
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'socketPath') expression = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source); assert.ok(expression)
  const script = ts.transpileModule(`(${expression.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const context = createContext({ process: { platform: 'win32' }, location: { profileId: 'profile' }, join, homedir: () => '/home/test' })
  assert.equal(runInContext(script, context), String.raw`\\.\pipe\orca-agent-profile`)
})

test('service без SHELL выбирает системную оболочку Linux; host shell и Windows COMSPEC сохранены', () => {
  assert.equal(defaultShell('linux', {}), '/bin/sh')
  assert.equal(defaultShell('darwin', {}), '/bin/zsh')
  assert.equal(defaultShell('linux', { SHELL: '/custom/shell' }), '/custom/shell')
  assert.equal(defaultShell('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }), 'C:\\Windows\\System32\\cmd.exe')
})
