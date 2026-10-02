import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import type { ProjectMessageKey, ProjectMessageParams } from '../src/project-messages.ts'

class HostError extends Error {
  readonly key: ProjectMessageKey
  readonly params?: ProjectMessageParams
  constructor(key: ProjectMessageKey, params?: ProjectMessageParams) {
    super(key)
    this.key = key
    this.params = params
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-runtime-projects-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function services() {
  assert.equal(typeof runtime.createProjectServices, 'function', 'Проекты доступны обычному Node без Desktop')
  const messages = { Error: HostError, text: (key: ProjectMessageKey) => key }
  return runtime.createProjectServices({ messages, settings: runtime.createRuntimeSettings(messages) })
}

function repo(name = 'repo'): string {
  const root = join(dir, name)
  mkdirSync(root)
  execFileSync('git', ['init', '-q', root], { stdio: 'pipe' })
  return root
}

const graph = () => ({ version: 2, nodes: [{ id: 's', type: 'start' }, { id: 'w', type: 'work', roleIds: ['developer'] }, { id: 'e', type: 'end' }],
  edges: [{ id: 'sw', from: 's', outcome: 'next', to: 'w' }, { id: 'we', from: 'w', outcome: 'next', to: 'e' }] })

it('общий менеджер сохраняет проект и доску между запусками обычного Node', () => {
  const { ProjectManager } = services()
  const data = join(dir, 'profile')
  const manager = new ProjectManager(data)
  const project = manager.add(repo())
  const run = manager.store(project.id).createRun('Общая доска')
  const restored = new ProjectManager(data)
  assert.equal(restored.get(project.id)?.root, project.root)
  assert.equal(restored.store(project.id).getRun(run.id)?.objective, 'Общая доска')
  assert.equal(restored.active()?.id, project.id)
})

it('профили с одним репозиторием не смешивают настройки и доски', () => {
  const { ProjectManager } = services()
  const first = new ProjectManager(join(dir, 'first'))
  const second = new ProjectManager(join(dir, 'second'))
  const root = repo()
  const project = first.add(root)
  second.add(root)
  first.setSettings({ language: 'en' })
  first.store(project.id).createRun('Только первая доска')
  assert.equal(second.settings().language, undefined)
  assert.equal(second.store(project.id).listRuns().length, 0)
})

it('ошибки проектов и подготовки графа наследуют класс хоста и сохраняют validation', () => {
  const { ProjectManager, WorkflowValidationError } = services()
  const manager = new ProjectManager(join(dir, 'profile'))
  assert.throws(() => manager.activeStore(), e => e instanceof HostError && e.key === 'projects.none')
  assert.throws(() => manager.workflowCreate({ title: 'Невалидный', definition: { ...graph(), edges: [] } }), e =>
    e instanceof WorkflowValidationError && e instanceof HostError && e.key === 'workflow.notSaved' && e.validation.errors.length > 0)
  assert.equal(manager.taskTypes().some(t => t.title === 'Невалидный'), false)
})

it('удаление проекта очищает его вложения и снимки, сохраняя соседний проект', () => {
  const { ProjectManager } = services()
  const data = join(dir, 'profile')
  const manager = new ProjectManager(data)
  const first = manager.add(repo('first'))
  const second = manager.add(repo('second'))
  for (const root of ['run-images', 'showcase']) {
    for (const project of [first, second]) {
      const folder = join(data, root, project.id, 'run')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'file'), project.id)
    }
  }
  manager.remove(first.id)
  for (const root of ['run-images', 'showcase']) {
    assert.equal(existsSync(join(data, root, first.id)), false)
    assert.equal(readFileSync(join(data, root, second.id, 'run', 'file'), 'utf8'), second.id)
  }
  assert.deepEqual(new ProjectManager(data).list().map(p => p.id), [second.id])
})

