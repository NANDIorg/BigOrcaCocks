import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

it('обычный Node загружает core через пакет и восстанавливает доску runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-core-entry-'))
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
      import { jsonPersistence } from '@orca-board/runtime'
      const file = process.argv[1]
      const first = new TaskStore(jsonPersistence(file), () => DEFAULT_COLUMNS)
      const run = first.createRun('Серверный проект')
      const second = new TaskStore(jsonPersistence(file), () => DEFAULT_COLUMNS)
      assert.equal(second.getRun(run.id).objective, 'Серверный проект')
    `, join(dir, 'board.json')], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
    assert.equal(child.status, 0, child.stderr)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
