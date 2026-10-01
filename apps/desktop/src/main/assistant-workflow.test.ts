import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_ROLES, defaultWorkflow } from '@orca-board/core'
import { ProjectManager } from './projects'
import { buildWorkflowAssistantContext, saveWorkflowDraft } from './assistant-workflow'
import { PROJECTS_FILE_VERSION } from './task-types-migration'

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-workflow-context-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'projects.json')
  writeFileSync(file, JSON.stringify({ version: PROJECTS_FILE_VERSION, projects: [], activeId: null, taskTypesSeeded: true,
    taskTypes: [{ id: 'mine', title: 'Авторитетное имя', settings: { roles: DEFAULT_ROLES.map((r) => ({ ...r, extraArgs: 'SECRET' })) } }] }))
  return { pm: new ProjectManager(dir), disk: () => readFileSync(file, 'utf8') }
}

test('main context берёт роли, название и ревизию из библиотеки; семантически невалидный draft обсуждаем', (t) => {
  const { pm } = fixture(t)
  const baseline = pm.workflowGet('mine').workflow
  const draft = { ...structuredClone(baseline), edges: [] }
  const context = buildWorkflowAssistantContext(pm, { mode: 'edit', typeId: 'mine', title: 'Подмена', workflow: draft, baseline, dirty: true, path: [] })
  assert.match(context, /Авторитетное имя/)
  assert.match(context, new RegExp(pm.workflowGet('mine').revision))
  assert.match(context, /"edges":\[\]/)
  assert.equal(context.includes('SECRET'), false)
  assert.equal(context.includes('Подмена'), false)
})

test('main отвергает произвольные инструкции, неверную форму и stale baseline без записи', (t) => {
  const { pm, disk } = fixture(t)
  const baseline = pm.workflowGet('mine').workflow
  const before = disk()
  for (const input of ['instruction', { mode: 'edit' }, { mode: 'create', system: 'inject' }]) {
    assert.throws(() => buildWorkflowAssistantContext(pm, input), { key: 'workflow.contextInvalid' })
  }
  const next = structuredClone(baseline); next.nodes[0].title = 'Новая база'
  pm.patchTaskType('mine', { workflow: next })
  assert.throws(() => buildWorkflowAssistantContext(pm, { mode: 'edit', typeId: 'mine', title: '', baseline, workflow: baseline, dirty: false, path: [] }), { key: 'workflow.conflict' })
  assert.notEqual(disk(), before)
  const after = disk()
  assert.throws(() => saveWorkflowDraft(pm, 'mine', baseline, baseline), { key: 'workflow.conflict' })
  assert.throws(() => saveWorkflowDraft(pm, 'mine', baseline, null), { key: 'workflow.conflict' })
  assert.equal(disk(), after)
})

test('guarded Save и Reset патчат только граф; delayed roles/rules/rename и notes сохраняют новый workflow', (t) => {
  const { pm } = fixture(t)
  const baseline = pm.workflowGet('mine').workflow
  const next = structuredClone(baseline); next.nodes[0].title = 'Новый граф'
  const events: unknown[] = []; pm.onWorkflowSaved((saved) => events.push(saved))
  saveWorkflowDraft(pm, 'mine', baseline, next)
  pm.patchTaskType('mine', { roles: DEFAULT_ROLES, agentRules: 'Свежие правила', workflowNotes: [] })
  pm.renameTaskType('mine', { title: 'Переименование' })
  assert.deepEqual(pm.workflowGet('mine').workflow, next)
  assert.equal(pm.taskType('mine')?.settings.agentRules, 'Свежие правила')
  assert.equal(pm.taskType('mine')?.workflowNotes, undefined)
  saveWorkflowDraft(pm, 'mine', next, null)
  assert.deepEqual(pm.workflowGet('mine').workflow, defaultWorkflow(DEFAULT_ROLES))
  assert.equal(pm.taskType('mine')?.settings.agentRules, 'Свежие правила')
  assert.deepEqual(events, [])
})

test('patch workflowNotes снимает предупреждения поверх актуального типа', (t) => {
  const { pm } = fixture(t)
  const type = pm.taskType('mine')!
  pm.saveTaskType({ ...type, workflowNotes: [{ code: 'mergeRemoved', message: 'Старая миграция' }] })
  assert.equal(pm.taskType('mine')?.workflowNotes?.length, 1)
  pm.patchTaskType('mine', { workflowNotes: [] })
  assert.equal(pm.taskType('mine')?.workflowNotes, undefined)
})
