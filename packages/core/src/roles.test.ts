// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_ROLES, defaultRoleDescription, withDefaultDescriptions, withRoleInstructions } from './types.ts'
import { getAgent } from './agents.ts'

const SYSTEM = '# Роль: воркер\n\norca-board done --summary ...'
const opts = { permissionMode: 'auto', shell: '/bin/sh', model: 'opus', effort: 'high' }

describe('withRoleInstructions', () => {
  it('нет роли, нет поля или только пробелы — служебная инструкция без изменений', () => {
    assert.equal(withRoleInstructions(SYSTEM, undefined), SYSTEM)
    assert.equal(withRoleInstructions(SYSTEM, { title: 'QA' }), SYSTEM)
    assert.equal(withRoleInstructions(SYSTEM, { title: 'QA', systemPrompt: ' \n\t ' }), SYSTEM)
  })

  it('блок роли дописывается после служебной инструкции; переносы и кавычки сохраняются', () => {
    const own = `Пиши тесты.\n"двойные" и 'одинарные' кавычки, $HOME, \`cmd\`, $(rm -rf /)\n\nвторой абзац`
    const out = withRoleInstructions(SYSTEM, { title: 'QA', systemPrompt: `\n${own}\n\n` })
    assert.ok(out.startsWith(SYSTEM), 'служебная инструкция на месте')
    assert.equal(out, `${SYSTEM}\n\n# Инструкции роли «QA»\n\n${own}`)
  })

  it('claude: инструкции роли — в --append-system-prompt одним аргументом, модель и effort не теряются', () => {
    const system = withRoleInstructions(SYSTEM, { title: 'Ревьюер', systemPrompt: 'строка 1\n"строка 2"' })
    const { args } = getAgent('claude')!.invoke(system, 'задание', opts)
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], system)
    assert.equal(args[args.indexOf('--model') + 1], 'opus')
    assert.equal(args[args.indexOf('--effort') + 1], 'high')
    assert.equal(args.at(-1), 'задание')
  })

  it('агенты без system prompt: блок роли в склейке перед заданием', () => {
    const system = withRoleInstructions(SYSTEM, { title: 'QA', systemPrompt: 'только QA' })
    const { args } = getAgent('codex')!.invoke(system, 'задание', opts)
    assert.equal(args.at(-1), `${system}\n\n---\n\nзадание`)
  })
})

describe('назначение роли', () => {
  it('у каждой роли по умолчанию есть назначение для координатора', () => {
    for (const r of DEFAULT_ROLES) assert.ok(r.description?.trim(), `у роли ${r.id} нет description`)
  })

  it('системные роли без назначения получают назначение по умолчанию, остальные не меняются', () => {
    const roles = withDefaultDescriptions([
      { id: 'developer', title: 'Программист', agent: 'claude' },
      { id: 'qa', title: 'QA', agent: 'claude', description: '  ' },
      { id: 'reviewer', title: 'Ревьюер', agent: 'claude', description: 'своё' },
      { id: 'ops', title: 'Ops', agent: 'claude' }
    ])
    assert.equal(roles[0].description, defaultRoleDescription('developer'))
    assert.equal(roles[1].description, defaultRoleDescription('qa'))
    assert.equal(roles[2].description, 'своё')
    assert.equal('description' in roles[3], false)
  })

  it('инструкция координатора велит выбирать роль по description из roles list', () => {
    const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
    assert.match(skill, /`orca-board roles list` —[^\n]*назначение \(`description`\)/)
    assert.match(skill, /Роль подбирай по `description` из `roles list`/)
  })
})
