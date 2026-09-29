// Вкладка «Файлы»: доступность API в старом preload/main и тексты отказов по коду OrcaError.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_FILES_ERROR_CODES, type OrcaApi } from '../../shared/ipc'
import { setLocale, translate } from './i18n'
import { filesApi, filesError, filesErrorMessage, filesStaleMessage, isStaleFilesError } from './projectFiles'

afterEach(() => setLocale('ru'))

/** Ошибка invoke так, как её видит renderer: обёртка ipcRenderer + OrcaError[код]. */
function orcaError(code: string, text: string): Error {
  return new Error(`Error invoking remote method 'files:list': OrcaError[${code}]: ${text}`)
}

const CTX = { path: 'apps/desktop', root: '/repo' }

test('filesApi — нет files в preload: понятная ошибка вместо падения', () => {
  assert.throws(() => filesApi(undefined), { message: filesStaleMessage() })
  assert.throws(() => filesApi({} as Partial<OrcaApi>), { message: filesStaleMessage() })
  const files = { list: async () => ({ dir: '', entries: [], truncated: false }), reveal: async () => undefined }
  assert.equal(filesApi({ files }), files)
})

test('isStaleFilesError — новый preload, старый main', () => {
  assert.equal(isStaleFilesError("Error invoking remote method 'files:list': Error: No handler registered for 'files:list'"), true)
  assert.equal(isStaleFilesError("No handler registered for 'docs:list'"), false)
  assert.equal(isStaleFilesError('files.notFound'), false)
})

test('filesError — старый main и старый preload помечены stale, без «Повторить»', () => {
  const noHandler = filesError(new Error("Error invoking remote method 'files:list': Error: No handler registered for 'files:list'"), CTX)
  assert.deepEqual(noHandler, { message: filesStaleMessage(), stale: true })
  let thrown: unknown
  try {
    filesApi(undefined)
  } catch (e) {
    thrown = e
  }
  assert.equal(filesError(thrown, CTX).stale, true)
})

test('у каждого кода из PROJECT_FILES_ERROR_CODES свой текст на обоих языках', () => {
  for (const code of PROJECT_FILES_ERROR_CODES) {
    const key = `config.files.err.${code.slice('files.'.length)}` as const
    for (const locale of ['ru', 'en'] as const) {
      const text = translate(locale, key as Parameters<typeof translate>[1], { path: 'x' })
      assert.notEqual(text, key, `${locale}: нет ключа ${key}`)
      assert.match(text, /x/, `${locale}: ${key} без пути`)
    }
    const e = filesError(orcaError(code, ''), CTX)
    assert.equal(e.code, code)
    assert.ok(e.message.trim(), `${code}: пустой текст`)
  }
})

test('filesErrorMessage — текст по коду, а не по тексту main', () => {
  assert.equal(filesErrorMessage(orcaError('files.notFound', 'folder not found'), CTX), 'Папки уже нет на диске: apps/desktop')
  assert.equal(filesErrorMessage(orcaError('files.rootMissing', 'x'), CTX), 'Папка проекта не найдена: /repo')
  setLocale('en')
  assert.equal(filesErrorMessage(orcaError('files.notDir', 'не папка'), CTX), 'Not a folder: apps/desktop')
})

test('filesErrorMessage — readFailed и неизвестный код: текст main (в нём причина)', () => {
  assert.equal(filesErrorMessage(orcaError('files.readFailed', 'не удалось прочитать apps: EACCES'), CTX), 'не удалось прочитать apps: EACCES')
  assert.equal(filesErrorMessage(orcaError('files.readFailed', ''), CTX), 'Не удалось прочитать папку: apps/desktop')
  assert.equal(filesErrorMessage(orcaError('files.somethingNew', 'новое'), CTX), 'новое')
  assert.equal(filesErrorMessage(new Error("Error invoking remote method 'files:list': Error: project not found"), CTX), 'project not found')
})
