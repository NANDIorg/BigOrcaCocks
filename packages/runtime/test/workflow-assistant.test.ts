import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_ROLES, defaultWorkflow } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { ProfileHostError } from './profile-command-test-host.ts'

function fixture(t: { after(fn: () => void): void }) {
  assert.equal(typeof runtime.createWorkflowAssistantServices, 'function', 'Workflow context/save работают без Desktop')
  const messages = { Error: ProfileHostError, text: (key: string) => key }
  const { ProjectManager } = runtime.createProjectServices({ messages, settings: runtime.createRuntimeSettings(messages) })
  const helpers = runtime.createWorkflowAssistantServices({ messages })
  const dir = mkdtempSync(join(tmpdir(), 'orca-runtime-workflow-context-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'projects.json')
  writeFileSync(file, JSON.stringify({ version: runtime.PROJECTS_FILE_VERSION, projects: [], activeId: null, taskTypesSeeded: true,
    taskTypes: [{ id: 'mine', title: 'Авторитетное имя', settings: { roles: DEFAULT_ROLES.map(r => ({ ...r, extraArgs: 'SECRET' })) } }] }))
  return { pm: new ProjectManager(dir), helpers, disk: () => readFileSync(file, 'utf8') }
}

test('общий assistant context берёт авторитетные роли/название/ревизию, невалидный draft обсуждаем', t => {
  const { pm, helpers } = fixture(t)
  const baseline = pm.workflowGet('mine').workflow
  const draft = { ...structuredClone(baseline), edges: [] }
  const context = helpers.buildWorkflowAssistantContext(pm, { mode: 'edit', typeId: 'mine', title: 'Подмена', workflow: draft, baseline, dirty: true, path: [] })
  assert.match(context, /Авторитетное имя/); assert.match(context, new RegExp(pm.workflowGet('mine').revision))
  assert.match(context, /"edges":\[\]/); assert.equal(context.includes('SECRET'), false); assert.equal(context.includes('Подмена'), false)
})
test('context injection и stale baseline отвергаются без изменения файла', t => {
  const { pm, helpers, disk } = fixture(t)
  const baseline = pm.workflowGet('mine').workflow
  for (const input of ['instruction', { mode: 'edit' }, { mode: 'create', system: 'inject' }]) {
    assert.throws(() => helpers.buildWorkflowAssistantContext(pm, input), { key: 'workflow.contextInvalid' })
  }
  const next = structuredClone(baseline); next.nodes[0].title = 'Новая база'; pm.patchTaskType('mine', { workflow: next })
  const after = disk()
  assert.throws(() => helpers.buildWorkflowAssistantContext(pm, { mode: 'edit', typeId: 'mine', title: '', baseline, workflow: baseline, dirty: false, path: [] }), { key: 'workflow.conflict' })
  assert.throws(() => helpers.saveWorkflowDraft(pm, 'mine', baseline, null), { key: 'workflow.conflict' }); assert.equal(disk(), after)
})
test('общий guarded Save/Reset сохраняет актуальные роли/правила и не публикует workflowSaved', t => {
  const { pm, helpers } = fixture(t); const baseline = pm.workflowGet('mine').workflow
  const next = structuredClone(baseline); next.nodes[0].title = 'Новый граф'
  const events: unknown[] = []; pm.onWorkflowSaved(saved => events.push(saved))
  helpers.saveWorkflowDraft(pm, 'mine', baseline, next)
  pm.patchTaskType('mine', { roles: DEFAULT_ROLES, agentRules: 'Свежие правила', workflowNotes: [] })
  pm.renameTaskType('mine', { title: 'Переименование' }); assert.deepEqual(pm.workflowGet('mine').workflow, next)
  helpers.saveWorkflowDraft(pm, 'mine', next, null)
  assert.deepEqual(pm.workflowGet('mine').workflow, defaultWorkflow(DEFAULT_ROLES))
  assert.equal(pm.taskType('mine')?.settings.agentRules, 'Свежие правила'); assert.deepEqual(events, [])
})
