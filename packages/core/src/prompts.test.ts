// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { builtinPromptKind, promptChannel, workerTaskPrompt, resumeCoordinatorObjective, COORDINATOR_RESUME_SECTION } from './prompts.ts'
import { getAgent } from './agents.ts'
import { withRoleInstructions } from './types.ts'

describe('builtinPromptKind', () => {
  it('координаторская инструкция только у роли coordinator', () => {
    assert.equal(builtinPromptKind('coordinator'), 'coordinator')
    for (const id of ['developer', 'reviewer', 'qa', 'role_x', 'Coordinator']) assert.equal(builtinPromptKind(id), 'worker')
  })
})

describe('workerTaskPrompt', () => {
  it('название, описание и замечания ревью — тот же формат, что при старте воркера', () => {
    assert.equal(workerTaskPrompt({ title: 'T', spec: 'S' }), '# Задача: T\n\nS\n')
    assert.equal(workerTaskPrompt({ title: 'T', spec: '' }), '# Задача: T\n\n(описание не задано)\n')
    assert.equal(workerTaskPrompt({ title: 'T', spec: 'S', feedback: 'F' }), '# Задача: T\n\nS\n\n\n# Замечания после ревью\n\nF')
  })
})

describe('promptChannel', () => {
  it('выводится из invoke реестра', () => {
    assert.equal(promptChannel(getAgent('claude')), 'system')
    for (const id of ['codex', 'opencode', 'gemini', 'cursor', 'amp', 'copilot', 'goose']) assert.equal(promptChannel(getAgent(id)), 'combined')
    assert.equal(promptChannel(getAgent('shell')), 'none')
    assert.equal(promptChannel(undefined), 'none')
  })
})

describe('встроенная инструкция и дополнения роли', () => {
  it('встроенный текст входит в системный промпт ровно один раз, дополнения — после него', () => {
    const builtin = '# Роль: координатор\n\norca-board task create ...'
    const system = withRoleInstructions(builtin, { title: 'Координатор', systemPrompt: 'пиши кратко' })
    assert.equal(system.split(builtin).length - 1, 1)
    assert.ok(system.startsWith(builtin))
    assert.ok(system.endsWith('# Инструкции роли «Координатор»\n\nпиши кратко'))
  })
})

describe('повторный запуск координатора', () => {
  // Тот же файл, что main отдаёт как BUILTIN_PROMPTS.coordinator (apps/desktop/src/main/prompts.ts).
  const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')

  it('встроенный промпт содержит раздел-исключение: runs finish без ожидания run_done', () => {
    const start = skill.indexOf(`${COORDINATOR_RESUME_SECTION}:`)
    assert.ok(start >= 0, 'нет раздела «Повторный запуск»')
    const section = skill.slice(start)
    assert.match(section, /orca-board global tasks/)
    assert.match(section, /не жди `run_done`/)
    assert.match(section, /orca-board runs finish/)
    // Общий запрет «до run_done» оговаривает исключение, а не противоречит разделу.
    assert.match(skill, /Не вызывай её до `run_done` и до сводки — кроме повторного\s+запуска без новой работы/)
  })

  it('подзадач нет — цель без изменений', () => {
    assert.equal(resumeCoordinatorObjective('цель', []), 'цель')
  })

  it('подзадачи есть — список и ссылка на раздел инструкции', () => {
    const text = resumeCoordinatorObjective('цель', [
      { id: 't1', title: 'Сделать A', status: 'Done' },
      { id: 't2', title: 'Ревью: A', status: 'Done' }
    ])
    assert.ok(text.startsWith('цель\n'))
    assert.ok(text.includes('- t1 [Done] Сделать A'))
    assert.ok(text.includes('- t2 [Done] Ревью: A'))
    assert.ok(text.includes(`по разделу «${COORDINATOR_RESUME_SECTION}»`))
    assert.ok(text.includes('orca-board runs finish'))
    // Цель начинается строкой-маркером, которую раздел инструкции и распознаёт.
    assert.ok(text.split('\n').some((l) => l.startsWith(COORDINATOR_RESUME_SECTION)))
  })
})

describe('события после ответа человека в инструкции координатора', () => {
  const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')

  it('check подписан на question_answered и answer_accepted во всех вариантах', () => {
    const checks = skill.split('\n').filter((l) => l.includes('orca-board check'))
    assert.ok(checks.length >= 2)
    for (const l of checks) assert.match(l, /question_answered,answer_accepted,run_done/)
  })

  it('есть что делать по question_answered и answer_accepted', () => {
    assert.match(skill, /- `question_answered` →[\s\S]*workerLive: false[\s\S]*worker start/)
    assert.match(skill, /- `answer_accepted` →/)
  })
})
