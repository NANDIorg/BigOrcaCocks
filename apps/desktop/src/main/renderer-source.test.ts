// Запуск: pnpm --filter @orca-board/desktop test. Выбор источника renderer для главного окна.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rendererSource } from './renderer-source'

const indexHtml = '/app/out/renderer/index.html'

describe('rendererSource', () => {
  it('dev: берёт dev-сервер из ELECTRON_RENDERER_URL', () => {
    assert.deepEqual(rendererSource({ isPackaged: false, devUrl: 'http://localhost:5173', indexHtml }), {
      kind: 'url',
      url: 'http://localhost:5173'
    })
  })

  it('dev без переменной: собранный файл', () => {
    assert.deepEqual(rendererSource({ isPackaged: false, devUrl: undefined, indexHtml }), { kind: 'file', path: indexHtml })
    assert.deepEqual(rendererSource({ isPackaged: false, devUrl: '', indexHtml }), { kind: 'file', path: indexHtml })
  })

  it('упакованная сборка игнорирует унаследованный ELECTRON_RENDERER_URL', () => {
    assert.deepEqual(rendererSource({ isPackaged: true, devUrl: 'http://localhost:5173', indexHtml }), {
      kind: 'file',
      path: indexHtml
    })
    assert.deepEqual(rendererSource({ isPackaged: true, devUrl: 'https://evil.example', indexHtml }), {
      kind: 'file',
      path: indexHtml
    })
  })
})
