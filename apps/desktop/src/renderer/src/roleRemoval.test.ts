import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ROLES, type Role } from '@orca-board/core'
import { isSystemRole, missingSystemRoles, removalConsequences, removeBlocker, restoreSystemRoles } from './roleRemoval'

const ids = (roles: readonly Role[]): string[] => roles.map((r) => r.id)
const custom: Role = { id: 'role_x', title: 'Аналитик', agent: 'codex' }

test('системные роли — все из DEFAULT_ROLES, пользовательская — нет', () => {
  for (const r of DEFAULT_ROLES) assert.equal(isSystemRole(r.id), true, r.id)
  assert.equal(isSystemRole(custom.id), false)
})

test('удалить можно любую роль, кроме последней', () => {
  assert.equal(removeBlocker(DEFAULT_ROLES), undefined)
  assert.equal(removeBlocker([custom]), 'Нельзя удалить последнюю роль')
})

test('у каждой системной роли есть последствия удаления и подсказка про возврат', () => {
  for (const r of DEFAULT_ROLES) {
    const lines = removalConsequences(r.id)
    assert.ok(lines.length >= 2, r.id)
    assert.ok(lines.some((l) => l.includes('Вернуть системные роли')), r.id)
  }
  assert.match(removalConsequences('coordinator').join('\n'), /запустить прогон/)
  assert.match(removalConsequences('reviewer').join('\n'), /задачи ревью/)
})

test('пользовательская роль: без задач подтверждать нечего, с задачами — предупреждение', () => {
  assert.deepEqual(removalConsequences(custom.id), [])
  assert.deepEqual(removalConsequences(custom.id, 0), [])
  assert.deepEqual(removalConsequences(custom.id, 3), ['Задачи на этой роли (3) не запустятся, пока роль не вернут.'])
})

test('недостающие системные роли — копии дефолта', () => {
  const roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer' && r.id !== 'coordinator')
  const missing = missingSystemRoles(roles)
  assert.deepEqual(ids(missing), ['coordinator', 'reviewer'])
  missing[0].title = 'изменено'
  assert.equal(DEFAULT_ROLES[0].title, 'Координатор')
  assert.deepEqual(missingSystemRoles(DEFAULT_ROLES), [])
})

test('возврат ставит роли на место из дефолта и не трогает остальные', () => {
  const edited: Role = { ...DEFAULT_ROLES.find((r) => r.id === 'developer')!, model: 'opus' }
  const roles = [edited, custom, DEFAULT_ROLES.find((r) => r.id === 'qa')!]
  const next = restoreSystemRoles(roles)
  assert.deepEqual(ids(next), ['coordinator', 'assistant', 'developer', 'role_x', 'reviewer', 'qa'])
  assert.equal(next[2], edited)
  assert.deepEqual(ids(roles), ['developer', 'role_x', 'qa'])
})

test('без оставшихся системных ролей возвращённые встают в конец в порядке дефолта', () => {
  assert.deepEqual(ids(restoreSystemRoles([custom])), ['role_x', ...ids(DEFAULT_ROLES)])
  assert.deepEqual(ids(restoreSystemRoles(DEFAULT_ROLES)), ids(DEFAULT_ROLES))
})
