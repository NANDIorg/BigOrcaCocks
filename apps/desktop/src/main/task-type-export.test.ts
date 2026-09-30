// Запуск: pnpm --filter @orca-board/desktop test. Поток «Экспорта типа» без Electron: диалог и запись подставлены.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OrcaError, mtIn } from './i18n'
import { exportTaskTypeToFile, type TaskTypeExportDeps } from './task-type-export'

const FILE = { fileName: 'task-type-Бэкенд.json', text: '{"format":"orca-board.task-type"}\n' }

interface Calls {
  exported: string[]
  asked: string[]
  written: Array<{ path: string; text: string }>
}

/** Зависимости с журналом вызовов; `over` подменяет нужную. */
function deps(over: Partial<TaskTypeExportDeps> = {}): { deps: TaskTypeExportDeps; calls: Calls } {
  const calls: Calls = { exported: [], asked: [], written: [] }
  return {
    calls,
    deps: {
      export: (id) => { calls.exported.push(id); return FILE },
      chooseFile: async (name) => { calls.asked.push(name); return '/tmp/out.json' },
      write: (path, text) => { calls.written.push({ path, text }) },
      ...over
    }
  }
}

describe('exportTaskTypeToFile', () => {
  it('успех: диалог с именем по умолчанию, текст записан по выбранному пути, возвращён путь', async () => {
    const d = deps()
    assert.deepEqual(await exportTaskTypeToFile(d.deps, 'backend'), { path: '/tmp/out.json' })
    assert.deepEqual(d.calls.exported, ['backend'])
    assert.deepEqual(d.calls.asked, [FILE.fileName])
    assert.deepEqual(d.calls.written, [{ path: '/tmp/out.json', text: FILE.text }])
  })

  it('отмена диалога: null, запись не вызывается', async () => {
    const d = deps()
    d.deps.chooseFile = async (name) => { d.calls.asked.push(name); return null }
    assert.equal(await exportTaskTypeToFile(d.deps, 'backend'), null)
    assert.deepEqual(d.calls.asked, [FILE.fileName])
    assert.deepEqual(d.calls.written, [])
  })

  it('ошибка типа (нет типа, граф будущей версии) — до диалога, как есть', async () => {
    const d = deps({ export: () => { throw new OrcaError('workflow.future', { version: 99, known: 2 }) } })
    await assert.rejects(exportTaskTypeToFile(d.deps, 'type_future'), (e: unknown) => e instanceof OrcaError && e.key === 'workflow.future')
    assert.deepEqual(d.calls.asked, [], 'диалог не открывался')
    assert.deepEqual(d.calls.written, [])
  })

  it('ошибка записи — type.exportFailed с путём и причиной, на ru и en', async () => {
    const reason = "EACCES: permission denied, open '/tmp/out.json.tmp'"
    const d = deps({ write: () => { throw new Error(reason) } })
    await assert.rejects(exportTaskTypeToFile(d.deps, 'backend'), (e: unknown) => {
      assert.ok(e instanceof OrcaError)
      assert.equal(e.key, 'type.exportFailed')
      assert.deepEqual(e.params, { path: '/tmp/out.json', reason })
      assert.equal(e.message, `не удалось сохранить файл типа /tmp/out.json: ${reason}`)
      assert.equal(mtIn('ru', e.key, e.params), e.message)
      assert.equal(mtIn('en', e.key, e.params), `could not save the task type file /tmp/out.json: ${reason}`)
      return true
    })
  })

  it('причина — не Error: приводится к строке', async () => {
    const d = deps({ write: () => { throw 'диск полон' } })
    await assert.rejects(exportTaskTypeToFile(d.deps, 'backend'), (e: unknown) => e instanceof OrcaError && e.params?.reason === 'диск полон')
  })

  it('заголовок диалога есть на обоих языках', () => {
    assert.equal(mtIn('ru', 'dialog.exportType'), 'Экспорт типа задач')
    assert.equal(mtIn('en', 'dialog.exportType'), 'Export task type')
  })
})
