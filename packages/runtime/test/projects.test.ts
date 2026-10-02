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

it('профили с одним репозиторием не смешивают настройки и события досок', () => {
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
