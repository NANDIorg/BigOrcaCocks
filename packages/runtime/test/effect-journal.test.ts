import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'

function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-journal-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return { dataDir, file: join(dataDir, 'effect-journal.json'), position: { repoRoot: join(dataDir, 'repo'), projectId: 'p', taskId: 't', taskCreatedAt: 10, nodeId: 'git', visit: 1 } }
}
test('журнал сохраняет intent/native/checkpoint, restart fence и detached DTO', t => {
  const f = fixture(t); const a = runtime.createEffectJournal({ dataDir: f.dataDir, ownerId: 'a' })
  assert.equal(existsSync(f.file), false)
  const id = a.begin(f.position, { kind: 'git', operation: 'commit', cwd: f.position.repoRoot })
  const saved = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.equal(saved.version, 1); assert.equal(saved.records[0].phase, 'intent')
  f.position.visit = 2; assert.equal(a.pending()[0].position.visit, 1)
  a.nativeCompleted(id); const b = runtime.createEffectJournal({ dataDir: f.dataDir, ownerId: 'b' })
  const p = { ...f.position, visit: 1 }; assert.throws(() => b.assertClear(p), /неопределён/)
  assert.doesNotThrow(() => b.assertClear(f.position))
  assert.doesNotThrow(() => b.assertClear({ ...p, taskCreatedAt: 11 }))
  const record = b.pending()[0]; record.position.visit = 99
  assert.equal(b.pending()[0].position.visit, 1)
  assert.throws(() => b.resolve(id, 1, 'retry'), /revision/)
  b.resolve(id, 2, 'retry'); assert.equal(b.pending().length, 0); assert.doesNotThrow(() => b.assertClear(p))
  const second = b.begin(p, { kind: 'pty', operation: 'spawn', cwd: p.repoRoot }); b.nativeCompleted(second); b.applied([second])
  assert.equal(runtime.createEffectJournal({ dataDir: f.dataDir, ownerId: 'c' }).pending().length, 0)
})
test('corrupt и future journal отвергаются без изменения байтов', t => {
  const f = fixture(t)
  for (const text of ['{', '{"version":99,"records":[]}', '{"version":1,"records":[{}]}']) {
    writeFileSync(f.file, text)
    assert.throws(() => runtime.createEffectJournal({ dataDir: f.dataDir, ownerId: 'a' }), /журнал|схем/)
    assert.equal(readFileSync(f.file, 'utf8'), text)
  }
})
test('capacity не теряет pending; завершённая история ограничена', t => {
  const f = fixture(t); const journal = runtime.createEffectJournal({ dataDir: f.dataDir, ownerId: 'a', maxPending: 2, maxCompleted: 1 })
  const effect = { kind: 'files' as const, operation: 'placement', cwd: f.position.repoRoot }
  const first = journal.begin(f.position, effect); const second = journal.begin(f.position, effect)
  assert.throws(() => journal.begin(f.position, effect), /лимит/); assert.equal(journal.pending().length, 2)
  journal.nativeCompleted(first); journal.applied([first])
  const third = journal.begin(f.position, effect); journal.nativeCompleted(third); journal.applied([third])
  const records = JSON.parse(readFileSync(f.file, 'utf8')).records
  assert.equal(records.length, 2); assert.ok(records.some((r: { id: string }) => r.id === second))
})
test('ошибка атомарной записи не публикует intent или checkpoint в памяти', t => {
  const f = fixture(t); const journal = runtime.createEffectJournal({ dataDir: f.dataDir, ownerId: 'a' })
  const effect = { kind: 'git' as const, operation: 'commit', cwd: f.position.repoRoot }
  mkdirSync(`${f.file}.tmp`); assert.throws(() => journal.begin(f.position, effect)); assert.equal(journal.pending().length, 0)
  rmSync(`${f.file}.tmp`, { recursive: true }); const id = journal.begin(f.position, effect); journal.nativeCompleted(id)
  const before = readFileSync(f.file, 'utf8'); mkdirSync(`${f.file}.tmp`)
  assert.throws(() => journal.applied([id])); assert.equal(journal.pending().length, 1); assert.equal(readFileSync(f.file, 'utf8'), before)
})