it('общие настройки после сохранения и reload сохраняют непрозрачные поля хоста', () => {
  const { ProjectManager } = services()
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 2, projects: [], activeId: null,
    settings: { keepInBackground: false, updates: { autoDownload: false }, futureHost: { enabled: true }, language: 'ru' } }))
  const manager = new ProjectManager(dir)
  manager.setSettings({ language: 'en', assistant: { model: 'new' } })
  const stored = JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')) as runtime.ProjectsFile
  assert.deepEqual(stored.settings?.updates, { autoDownload: false })
  assert.equal(stored.settings?.keepInBackground, false)
  assert.deepEqual(stored.settings?.futureHost, { enabled: true })
  assert.equal(new ProjectManager(dir).settings().assistant.model, 'new')
})

it('неудачная запись настроек сохраняет подтверждённое состояние и не публикует событие', () => {
  const { ProjectManager } = services()
  const manager = new ProjectManager(dir)
  manager.setSettings({ language: 'ru' })
  const before = readFileSync(join(dir, 'projects.json'), 'utf8')
  let changes = 0
  manager.onDataChange(() => { changes++ })
  mkdirSync(join(dir, 'projects.json.tmp'))
  assert.throws(() => manager.setSettings({ language: 'en' }))
  assert.equal(manager.settings().language, 'ru')
  assert.equal(readFileSync(join(dir, 'projects.json'), 'utf8'), before)
  assert.equal(changes, 0)
})

it('запись графа со старой ревизией не перезаписывает новый граф', () => {
  const { ProjectManager } = services()
  const manager = new ProjectManager(dir)
  const context = manager.workflowGet('general')
  manager.workflowSet('general', context.revision, graph())
  const saved = manager.workflowGet('general')
  const disk = readFileSync(join(dir, 'projects.json'), 'utf8')
  assert.notEqual(saved.revision, context.revision)
  assert.throws(() => manager.workflowSet('general', context.revision, { ...graph(), edges: [] }), e => e instanceof HostError && e.key === 'workflow.conflict')
  assert.equal(manager.workflowGet('general').revision, saved.revision)
  assert.equal(readFileSync(join(dir, 'projects.json'), 'utf8'), disk)
})

it('ошибка записи библиотеки откатывает граф и не сообщает о сохранении', () => {
  const { ProjectManager } = services()
  const manager = new ProjectManager(dir)
  manager.setSettings({ language: 'ru' })
  const context = manager.workflowGet('general')
  const disk = readFileSync(join(dir, 'projects.json'), 'utf8')
  let saved = 0
  manager.onWorkflowSaved(() => { saved++ })
  mkdirSync(join(dir, 'projects.json.tmp'))
  assert.throws(() => manager.workflowSet('general', context.revision, graph()))
  assert.equal(manager.workflowGet('general').revision, context.revision)
  assert.equal(readFileSync(join(dir, 'projects.json'), 'utf8'), disk)
  assert.equal(saved, 0)
})

it('ленивая загрузка доски публикует store-open один раз, повторные изменения публикуют новые события', () => {
  const { ProjectManager } = services()
  const manager = new ProjectManager(join(dir, 'profile'))
  const project = manager.add(repo())
  const opened: string[] = []
  const off = manager.onStoreOpened(id => { opened.push(id) })
  const events: string[] = []
  manager.onEvents((_id, batch) => { events.push(...batch.map(e => e.id)) })
  assert.equal(manager.loadedStores().length, 0)
  const store = manager.store(project.id)
  assert.equal(manager.store(project.id), store)
  store.createTask({ title: 'Первая', spec: '' })
  const count = events.length
  store.createTask({ title: 'Вторая', spec: '' })
  assert.ok(count > 0)
  assert.ok(events.length > count)
  assert.equal(new Set(events).size, events.length)
  assert.deepEqual(opened, [project.id])
  off()
  const second = manager.add(repo('second'))
  manager.store(second.id)
  assert.deepEqual(opened, [project.id])
})
