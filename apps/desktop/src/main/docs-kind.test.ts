// Лимиты просмотра и словари ошибок Desktop; классификатор проверяется в contracts.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DOC_IMAGE_MAX_BYTES, DOC_SNIFF_BYTES, DOC_TEXT_MAX_BYTES, DOCS_LIST_LIMIT } from '../shared/docs-view'
import { SHOWCASE_READ_MAX_BYTES } from '../shared/showcase'
import { DOC_VIEW_ERROR_CODES, PROJECT_FILES_ERROR_CODES } from '../shared/ipc'
import ru from './strings/ru'
import en from './strings/en'

describe('контракт docs:view', () => {
  it('лимиты', () => {
    assert.equal(DOC_TEXT_MAX_BYTES, 1024 * 1024)
    assert.equal(DOC_IMAGE_MAX_BYTES, SHOWCASE_READ_MAX_BYTES)
    assert.equal(DOCS_LIST_LIMIT, 100_000)
    assert.equal(DOC_SNIFF_BYTES, 8192)
  })

  it('files.notFile и коды docs:* есть в словарях main ru и en', () => {
    const codes: readonly string[] = [...DOC_VIEW_ERROR_CODES, 'files.notFile']
    assert.ok((PROJECT_FILES_ERROR_CODES as readonly string[]).includes('files.notFile'))
    for (const code of codes) {
      assert.ok(Object.hasOwn(ru, code), `ru: ${code}`)
      assert.ok(Object.hasOwn(en, code), `en: ${code}`)
    }
  })

})
