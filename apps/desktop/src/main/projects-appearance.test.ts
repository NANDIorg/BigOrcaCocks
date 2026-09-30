import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectManager } from './projects'
import { PROJECTS_FILE_VERSION } from './task-types-migration'
import type { AppSettingsPatch } from '../shared/ipc'

function configTest(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'orca-appearance-'))
  try { run(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('старые настройки и повреждённое оформление загружаются с прежней графитовой темой', () => configTest(directory => {
  for (const appearance of [undefined, null, 'dark', { theme: 'missing', motion: 42 }]) {
    writeFileSync(join(directory, 'projects.json'), JSON.stringify({ version: PROJECTS_FILE_VERSION, projects: [], settings: { appearance } }))
    assert.deepEqual(new ProjectManager(directory).settings().appearance, { theme: 'graphite', motion: 'system' })
  }
}))

test('тема переживает перезапуск; частичный патч движения сохраняет тему и остальные настройки', () => configTest(directory => {
  const manager = new ProjectManager(directory)
  manager.setSettings({ language: 'en', keepInBackground: false, appearance: { theme: 'slate' } })
  manager.setSettings({ appearance: { motion: 'reduced' } })
  const restored = new ProjectManager(directory).settings()
  assert.deepEqual(restored.appearance, { theme: 'slate', motion: 'reduced' })
  assert.equal(restored.language, 'en')
  assert.equal(restored.keepInBackground, false)
}))

test('некорректный патч оформления отклоняется целиком и не перезаписывает сохранённые настройки', () => configTest(directory => {
  const manager = new ProjectManager(directory)
  manager.setSettings({ appearance: { theme: 'forest' } })
  for (const appearance of [null, [], 'dark', { theme: 'missing' }, { motion: true }, { theme: 'slate', motion: 'missing' }]) {
    assert.throws(() => manager.setSettings({ keepInBackground: false, appearance } as AppSettingsPatch))
    assert.deepEqual(new ProjectManager(directory).settings().appearance, { theme: 'forest', motion: 'system' })
    assert.equal(manager.settings().keepInBackground, true)
  }
}))

test('сбой записи не оставляет несохранённую тему в памяти main', () => configTest(directory => {
  const manager = new ProjectManager(directory)
  manager.setSettings({ appearance: { theme: 'slate' } })
  const file = join(directory, 'projects.json')
  const saved = join(directory, 'saved.json')
  renameSync(file, saved)
  mkdirSync(file)
  try {
    assert.throws(() => manager.setSettings({ appearance: { theme: 'paper' } }))
    assert.equal(manager.settings().appearance?.theme, 'slate')
  } finally {
    rmSync(file, { recursive: true })
    renameSync(saved, file)
  }
  assert.equal(new ProjectManager(directory).settings().appearance?.theme, 'slate')
}))
