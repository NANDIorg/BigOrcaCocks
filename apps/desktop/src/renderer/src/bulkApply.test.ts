import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, TEMPLATE_SECTIONS, type AgentInfo, type ProjectTemplate } from '@orca-board/core'
import type { Project } from '../../shared/ipc'
import {
  applicableIds, applyEach, bulkCandidates, bulkPreview, initialSelection, resultsText, taskRefsApi, usageHint, usageSummary
} from './bulkApply'
import { plural } from './plural'

const agent = (id: string): AgentInfo =>
  ({ id, title: id, installed: true, enabled: true, models: [], config: {} }) as unknown as AgentInfo
const agents = [agent('claude'), agent('codex')]
const qa = { id: 'qa', title: 'QA', color: '#fff', kind: 'custom' as const }
const tpl: ProjectTemplate = { id: 'tpl_1', title: 'Мой', settings: { permissionMode: 'acceptEdits', roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS } }
const same: Project = { id: 'same', root: '/same', name: 'same', templateId: 'tpl_1', permissionMode: 'acceptEdits' }
const lag: Project = { id: 'lag', root: '/lag', name: 'lag', templateId: 'tpl_1', permissionMode: 'auto', columns: [...DEFAULT_COLUMNS, qa] }
const other: Project = { id: 'other', root: '/other', name: 'other', templateId: 'general' }

test('bulkCandidates: проекты этого типа первыми, у каждого — разделы отличий', () => {
  const c = bulkCandidates([other, same, lag], tpl, agents)
  assert.deepEqual(c.map((x) => [x.project.id, x.own, x.differs]), [
    ['same', true, []],
    ['lag', true, ['columns', 'permissions']],
    ['other', false, ['permissions']]
  ])
  assert.deepEqual(usageSummary(c), { users: 2, differ: 1 })
})

test('usageHint: нет отстающих — пусто; часть или все отличаются', () => {
  assert.equal(usageHint({ users: 3, differ: 0 }), '')
  assert.equal(usageHint({ users: 3, differ: 1 }), 'Шаблон используют 3 проекта, у 1 настройки отличаются.')
  assert.equal(usageHint({ users: 1, differ: 1 }), 'Шаблон используют 1 проект, все отличаются от него.')
})

test('initialSelection: отмечены отстающие проекты этого типа и разделы их отличий; отличий нет — все разделы', () => {
  const c = bulkCandidates([other, same, lag], tpl, agents)
  assert.deepEqual(initialSelection(c), { projectIds: ['lag'], sections: ['columns', 'permissions'] })
  assert.deepEqual(initialSelection(bulkCandidates([same, other], tpl, agents)), { projectIds: [], sections: [...TEMPLATE_SECTIONS] })
})

test('bulkPreview: задачи из пропадающей колонки уходят в бэклог; без разделов — null; задачи неизвестны — без счётчиков', () => {
  const tasks = [{ status: 'qa', roleId: 'executor' }, { status: 'backlog', roleId: 'executor' }]
  const p = bulkPreview(lag, tpl, ['columns'], tasks)
  assert.deepEqual(p?.columnsGone, [{ id: 'qa', title: 'QA', tasks: 1 }])
  assert.equal(p?.backlogTasks, 1)
  assert.equal(p?.setsType, false)
  assert.equal(bulkPreview(lag, tpl, [], tasks), null)
  assert.equal(bulkPreview(lag, tpl, ['columns'], null)?.backlogTasks, 0)
  assert.equal(bulkPreview(lag, tpl, TEMPLATE_SECTIONS, [])?.setsType, true)
})

test('applicableIds: только отмеченные и без ошибки графа, в порядке кандидатов', () => {
  const c = bulkCandidates([other, same, lag], tpl, agents)
  const ok = bulkPreview(lag, tpl, ['columns'], [])
  const bad = ok && { ...ok, error: 'граф сломается' }
  const previews = new Map([['same', ok], ['lag', ok], ['other', bad]])
  assert.deepEqual(applicableIds(c, new Set(['other', 'lag', 'same']), previews), ['same', 'lag'])
  assert.deepEqual(applicableIds(c, new Set(['lag']), new Map([['lag', null]])), [])
})

test('applyEach: по очереди, ошибка одного не останавливает остальные; прогресс после каждого', async () => {
  const order: string[] = []
  const progress: number[] = []
  const results = await applyEach(
    ['a', 'b', 'c'],
    async (id) => {
      order.push(id)
      if (id === 'b') throw new Error('граф')
    },
    (e) => (e instanceof Error ? e.message : String(e)),
    (r) => progress.push(Object.keys(r).length)
  )
  assert.deepEqual(order, ['a', 'b', 'c'])
  assert.deepEqual(results, { a: null, b: 'граф', c: null })
  assert.deepEqual(progress, [1, 2, 3])
  assert.equal(resultsText(results), 'Применено к 2 проектам, не удалось — 1: ошибки у проектов в списке.')
  assert.equal(resultsText({ a: null }), 'Применено к 1 проекту.')
})

test('taskRefsApi: старый preload без taskRefs — null', () => {
  assert.equal(taskRefsApi(undefined), null)
  assert.equal(taskRefsApi({ projects: {} } as never), null)
  const taskRefs = (): Promise<never[]> => Promise.resolve([])
  assert.equal(taskRefsApi({ projects: { taskRefs } } as never), taskRefs)
})

test('plural', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22].map((n) => plural(n, 'проект', 'проекта', 'проектов')),
    ['проект', 'проекта', 'проектов', 'проектов', 'проект', 'проекта'])
})
