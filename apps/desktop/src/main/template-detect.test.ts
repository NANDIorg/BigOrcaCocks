// Запуск: pnpm --filter @orca-board/desktop test. Подсказка типа проекта по файлам репозитория.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectTemplate } from './template-detect'

let tmp: string

function repo(files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true })
    writeFileSync(path.join(tmp, file), text)
  }
  return tmp
}

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}): string =>
  JSON.stringify({ dependencies: deps, devDependencies: dev })

beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'orca-detect-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('detectTemplate', () => {
  it('пустой репозиторий — признаков нет', () => {
    assert.deepEqual(detectTemplate(repo({})), { templateId: null, reason: '' })
  })

  it('фронтенд по зависимостям package.json', () => {
    assert.deepEqual(detectTemplate(repo({ 'package.json': pkg({ vue: '3' }) })), { templateId: 'frontend', reason: 'package.json: vue' })
  })

  it('бэкенд по файлам языка и серверному фреймворку', () => {
    assert.equal(detectTemplate(repo({ 'go.mod': 'module x' })).templateId, 'backend')
    rmSync(path.join(tmp, 'go.mod'))
    assert.equal(detectTemplate(repo({ 'package.json': pkg({ express: '4' }) })).templateId, 'backend')
  })

  it('фронт + бэкенд — fullstack', () => {
    const hint = detectTemplate(repo({ 'package.json': pkg({ react: '18' }), 'pyproject.toml': '' }))
    assert.equal(hint.templateId, 'fullstack')
    assert.match(hint.reason, /react.*pyproject\.toml/)
  })

  it('мобилка важнее фронта: react-native, AndroidManifest, xcodeproj, pubspec', () => {
    assert.equal(detectTemplate(repo({ 'package.json': pkg({ react: '18', 'react-native': '0.7' }) })).templateId, 'mobile')
    assert.deepEqual(
      detectTemplate(repo({ 'app/src/main/AndroidManifest.xml': '<manifest/>' })),
      { templateId: 'mobile', reason: 'app/src/main/AndroidManifest.xml' }
    )
  })

  it('xcodeproj в ios/ и pubspec.yaml', () => {
    mkdirSync(path.join(tmp, 'ios', 'App.xcodeproj'), { recursive: true })
    assert.deepEqual(detectTemplate(tmp), { templateId: 'mobile', reason: 'ios/App.xcodeproj' })
    rmSync(path.join(tmp, 'ios'), { recursive: true })
    assert.deepEqual(detectTemplate(repo({ 'pubspec.yaml': '' })), { templateId: 'mobile', reason: 'pubspec.yaml' })
  })

  it('автотесты — только тестовый раннер без фреймворка UI', () => {
    assert.equal(detectTemplate(repo({ 'package.json': pkg({}, { '@playwright/test': '1' }) })).templateId, 'autotests')
  })

  it('документация по mkdocs.yml; битый package.json не мешает', () => {
    assert.equal(detectTemplate(repo({ 'package.json': '{', 'mkdocs.yml': '' })).templateId, 'docs')
  })
})
