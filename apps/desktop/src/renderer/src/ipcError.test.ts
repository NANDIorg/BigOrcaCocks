// Ошибки invoke из main: срез обёртки ipcRenderer и имени, код OrcaError[…] для распознавания без текста.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'

test('ipcErrorMessage: срезает обёртку и имя — обычное Error и OrcaError[код]', () => {
  assert.equal(ipcErrorMessage(new Error("Error invoking remote method 'docs:read': Error: файл не найден: a.md")), 'файл не найден: a.md')
  assert.equal(ipcErrorMessage(new Error("Error invoking remote method 'docs:read': OrcaError[docs.notFound]: file not found: a.md")), 'file not found: a.md')
  assert.equal(ipcErrorMessage('просто текст'), 'просто текст')
})

test('ipcErrorCode: код только у OrcaError, у старого main и обычных ошибок — нет', () => {
  assert.equal(ipcErrorCode(new Error("Error invoking remote method 'docs:read': OrcaError[docs.notFound]: file not found: a.md")), 'docs.notFound')
  assert.equal(ipcErrorCode(new Error("Error invoking remote method 'docs:read': Error: файл не найден: a.md")), undefined)
  assert.equal(ipcErrorCode(new Error('OrcaError[docs.notFound] в середине текста')), undefined)
})
