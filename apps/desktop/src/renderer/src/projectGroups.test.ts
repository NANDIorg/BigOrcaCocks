import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaApi, Project, ProjectGroup } from '../../shared/ipc'
import { buildSidebar, groupsApi, groupsFromList, groupTargets, isStaleGroupsError, normalizeGroupName, projectGroupId } from './projectGroups'

const project = (id: string, groupId?: string): Project => ({ id, root: `/r/${id}`, name: id, ...(groupId ? { groupId } : {}) })
const group = (id: string, collapsed?: boolean): ProjectGroup => ({ id, name: `Группа ${id}`, ...(collapsed ? { collapsed } : {}) })

test('без групп все проекты — без группы, порядок сохраняется', () => {
  const m = buildSidebar([project('a'), project('b')], [], {}, undefined)
  assert.deepEqual(m.groups, [])
  assert.deepEqual(m.ungrouped.map((p) => p.id), ['a', 'b'])
})

test('проекты раскладываются по группам, порядок групп и проектов — как пришёл', () => {
  const m = buildSidebar([project('a', 'g2'), project('b'), project('c', 'g1'), project('d', 'g2')], [group('g1'), group('g2')], {}, undefined)
  assert.deepEqual(m.groups.map((g) => [g.group.id, g.projects.map((p) => p.id)]), [['g1', ['c']], ['g2', ['a', 'd']]])
  assert.deepEqual(m.ungrouped.map((p) => p.id), ['b'])
})

test('id несуществующей группы читается как «без группы»', () => {
  const m = buildSidebar([project('a', 'gone')], [group('g1')], {}, undefined)
  assert.deepEqual(m.ungrouped.map((p) => p.id), ['a'])
  assert.equal(m.groups[0]!.projects.length, 0)
})

test('пустая группа остаётся в меню', () => {
  const m = buildSidebar([], [group('g1')], {}, undefined)
  assert.equal(m.groups.length, 1)
  assert.equal(m.groups[0]!.inProgress, 0)
})

test('сумма «в работе» по проектам группы; проекты без записи считаются нулём', () => {
  const m = buildSidebar([project('a', 'g1'), project('b', 'g1'), project('c', 'g1'), project('d')], [group('g1')], { a: 2, b: 3, d: 9 }, undefined)
  assert.equal(m.groups[0]!.inProgress, 5)
})

test('hasActive — только у группы с активным проектом', () => {
  const m = buildSidebar([project('a', 'g1'), project('b', 'g2'), project('c')], [group('g1'), group('g2')], {}, 'b')
  assert.deepEqual(m.groups.map((g) => g.hasActive), [false, true])
  assert.equal(buildSidebar([project('c')], [group('g1')], {}, 'c').groups[0]!.hasActive, false)
})

test('collapsed берётся из группы; не задан — развёрнута', () => {
  const m = buildSidebar([], [group('g1', true), group('g2')], {}, undefined)
  assert.deepEqual(m.groups.map((g) => g.collapsed), [true, false])
})

test('повторный id группы не дублирует её в меню', () => {
  const m = buildSidebar([project('a', 'g1')], [group('g1'), group('g1')], {}, undefined)
  assert.equal(m.groups.length, 1)
  assert.equal(m.groups[0]!.projects.length, 1)
})

test('normalizeGroupName: обрезает пробелы, пустое — undefined', () => {
  assert.equal(normalizeGroupName('  Бэкенд  '), 'Бэкенд')
  assert.equal(normalizeGroupName('   '), undefined)
  assert.equal(normalizeGroupName(''), undefined)
})

test('projectGroupId: неизвестная группа — undefined', () => {
  assert.equal(projectGroupId(project('a', 'g1'), [group('g1')]), 'g1')
  assert.equal(projectGroupId(project('a', 'gone'), [group('g1')]), undefined)
  assert.equal(projectGroupId(project('a'), [group('g1')]), undefined)
})

test('groupTargets: текущая группа отмечена, «без группы» — только проекту в группе', () => {
  const groups = [group('g1'), group('g2')]
  assert.deepEqual(groupTargets(project('a', 'g2'), groups).map((t) => [t.groupId, t.current]), [[null, false], ['g1', false], ['g2', true]])
  assert.deepEqual(groupTargets(project('a'), groups).map((t) => [t.groupId, t.current]), [['g1', false], ['g2', false]])
  assert.deepEqual(groupTargets(project('a', 'gone'), groups).map((t) => t.groupId), ['g1', 'g2'])
})

test('groupsFromList: старый main без groups — пустой список', () => {
  assert.deepEqual(groupsFromList({}), [])
  assert.deepEqual(groupsFromList({ groups: [group('g1')] }).map((g) => g.id), ['g1'])
})

test('groupsApi: старый preload без методов групп — ошибка «перезапустите приложение»', () => {
  const noop = (): Promise<never> => Promise.reject(new Error('x'))
  const full = { createGroup: noop, renameGroup: noop, removeGroup: noop, setGroupCollapsed: noop, setProjectGroup: noop }
  const api = (projects: object | undefined): Partial<OrcaApi> => ({ projects } as unknown as Partial<OrcaApi>)
  assert.equal(groupsApi(api(full)), full)
  assert.throws(() => groupsApi(api({ list: noop })), /main\/preload|Перезапустите|Restart/i)
  assert.throws(() => groupsApi(api({ ...full, removeGroup: undefined })), Error)
  assert.throws(() => groupsApi(undefined), Error)
})

test('isStaleGroupsError: узнаёт invoke без хендлера в старом main', () => {
  assert.equal(isStaleGroupsError("Error invoking remote method 'projects:createGroup': Error: No handler registered for 'projects:createGroup'"), true)
  assert.equal(isStaleGroupsError("No handler registered for 'projects:setProjectGroup'"), true)
  assert.equal(isStaleGroupsError("No handler registered for 'docs:list'"), false)
  assert.equal(isStaleGroupsError('OrcaError[projects.groupNotFound]: нет группы'), false)
})
