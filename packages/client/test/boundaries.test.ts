import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { auditContractImports } from '../../contracts/test/import-boundaries.ts'

test('client/UI production graph, type-only и orphan файлы не импортируют Node/Electron/Desktop', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  assert.deepEqual(auditContractImports(repo, { roots: ['packages/client/src', 'packages/ui/src', 'packages/ui/shared'], packages: ['client', 'ui', 'contracts', 'core'],
    externals: ['react', 'react-dom', '@xterm/xterm', '@xterm/addon-fit', 'dompurify', 'marked', 'refractor', 'vite/types/hot'] }), [])
})
