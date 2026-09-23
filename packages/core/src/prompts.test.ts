// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { builtinPromptKind, assistantRole, isTaskRole, promptChannel, workerTaskPrompt, resumeCoordinatorObjective, COORDINATOR_RESUME_SECTION } from './prompts.ts'
import { getAgent } from './agents.ts'
import { withRoleInstructions, withAgentRules } from './types.ts'

describe('builtinPromptKind', () => {
  it('координаторская инструкция только у роли coordinator', () => {
    assert.equal(builtinPromptKind('coordinator'), 'coordinator')
    for (const id of ['developer', 'reviewer', 'qa', 'role_x', 'Coordinator', 'Assistant']) assert.equal(builtinPromptKind(id), 'worker')
  })
  it('инструкция ассистента — у роли assistant', () => {
    assert.equal(builtinPromptKind('assistant'), 'assistant')
  })
})

describe('служебные роли', () => {
  it('coordinator и assistant задачам не назначаются', () => {
    assert.equal(isTaskRole('coordinator'), false)
    assert.equal(isTaskRole('assistant'), false)
    for (const id of ['developer', 'reviewer', 'qa', 'role_x']) assert.equal(isTaskRole(id), true)
  })
})

describe('assistantRole', () => {
  const coordinator = { id: 'coordinator', title: 'К', agent: 'codex' as const, model: 'm', effort: 'high', systemPrompt: 'только координатору' }
  it('своя роль assistant — как есть', () => {
    const own = { id: 'assistant', title: 'А', agent: 'gemini' as const, systemPrompt: 'p' }
    assert.equal(assistantRole([coordinator, own]), own)
  })
  it('старый проект без assistant — агент, модель и effort координатора, без его инструкций', () => {
    assert.deepEqual(assistantRole([coordinator]), { id: 'assistant', title: 'Ассистент', agent: 'codex', model: 'm', effort: 'high' })
  })
  it('нет ни assistant, ни coordinator — undefined (claude по умолчанию)', () => {
    assert.equal(assistantRole([{ id: 'developer', title: 'D', agent: 'claude' }]), undefined)
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

describe('правила проекта для агентов доски (withAgentRules)', () => {
  const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')
  const coordinator = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
  const rules = 'Не создавать задачи, не писать комментарии и отчёты в ORION.'

  it('без правил и без инструкций роли — служебная инструкция без изменений', () => {
    for (const builtin of [worker, coordinator]) {
      assert.equal(withAgentRules(builtin, undefined, undefined), builtin)
      assert.equal(withAgentRules(builtin, ' \n\t ', { title: 'Р' }), builtin)
    }
  })

  it('воркер и координатор: блок «# Правила проекта» после служебной инструкции, текст как есть (trim по краям)', () => {
    for (const builtin of [worker, coordinator]) {
      const out = withAgentRules(builtin, `\n${rules}\n\n`, { title: 'Р' })
      assert.equal(out, `${builtin}\n\n# Правила проекта\n\n${rules}`)
      assert.equal(out.split('# Правила проекта').length - 1, 1)
    }
  })

  it('порядок: служебная инструкция, правила проекта, затем инструкции роли', () => {
    const out = withAgentRules(coordinator, rules, { title: 'Координатор', systemPrompt: 'пиши кратко' })
    assert.equal(out, `${coordinator}\n\n# Правила проекта\n\n${rules}\n\n# Инструкции роли «Координатор»\n\nпиши кратко`)
  })

  it('без общих правил — как withRoleInstructions (поведение роли не меняется)', () => {
    const role = { title: 'QA', systemPrompt: 'только QA' }
    assert.equal(withAgentRules(worker, '', role), withRoleInstructions(worker, role))
  })

  it('claude: правила — внутри --append-system-prompt; остальные агенты — в склейке перед заданием', () => {
    const system = withAgentRules(worker, rules, undefined)
    const opts = { permissionMode: 'auto', shell: '/bin/sh' }
    const claude = getAgent('claude')!.invoke(system, 'задание', opts).args
    assert.equal(claude[claude.indexOf('--append-system-prompt') + 1], system)
    assert.ok(!claude.at(-1)!.includes('# Правила проекта'), 'правила не в задании')
    assert.equal(getAgent('codex')!.invoke(system, 'задание', opts).args.at(-1), `${system}\n\n---\n\nзадание`)
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

  it('check подписан на question_answered, answer_accepted и события запросов к человеку во всех вариантах', () => {
    const checks = skill.split('\n').filter((l) => l.includes('orca-board check'))
    assert.ok(checks.length >= 2)
    for (const l of checks) assert.match(l, /question_answered,answer_accepted,run_done,request_created,request_resolved,answer_clarified/)
  })

  it('есть что делать по question_answered и answer_accepted', () => {
    assert.match(skill, /- `question_answered` →[\s\S]*workerLive: false[\s\S]*worker start/)
    assert.match(skill, /- `answer_accepted` →[\s\S]*`decision`/)
  })

  it('есть что делать по событиям запросов к человеку', () => {
    assert.match(skill, /question forward --question <id> --note/)
    assert.match(skill, /- `answer_clarified` →[\s\S]*Не вызывай `worker start`/)
    assert.match(skill, /- `request_created` →[\s\S]*request get --request <requestId>/)
    assert.match(skill, /- `request_resolved` →[\s\S]*restart[\s\S]*dismiss/)
    assert.match(skill, /startFailed: true/)
    assert.match(skill, /orca-board request list/)
  })

  it('воркер спрашивает с вариантами и переподключается после таймаута', () => {
    const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')
    assert.match(worker, /orca-board ask --question "\.\.\." --option "метка\|пояснение"/)
    assert.match(worker, /--recommend/)
    assert.match(worker, /--context-file/)
    assert.match(worker, /повтори ту же команду/)
    assert.match(worker, /orca-board request get --request/)
    assert.doesNotMatch(worker, /--options a,b/)
  })

  it('координатор берёт роли только из roles list', () => {
    assert.match(skill, /`--role` — только id из `roles list`/)
  })

  it('воркер после done не берёт работу из терминала, а отправляет в приложение', () => {
    const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')
    assert.match(worker, /После `orca-board done` новую работу не бери[\s\S]*Решение \/ что делать дальше/)
  })
})

describe('команды в инструкциях и документации совпадают с CLI', () => {
  const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
  const help = read('packages/cli/bin/orca-board.js')
  const helpText = help.slice(help.indexOf('const HELP = `'), help.indexOf('`', help.indexOf('const HELP = `') + 14))
  // Команды из справки: «  <слово> [<слово>]» в начале строки; done и ask — однословные.
  const commands = new Set(
    [...helpText.matchAll(/^ {2}([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/gm)].map((m) => (m[1] === 'done' || m[1] === 'ask' ? m[1] : `${m[1]} ${m[2] ?? ''}`.trim()))
  )
  const flags = new Set([...helpText.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]))

  for (const file of ['skills/coordinator.md', 'skills/worker.md', 'skills/assistant.md', 'docs/human-requests.md', 'docs/architecture.md', 'docs/nested-kanban.md', 'docs/workflow.md']) {
    it(file, () => {
      const text = read(file)
      const uses = [...text.matchAll(/orca-board ([a-z][a-z-]*(?: [a-z][a-z-]*)?)([^`\n]*)/g)]
      assert.ok(uses.length > 0)
      for (const [, cmd, rest] of uses) {
        const name = cmd.startsWith('done') || cmd.startsWith('ask') ? cmd.split(' ')[0] : cmd
        assert.ok(commands.has(name), `${file}: нет команды «orca-board ${name}» в справке CLI`)
        // Флаги внутри значений в кавычках (спека задачи ревью с git-командами) — не флаги orca-board.
        for (const [, flag] of rest.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/--([a-z][a-z-]*)/g)) {
          assert.ok(flags.has(flag), `${file}: флага --${flag} (orca-board ${name}) нет в справке CLI`)
        }
      }
    })
  }
})

describe('skill ассистента: все проекты пользователя', () => {
  const text = readFileSync(new URL('../../../skills/assistant.md', import.meta.url), 'utf8')
  it('начинает с projects list и выбирает проект через --project', () => {
    assert.match(text, /orca-board projects list/)
    assert.match(text, /orca-board columns list --project <id>/)
    assert.match(text, /orca-board roles list --project <id>/)
    assert.match(text, /active: true/)
  })
  it('нет запрета --project и привязки к ORCA_PROJECT', () => {
    assert.doesNotMatch(text, /--project` не указывай/)
    assert.doesNotMatch(text, /ORCA_PROJECT/)
  })
})

describe('воркфлоу в инструкциях: ревью и мерж ведёт приложение', () => {
  const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')

  it('координатор смотрит воркфлоу в «Подготовке» и не создаёт ревью сам', () => {
    const prep = skill.slice(skill.indexOf('Подготовка:'), skill.indexOf('Цикл:'))
    assert.match(prep, /orca-board workflow show/)
    assert.match(prep, /задачи ревью не\s+создавай/)
    assert.doesNotMatch(skill, /task create --title "Ревью/, 'ручного создания задачи ревью больше нет')
    assert.doesNotMatch(skill, /pnpm/, 'skills — без специфики этого репозитория')
  })

  it('workflow_blocked — во всех вариантах check и с обработкой в шаге 4', () => {
    const types = [...skill.matchAll(/(?:--types|Типы:) `?([a-z_,]+)/g)].map((m) => m[1])
    assert.equal(types.length, 3, 'общий список, Monitor и запасной путь')
    for (const t of types) assert.ok(t.split(',').includes('workflow_blocked'), t)
    assert.doesNotMatch(skill, /`stage_changed`/, 'stage_changed — событие для UI, координатору не нужно')
    assert.match(skill, /- `workflow_blocked` →[\s\S]*`reason`[\s\S]*worker start --task <id>[\s\S]*task reopen --task <id> --start/)
  })

  it('worker_done рабочей задачи и проверки — ничего не делать', () => {
    assert.match(skill, /- `worker_done` по \*\*рабочей\*\* задаче → \*\*ничего не делай\*\*/)
    assert.match(skill, /- `worker_done` с полем `gateFor`[\s\S]*ничего не делай/)
    assert.match(skill, /`approval`/)
  })

  it('воркер: мержит приложение, проверка решает review accept/reject и сдаёт done', () => {
    assert.match(worker, /ветку сливает приложение/)
    assert.doesNotMatch(worker, /это делает координатор/)
    assert.match(worker, /Задача-проверка[\s\S]*orca-board review accept --task <id>[\s\S]*orca-board review reject --task <id> --feedback[\s\S]*orca-board done/)
  })
})
