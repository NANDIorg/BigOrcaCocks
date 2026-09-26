// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  builtinPromptKind, assistantRole, isTaskRole, promptChannel, workerTaskPrompt, resumeCoordinatorObjective, COORDINATOR_RESUME_SECTION,
  COORDINATOR_RETURN_HEADING, COORDINATOR_STAGE_HEADING, runGateTaskSpec, runGateTaskTitle, runAskTaskSpec, runAskTaskTitle, runDecisionTaskSpec, runDecisionTaskTitle, type CoordinatorStage
} from './prompts.ts'
import { getAgent } from './agents.ts'
import { returnImagesSection } from './attachments.ts'
import { withRoleInstructions, withAgentRules, agentSystemPrompt, agentLanguageDirective, AGENT_LANGUAGE_HEADING } from './types.ts'

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

  it('этап без инструкции и показа — промпт как без этапа', () => {
    assert.equal(workerTaskPrompt({ title: 'T', spec: 'S' }, undefined, [], { nodeId: 'work', type: 'work', title: 'Работа' }), '# Задача: T\n\nS\n')
  })

  it('раздел «Этап»: инструкция и обязательный показ с флагами done, до замечаний ревью', () => {
    const text = workerTaskPrompt({ title: 'T', spec: 'S', feedback: 'F' }, undefined, [], {
      nodeId: 'design', title: 'Дизайн', instructions: 'Сделай макеты.', showcase: { what: '2–3 варианта: HTML и скриншоты', required: true }
    })
    assert.match(text, /# Этап: Дизайн\n\nСделай макеты\./)
    assert.match(text, /## Результат для показа человеку \(обязательно\)\n\n2–3 варианта: HTML и скриншоты/)
    assert.match(text, /orca-board done --summary "\.\.\." --show-file <описание\.md> --show <путь>/)
    assert.match(text, /Без показа done не пройдёт\./)
    assert.ok(text.indexOf('# Этап:') < text.indexOf('# Замечания после ревью'))
  })

  it('необязательный показ — без «(обязательно)»; у задачи-ответа этапа нет', () => {
    const stage = { nodeId: 'w', title: 'Работа', showcase: { what: 'скриншот' } }
    const text = workerTaskPrompt({ title: 'T', spec: 'S' }, undefined, [], stage)
    assert.match(text, /## Результат для показа человеку\n/)
    assert.doesNotMatch(text, /не пройдёт/)
    assert.doesNotMatch(workerTaskPrompt({ title: 'T', spec: 'S', answerFor: 'human' }, undefined, [], stage), /# Этап:/)
  })
})

describe('workerTaskPrompt: этап «Вопрос человеку»', () => {
  const ask = { nodeId: 'ask', type: 'ask' as const, title: 'Уточнить', instructions: 'Выясни, какую БД брать.' }

  it('раздел «Этап»: инструкция ноды, цель — спросить, код не менять, done после ответов', () => {
    const text = workerTaskPrompt({ title: 'T', spec: 'S' }, undefined, [], ask)
    assert.match(text, /# Этап: Уточнить\n\nВыясни, какую БД брать\./)
    assert.match(text, /задать вопрос\(ы\) человеку\. Код не меняй/)
    assert.match(text, /orca-board ask --question "\.\.\."/)
    assert.match(text, /отвечает человек, а не координатор/)
    assert.match(text, /orca-board done --summary "что выяснил"/)
    assert.doesNotMatch(text, /уже получены/, 'ответов нет — пометки нет')
  })

  it('раздел есть и без инструкции (у «Работы» без инструкции его нет)', () => {
    const text = workerTaskPrompt({ title: 'T', spec: 'S' }, undefined, [], { nodeId: 'ask', type: 'ask', title: 'Вопрос человеку' })
    assert.match(text, /# Этап: Вопрос человеку\n\nТвоя цель на этом этапе/)
  })

  it('повторный заход: ответы под нейтральным заголовком и пометка «уже получены»', () => {
    const text = workerTaskPrompt({ title: 'T', spec: 'S' }, undefined, [{ question: 'Какую БД?', answer: 'sqlite' }, { question: 'Ещё?' }], ask)
    assert.match(text, /# Ответы на вопросы по задаче\n\n- Какую БД\?\n {2}Ответ: sqlite/)
    assert.doesNotMatch(text, /Ещё\?/, 'вопрос без ответа в промпт не попадает')
    assert.match(text, /Ответы выше уже получены[\s\S]*спрашивай только новое/)
    assert.ok(text.indexOf('# Ответы на вопросы по задаче') < text.indexOf('# Этап:'))
  })

  it('следующая «Работа» получает ответы человека автоматически, без пометки про повтор', () => {
    const text = workerTaskPrompt({ title: 'T', spec: 'S' }, undefined, [{ question: 'Какую БД?', answer: 'sqlite' }], { nodeId: 'work', type: 'work', title: 'Работа', instructions: 'Реализуй.' })
    assert.match(text, /# Ответы на вопросы по задаче/)
    assert.doesNotMatch(text, /Ответы на твои вопросы|уже получены/)
  })

  it('у задачи-ответа этапа ask нет', () => {
    assert.doesNotMatch(workerTaskPrompt({ title: 'T', spec: 'S', answerFor: 'human' }, undefined, [], ask), /# Этап:/)
  })

  it('skills/worker.md описывает этап: только ask, код не менять, done после ответов, отвечает человек', () => {
    const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')
    assert.match(worker, /целью\s+задать\s+вопросы\s+человеку:\s+код\s+не\s+меняй[\s\S]*orca-board ask[\s\S]*отвечает\s+человек,\s+а\s+не\s+координатор[\s\S]*orca-board done --summary "что выяснил"/)
    assert.match(worker, /на\s+этапе\s+«Вопрос\s+человеку»\s+—\s+всегда\s+человек/)
    assert.match(worker, /раздел\s+«Ответы\s+на\s+вопросы\s+по\s+задаче»/)
  })

  it('skills/coordinator.md: этап git выполняет приложение, поле git и исход error названы', () => {
    const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
    assert.match(skill, /`git` — приложение само выполняет git-операцию из поля `git`/)
    assert.match(skill, /исход `error`/)
  })

  it('skills/coordinator.md: этап ask, вопросы с него не обрабатываются, воркера перезапускает приложение', () => {
    const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
    assert.match(skill, /`ask` — агент спрашивает человека/)
    assert.match(skill, /- `question_answered` →[\s\S]*этапе\s+`ask`[\s\S]*`worker start` не нужен/)
    assert.match(skill, /- `request_created` →[\s\S]*`question`\s+с этапа `ask`[\s\S]*обрабатывать не нужно/)
  })

  it('skills/coordinator.md: ветка глобальной задачи — координатор в её worktree и не ведёт её сам', () => {
    const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
    assert.match(skill, /worktree\s+\*\*ветки\s+своей\s+глобальной\s+задачи\*\*[\s\S]*`orca-board global get`[\s\S]*`git\.branch`/)
    assert.match(skill, /Не\s+переключай\s+ветку,\s+не\s+коммить\s+и\s+не\s+мержи\s+сам/)
    assert.match(skill, /слиты\s+в\s+ветку\s+глобальной\s+задачи/)
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

  it('раздел «Повторный запуск»: вход по «# Этап», сверка с global tasks, дублей нет; прогоны старого формата — отдельно', () => {
    const start = skill.indexOf(`${COORDINATOR_RESUME_SECTION}:`)
    assert.ok(start >= 0, 'нет раздела «Повторный запуск»')
    const section = skill.slice(start, skill.indexOf('Прогоны старого формата'))
    assert.ok(section.includes(`«${COORDINATOR_STAGE_HEADING} …»`), 'вход по блоку цели')
    assert.match(section, /orca-board workflow show/)
    assert.match(section, /orca-board global tasks/)
    assert.match(section, /не создавай\s+повторно/)
    assert.match(section, /`stage_tasks_done` мог уже прийти прежнему координатору[\s\S]*orca-board stage finish --summary/)
    assert.doesNotMatch(section, /orca-board runs finish/, 'в новом воркфлоу runs finish не нужен')
  })

  it('прогон старого формата: не жди run_done в повторном запуске, runs finish — только после run_done', () => {
    const legacy = skill.slice(skill.indexOf('Прогоны старого формата'))
    assert.match(legacy, /`scope: task`/)
    assert.match(legacy, /`stage_started` и `stage_tasks_done` тебе не приходят/)
    assert.match(legacy, /`run_done` не придёт: сразу `orca-board runs finish --summary "\.\.\."`/)
    assert.match(legacy, /Не вызывай `runs finish` до `run_done` и до\s+сводки — кроме повторного запуска без новой работы/)
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

  it('уточнение после проверки — в цели даже без подзадач, последнее полностью, прошлые списком', () => {
    const only = resumeCoordinatorObjective('цель', [], [{ text: 'добавь тесты\nи доку' }])
    assert.ok(only.startsWith('цель\n'))
    assert.ok(only.split('\n').some((l) => l.startsWith(COORDINATOR_RETURN_HEADING)))
    assert.ok(only.includes('добавь тесты\nи доку'))
    assert.ok(only.includes(`по разделу «${COORDINATOR_RESUME_SECTION}»`))
    const many = resumeCoordinatorObjective('цель', [{ id: 't1', title: 'A', status: 'Done' }], [{ text: 'первое' }, { text: 'второе' }])
    assert.ok(many.includes('- первое'), 'прошлое уточнение — списком')
    assert.ok(many.indexOf('второе') < many.indexOf('- t1 [Done] A'), 'последнее уточнение — до списка подзадач')
    assert.ok(many.includes('Уточнение — новая работа'))
  })

  it('уточнение после проверки — новая работа (прогон старого формата), сводка уходит человеку на проверку', () => {
    const legacy = skill.slice(skill.indexOf('Прогоны старого формата'))
    assert.ok(legacy.includes(`«${COORDINATOR_RETURN_HEADING}»`), 'маркер цели из resumeCoordinatorObjective')
    assert.match(legacy, /новая\s+работа/)
    assert.match(legacy, /отправляет глобальную задачу человеку на проверку/)
    assert.match(legacy, /заменяет прежнюю/)
    assert.match(legacy, /--summary-file/)
  })

  it('run_done нового прогона = граф дошёл до end: выйти без сводки и runs finish', () => {
    const item = skill.slice(skill.indexOf('- `run_done` (в payload'), skill.indexOf('Что сейчас ждёт человека'))
    assert.match(item, /граф дошёл до `end`/)
    assert.match(item, /`runs finish` не вызывай/)
    assert.match(item, /`"manual": true`/)
  })

  it('итоговая сводка старого прогона уходит в runs finish --summary; в цели — тоже', () => {
    assert.ok(resumeCoordinatorObjective('цель', [{ id: 't1', title: 'A', status: 'Done' }]).includes('orca-board runs finish --summary'))
    assert.ok(resumeCoordinatorObjective('цель', [{ id: 't1', title: 'A', status: 'Done' }], [{ text: 'x' }]).includes('orca-board runs finish --summary'))
  })
})

describe('координатор — диспетчер этапов «Работа»', () => {
  const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
  const step4 = skill.slice(skill.indexOf('4. По событию:'), skill.indexOf('Повторный запуск:'))

  it('вводная: граф ведёт приложение, координатор набирает агентов и ничего не решает о переходах', () => {
    const intro = skill.slice(0, skill.indexOf('Подготовка:'))
    assert.match(intro, /Ты\s+\*\*диспетчер\*\*/)
    assert.match(intro, /не\s+решаешь,\s+куда идти дальше по графу/)
    assert.match(intro, /`stage_started`/)
    assert.match(intro, /`stage_tasks_done`[\s\S]*`stage finish`/)
    assert.match(intro, /На этих этапах \*\*просто жди\*\*/)
    assert.match(intro, /Подзадача идёт \*\*своим путём\*\*/)
  })

  it('stage_started и stage_tasks_done — во всех трёх списках типов, после workflow_blocked', () => {
    const types = [...skill.matchAll(/(?:--types|Типы:) `?([a-z_,]+)/g)].map((m) => m[1])
    assert.equal(types.length, 3)
    for (const t of types) assert.ok(t.endsWith('workflow_blocked,stage_started,stage_tasks_done'), t)
  })

  it('stage_started: роли этапа (пусто — любые рабочие), feedback/decision/answers, полный текст в workflow show', () => {
    const item = step4.slice(step4.indexOf('- `stage_started` →'), step4.indexOf('- `stage_tasks_done` →'))
    assert.match(item, /создай подзадачи и запусти воркеров/)
    const step2 = skill.slice(skill.indexOf('2. По `stage_started`'), skill.indexOf('3. Жди события'))
    assert.match(step2, /`roleIds` не пуст[\s\S]*только с этими ролями[\s\S]*одна роль — `--role`\s+можно опустить/)
    assert.match(step2, /`roleIds` пуст[\s\S]*выбери роль сам из включённых\s+рабочих ролей типа/)
    assert.match(step2, /`feedback`[\s\S]*`decision`[\s\S]*`answers`/)
    assert.match(step2, /полные — `stage` в `orca-board workflow show`/)
    assert.match(skill, /`task create` вне этапа «Работа» вернёт ошибку\s+«дождись stage_started»/)
  })

  it('stage_tasks_done: нужно ещё — создать, иначе stage finish --summary как сигнал, а не отчёт', () => {
    const item = step4.slice(step4.indexOf('- `stage_tasks_done` →'), step4.indexOf('- `worker_done` по **задаче-ответу**'))
    assert.match(item, /этап ещё открыт/)
    assert.match(item, /orca-board stage finish --summary "\.\.\."/)
    assert.match(item, /сигнал «набор агентов закончен», а не отчёт/)
    assert.match(item, /--summary-file/)
  })

  it('workflow_blocked может быть без taskId: блок уровня глобальной задачи чинит человек', () => {
    const item = step4.slice(step4.indexOf('- `workflow_blocked` →'), step4.indexOf('- `question` →'))
    assert.match(item, /Поле `taskId` необязательно/)
    assert.match(item, /`runId`, `nodeId`/)
    assert.match(item, /решает человек в приложении/)
  })

  it('worker_done рабочей задачи — автомерж в ветку глобальной задачи, ничего не делать', () => {
    assert.match(step4, /- `worker_done` по \*\*рабочей\*\* задаче → \*\*ничего не делай\*\*[\s\S]*слияние её ветки в ветку глобальной\s+задачи/)
  })

  it('подзадача на своём пути: ожидание проверки или человека — не повод для stage finish, жди stage_tasks_done', () => {
    const intro = skill.slice(0, skill.indexOf('Подготовка:'))
    assert.match(intro, /может какое-то время ждать проверки или человека \*\*внутри\s+этапа\*\*[\s\S]*не повод для `stage finish`, жди `stage_tasks_done`/)
    assert.match(intro, /Путь ведёт приложение, а не ты/)
    const done = step4.slice(step4.indexOf('- `worker_done` по **рабочей** задаче'), step4.indexOf('- `worker_done` с полем `gateFor`'))
    assert.match(done, /\*\*ничего не делай\*\*[\s\S]*подзадачу ведёт её путь в приложении/)
    assert.match(done, /`stage finish` не вызывай[\s\S]*`stage_tasks_done`/)
    const blocked = step4.slice(step4.indexOf('- `workflow_blocked` →'), step4.indexOf('- `question` →'))
    assert.match(blocked, /С `taskId` — блок на пути подзадачи[\s\S]*путь ведёт приложение, ты его не двигаешь[\s\S]*решает человек/)
  })

  it('в skills нет команд и флагов, которых нет в HELP, из-за пути подзадачи (subflow — только модель)', () => {
    assert.doesNotMatch(skill, /subflow/)
  })

  it('нет ручного `runs finish` в цикле нового прогона', () => {
    const modern = skill.slice(0, skill.indexOf('Прогоны старого формата'))
    assert.doesNotMatch(modern, /orca-board runs finish/)
  })
})

describe('цель координатора на этапе (блок «# Этап»)', () => {
  const stage: CoordinatorStage = { title: 'Реализация', visit: 2, tasks: ['t2'] }
  const subtasks = [
    { id: 't1', title: 'Анализ', status: 'Done' },
    { id: 't2', title: 'Сделать A', status: 'In progress' }
  ]

  it('без stage — как раньше', () => {
    assert.equal(resumeCoordinatorObjective('цель', [], [], undefined), 'цель')
  })

  it('заголовок блока — та же строка, что в инструкции, и ссылка на раздел «Повторный запуск»', () => {
    const text = resumeCoordinatorObjective('цель', subtasks, [], stage)
    assert.ok(text.startsWith('цель\n'))
    assert.ok(text.split('\n').some((l) => l === `${COORDINATOR_STAGE_HEADING} Реализация`))
    assert.ok(text.includes(`по разделу «${COORDINATOR_RESUME_SECTION}» инструкции`))
    assert.ok(text.includes('заход 2'))
    const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
    assert.ok(skill.includes(`«${COORDINATOR_STAGE_HEADING}`), 'инструкция называет тот же блок')
  })

  it('роли этапа: список — «только с ними»; пусто — выбирает сам по roles list', () => {
    assert.match(resumeCoordinatorObjective('ц', [], [], { ...stage, roleIds: ['developer', 'qa'] }), /Роли этапа: developer, qa — подзадачи создавай только с ними/)
    const any = resumeCoordinatorObjective('ц', [], [], stage)
    assert.match(any, /Роли этапа не заданы[\s\S]*`orca-board roles list`/)
    assert.doesNotMatch(any, /Роли этапа:/)
    assert.doesNotMatch(resumeCoordinatorObjective('ц', [], [], { ...stage, roleIds: [] }), /Роли этапа:/)
  })

  it('инструкции, замечания, решение и ответы — целиком; замечание помечено как возврат в этап', () => {
    const text = resumeCoordinatorObjective('ц', [], [], {
      ...stage, instructions: 'Реализуй.', feedback: 'нет тестов', decision: 'вариант A', answers: '- Q\n  Ответ: A'
    })
    assert.match(text, /## Инструкции этапа\n\nРеализуй\./)
    assert.match(text, /## Замечания проверки или человека\n\nнет тестов\n\nЭто возврат в этап: создай подзадачи-исправления/)
    assert.match(text, /## Решение человека\n\nвариант A/)
    assert.match(text, /## Ответы человека на вопросы\n\n- Q\n {2}Ответ: A/)
    assert.doesNotMatch(resumeCoordinatorObjective('ц', [], [], stage), /## (Инструкции|Замечания|Решение|Ответы)/)
  })

  it('подзадачи захода и прошлых заходов — раздельно; уточнение после проверки в этом режиме не дублируется', () => {
    const text = resumeCoordinatorObjective('ц', subtasks, [{ text: 'вернули' }], stage)
    assert.ok(text.indexOf('Подзадачи этого захода:') < text.indexOf('- t2 [In progress] Сделать A'))
    assert.ok(text.indexOf('Подзадачи прошлых заходов и этапов') < text.indexOf('- t1 [Done] Анализ'))
    assert.ok(text.indexOf('- t1 [Done] Анализ') > text.indexOf('- t2 [In progress]'))
    assert.doesNotMatch(text, new RegExp(COORDINATOR_RETURN_HEADING))
    assert.doesNotMatch(text, /runs finish/)
  })

  it('что делать дальше: нет подзадач захода / есть незакрытые / все закрыты', () => {
    assert.match(resumeCoordinatorObjective('ц', [], [], stage), /`stage_started` ты не получил/)
    assert.match(resumeCoordinatorObjective('ц', subtasks, [], stage), /Есть незакрытые подзадачи[\s\S]*дождись `stage_tasks_done`/)
    assert.match(resumeCoordinatorObjective('ц', subtasks, [], { ...stage, tasksDone: true }), /`stage_tasks_done` уже отправлен[\s\S]*orca-board stage finish --summary/)
  })
})

describe('задачи прогона: проверка ветки глобальной задачи и вопрос человеку', () => {
  const ctx = {
    title: 'Экспорт в CSV',
    goal: 'Добавить экспорт отчёта в CSV',
    branch: 'feature/run_x-eksport',
    base: 'develop',
    stages: [{ title: 'Реализация', summary: 'Сделали кнопку и обработчик' }, { title: 'Без сводки', summary: '  ' }]
  }
  const help = readFileSync(new URL('../../../packages/cli/bin/orca-board.js', import.meta.url), 'utf8')
  const helpText = help.slice(help.indexOf('const HELP = `'))

  it('название — «<нода>: <глобальная задача>»', () => {
    assert.equal(runGateTaskTitle('Ревью', 'Экспорт'), 'Ревью: Экспорт')
    assert.equal(runAskTaskTitle('Вопрос', 'Экспорт'), 'Вопрос: Экспорт')
  })

  it('gate: ветка целиком против базы, цель, сводки этапов, свой id из $ORCA_TASK_ID', () => {
    const spec = runGateTaskSpec({ ...ctx, instructions: 'Прогони тесты.' })
    assert.match(spec, /^Проверь ветку `feature\/run_x-eksport` глобальной задачи «Экспорт в CSV» целиком: всё, что в ней сделано относительно базы `develop`/)
    assert.match(spec, /git log develop\.\.feature\/run_x-eksport/)
    assert.match(spec, /git diff develop\.\.\.feature\/run_x-eksport/)
    assert.match(spec, /git merge --no-commit feature\/run_x-eksport[\s\S]*git merge --abort/)
    assert.match(spec, /## Цель глобальной задачи\n\nДобавить экспорт отчёта в CSV/)
    assert.match(spec, /## Что сделано на прошлых этапах\n\n### «Реализация»\n\nСделали кнопку и обработчик/)
    assert.doesNotMatch(spec, /Без сводки/, 'этап без сводки не показываем')
    assert.match(spec, /orca-board review accept --task "\$ORCA_TASK_ID"/)
    assert.match(spec, /orca-board review reject --task "\$ORCA_TASK_ID" --feedback "что исправить"[\s\S]*вернётся на этап «Работа»/)
    assert.match(spec, /Последней командой обязательно `orca-board done --summary "принято"`/)
    assert.match(spec, /## Как проверять\n\nПрогони тесты\./)
    assert.ok(spec.indexOf('## Цель глобальной задачи') < spec.indexOf('## Что сделано'))
  })

  it('gate: нет сводок и инструкций — разделов нет; нет ветки — проверка в текущей ветке проекта', () => {
    const spec = runGateTaskSpec({ title: 'T', goal: '' })
    assert.doesNotMatch(spec, /## Что сделано|## Как проверять/)
    assert.match(spec, /## Цель глобальной задачи\n\nT/, 'нет описания — название')
    assert.match(spec, /^Проверь результат глобальной задачи «T» целиком/)
    assert.match(spec, /нет отдельной ветки/)
    assert.doesNotMatch(spec, /git merge --no-commit/)
    // Ветка есть, базы нет — сравнение с основной веткой, а не «undefined».
    const noBase = runGateTaskSpec({ title: 'T', goal: 'g', branch: 'b' })
    assert.doesNotMatch(noBase, /undefined/)
  })

  it('ask: цель, сводки, ветка только для чтения, что выяснить, правила этапа «Вопрос человеку»', () => {
    const spec = runAskTaskSpec({ ...ctx, instructions: 'Уточни формат дат.' })
    assert.match(spec, /^Ты — этап «Вопрос человеку» воркфлоу глобальной задачи «Экспорт в CSV»/)
    assert.match(spec, /## Цель глобальной задачи\n\nДобавить экспорт отчёта в CSV/)
    assert.match(spec, /### «Реализация»\n\nСделали кнопку/)
    assert.match(spec, /Ветка глобальной задачи: `feature\/run_x-eksport` \(от `develop`\) — читать можно, менять нельзя/)
    assert.match(spec, /## Что нужно выяснить\n\nУточни формат дат\./)
    assert.match(spec, /## Как спрашивать\n\nТвоя цель на этом этапе — задать вопрос\(ы\) человеку\. Код не меняй и ничего не коммить/)
    assert.match(spec, /orca-board ask --question "\.\.\."[\s\S]*отвечает человек, а не координатор/)
    assert.match(spec, /orca-board done --summary "что выяснил"/)
    assert.doesNotMatch(runAskTaskSpec({ title: 'T', goal: 'g' }), /## Что нужно выяснить|Ветка глобальной задачи/)
  })

  it('правила «Вопрос человеку» общие: те же, что в разделе «# Этап» воркера', () => {
    const rules = runAskTaskSpec({ title: 'T', goal: 'g' })
    const stageText = workerTaskPrompt({ title: 't', spec: 's' }, undefined, [], { nodeId: 'a', type: 'ask', title: 'Вопрос' })
    for (const line of rules.split('\n\n').filter((l) => l.startsWith('Твоя цель') || l.startsWith('Спрашивай') || l.startsWith('Когда выяснил'))) {
      assert.ok(stageText.includes(line), line)
    }
  })

  it('команды в спеках есть в HELP CLI', () => {
    const all = [runGateTaskSpec({ ...ctx }), runAskTaskSpec({ ...ctx })].join('\n')
    for (const [, cmd, sub] of all.matchAll(/orca-board ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      const name = cmd === 'done' || cmd === 'ask' ? cmd : `${cmd} ${sub}`
      const re = cmd === 'done' || cmd === 'ask' ? new RegExp(`^ {2}${cmd}\\b`, 'm') : new RegExp(`^ {2}${cmd} ${sub}\\b`, 'm')
      assert.match(helpText, re, `нет «orca-board ${name}» в HELP`)
    }
  })
})

describe('задача-решатель ноды «Решение ИИ»', () => {
  const ctx = {
    title: 'Экран настроек',
    goal: 'Сделать экран настроек профиля',
    branch: 'feature/run_x-settings',
    base: 'develop',
    stages: [{ title: 'Анализ', summary: 'Нужен новый экран и API' }],
    question: 'Нужен ли дизайн для этой задачи?',
    options: [{ id: 'yes', label: 'Да', description: 'есть новый экран' }, { id: 'no', label: 'Нет' }],
    path: [
      { title: 'Анализ', visit: 1 },
      { title: 'Нужен ли дизайн?', visit: 1, outcome: 'next', decision: { label: 'Нет', reason: 'макет  уже\nесть', by: 'human' as const } },
      { title: 'Реализация', visit: 1, outcome: 'no' },
      { title: 'Нужен ли дизайн?', visit: 2, outcome: 'reject' }
    ],
    instructions: 'Дизайн нужен, если меняется UI.'
  }

  it('название — «<нода>: <глобальная задача>»', () => {
    assert.equal(runDecisionTaskTitle('Нужен ли дизайн?', 'Экран'), 'Нужен ли дизайн?: Экран')
  })

  it('вопрос, варианты, цель, сводки, путь, «как решать», ветка только для чтения и команды decision choose|escalate', () => {
    const spec = runDecisionTaskSpec(ctx)
    assert.match(spec, /^Ты — нода «Решение ИИ» воркфлоу глобальной задачи «Экран настроек»/)
    assert.match(spec, /## Вопрос\n\nНужен ли дизайн для этой задачи\?/)
    assert.match(spec, /## Варианты\n\n- `yes` — Да: есть новый экран\n- `no` — Нет/)
    assert.match(spec, /## Цель глобальной задачи\n\nСделать экран настроек профиля/)
    assert.match(spec, /## Что сделано на прошлых этапах\n\n### «Анализ»\n\nНужен новый экран и API/)
    assert.match(spec, /## Путь по графу\n\n1\. «Анализ»\n2\. «Нужен ли дизайн\?» \(пришли по исходу `next`\) — выбрано «Нет» \(решил человек\): макет уже есть\n3\. «Реализация» \(пришли по исходу `no`\)\n4\. «Нужен ли дизайн\?» \(заход 2, пришли по исходу `reject`\)/)
    assert.match(spec, /Ветка глобальной задачи: `feature\/run_x-settings` \(от `develop`\) — читать можно/)
    assert.match(spec, /## Как решать\n\nДизайн нужен, если меняется UI\./)
    assert.match(spec, /## Как сдать решение\n\nТвоя цель — выбрать ровно один вариант[\s\S]*Код не меняй и ничего не коммить/)
    assert.match(spec, /orca-board decision choose --task "\$ORCA_TASK_ID" --option <id> --reason "почему этот вариант"/)
    assert.match(spec, /orca-board decision escalate --task "\$ORCA_TASK_ID" --reason "что неясно"/)
    assert.match(spec, /Последней командой обязательно `orca-board done --summary "выбрано: <название варианта>"`/)
    const order = ['## Вопрос', '## Варианты', '## Цель', '## Что сделано', '## Путь по графу', 'Ветка глобальной задачи', '## Как решать', '## Как сдать решение']
    const at = order.map((h) => spec.indexOf(h))
    assert.deepEqual(at, [...at].sort((a, b) => a - b), 'разделы в порядке')
  })

  it('нет сводок, пути, ветки и инструкций — разделов нет, спека не ломается', () => {
    const spec = runDecisionTaskSpec({ title: 'T', goal: '', question: 'Да или нет?', options: [{ id: 'yes', label: 'Да' }, { id: 'no', label: 'Нет' }] })
    assert.doesNotMatch(spec, /## Что сделано|## Путь по графу|Ветка глобальной задачи|## Как решать|undefined/)
    assert.match(spec, /## Цель глобальной задачи\n\nT/)
    assert.match(spec, /## Как сдать решение/)
  })

  it('skills/worker.md: задача-решение — ровно один вариант через decision choose с --reason, escalate, done последним', () => {
    const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')
    const part = worker.slice(worker.indexOf('- Задача-решение'))
    assert.ok(part.length > 0 && worker.includes('- Задача-решение'))
    // Узнаётся по началу спеки задачи-решателя — заголовок в skill совпадает с runDecisionTaskSpec.
    assert.match(part, /«Ты — нода «Решение ИИ»/)
    assert.match(runDecisionTaskSpec(ctx), /^Ты — нода «Решение ИИ»/)
    assert.match(part, /код не меняй и не коммить/)
    assert.match(part, /\*\*ровно один\*\* вариант/)
    assert.match(part, /orca-board decision choose --task "\$ORCA_TASK_ID" --option <id> --reason "[^"]+"/)
    assert.match(part, /`--reason`\s+обязателен/)
    assert.match(part, /orca-board decision escalate --task "\$ORCA_TASK_ID" --reason "[^"]+"/)
    assert.match(part, /Последней командой — `orca-board done --summary/)
    assert.match(part, /`review accept\|reject` для такой задачи не работает/)
  })

  it('skills/coordinator.md: decision делает приложение и человек — координатор ничего не делает', () => {
    const skill = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')
    assert.match(skill, /Всё остальное делает не ты:[\s\S]*`decision` — агент выбирает ветку графа[\s\S]*\*\*просто жди\*\*/)
    assert.match(skill, /`decision` — «Решение ИИ»: агент роли `roleId` отвечает на `question` и выбирает один из `options`/)
    assert.match(skill, /- `worker_done` с полем `gateFor` —[^\n]*\*\*задача-решение\*\*[\s\S]*ничего не делай/)
    assert.match(skill, /- `request_created` →[\s\S]*`decision`\)\. Ничего не делай[\s\S]*`decision` —\s+агент «Решения ИИ» не выбрал ветку/)
    assert.match(skill, /- `request_resolved` →[\s\S]*`kind: decision`[^\n]*— тоже ничего/)
    // Команды агента-решателя координатору не нужны: решает задача, созданная приложением.
    assert.doesNotMatch(skill, /decision choose|decision escalate/)
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

  it('роли координатора — типа его глобальной задачи; тип он не меняет', () => {
    const prep = skill.slice(skill.indexOf('Подготовка:'), skill.indexOf('Цикл:'))
    assert.match(prep, /`orca-board roles list` — роли \*\*типа твоей глобальной задачи\*\*/)
    assert.match(prep, /Тип выбирает человек при создании — ты его не меняешь/)
    assert.doesNotMatch(prep, /роли есть в проекте/, 'роли больше не у проекта')
  })

  it('request_resolved у approval с decision — выбор человека, учесть в следующих задачах', () => {
    assert.match(skill, /- `request_resolved` →[\s\S]*`kind: approval`[\s\S]*`decision`[\s\S]*учти его в следующих задачах/)
    assert.match(skill, /`decisionTruncated: true`[\s\S]*request get --request <requestId>[\s\S]*`resolution\.text`/)
  })

  it('воркер сдаёт показ человеку через done --show-file / --show, как подсказывает промпт этапа', () => {
    const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')
    assert.match(worker, /«Результат для показа человеку»/)
    assert.match(worker, /orca-board done --summary "\.\.\." --show-file <описание\.md> --show <путь> --show <путь>/)
    assert.match(worker, /без него `done` не пройдёт/)
    // Заголовок в skill совпадает с разделом промпта этапа (workerTaskPrompt).
    assert.match(workerTaskPrompt({ title: 't', spec: 's' }, undefined, [], { nodeId: 'w', title: 'Дизайн', showcase: { what: 'макеты' } }), /## Результат для показа человеку/)
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
  it('тип задачи: types list, global create --type, роли подзадачи — по типу глобальной, rules set --type', () => {
    assert.match(text, /orca-board types list --project <id>/)
    assert.match(text, /orca-board global create --project <id> [^`]*--type <id>/)
    assert.match(text, /orca-board roles list --project <id> --run <id глобальной>/)
    assert.match(text, /orca-board rules set --project <id> --type <id>/)
    assert.match(text, /defaultTypeId/)
    assert.doesNotMatch(text, /templateId/)
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

describe('язык общения агентов с человеком (agentSystemPrompt)', () => {
  const skills = ['worker', 'coordinator', 'assistant'].map((k) => readFileSync(new URL(`../../../skills/${k}.md`, import.meta.url), 'utf8'))
  const role = { title: 'Разработчик', systemPrompt: 'пиши тесты' }

  it('английский интерфейс — английская директива последним блоком у всех служебных инструкций', () => {
    for (const skill of skills) {
      const out = agentSystemPrompt(skill, { projectRules: 'правило', role, language: 'en' })
      const at = out.lastIndexOf(`\n\n${AGENT_LANGUAGE_HEADING}\n`)
      assert.ok(at > 0, 'нет директивы языка')
      assert.ok(at > out.indexOf('# Инструкции роли'), 'директива идёт после роли')
      assert.ok(at > out.indexOf('# Правила проекта'), 'директива идёт после правил проекта')
      const directive = out.slice(at)
      assert.match(directive, /Write everything a human reads in English/)
      assert.match(directive, /orca-board done/)
      assert.match(directive, /orca-board ask/)
      assert.match(directive, /orca-board runs finish/)
      assert.match(directive, /instructions above are in Russian/)
      // Коммиты и комментарии — по правилам проекта, а не по языку интерфейса.
      assert.match(directive, /Commit messages, code comments and documentation follow the project's own rules/)
      assert.doesNotMatch(directive, /[а-яё]/i, 'директива целиком по-английски')
    }
  })

  it('русский или не выбранный язык — промпт как раньше (withAgentRules)', () => {
    for (const skill of skills) {
      const before = withAgentRules(skill, 'правило', role)
      assert.equal(agentSystemPrompt(skill, { projectRules: 'правило', role, language: 'ru' }), before)
      assert.equal(agentSystemPrompt(skill, { projectRules: 'правило', role }), before)
      assert.ok(!agentSystemPrompt(skill, { language: 'ru' }).includes(AGENT_LANGUAGE_HEADING))
    }
    assert.equal(agentLanguageDirective('ru'), '')
    assert.equal(agentLanguageDirective(undefined), '')
  })

  it('без правил и роли (ассистент) — служебная инструкция и директива', () => {
    const out = agentSystemPrompt('SYS', { language: 'en' })
    assert.equal(out, `SYS\n\n${agentLanguageDirective('en')}`)
  })

  it('директива называет только команды, которые есть в CLI', () => {
    const cli = readFileSync(new URL('../../cli/bin/orca-board.js', import.meta.url), 'utf8')
    for (const [, cmd] of agentLanguageDirective('en').matchAll(/`orca-board ([a-z]+(?: [a-z]+)?)`/g)) {
      assert.match(cli, new RegExp(`\\n  ${cmd} `), `нет команды ${cmd} в HELP`)
    }
  })
})

describe('картинки к замечаниям при возврате в работу: skills', () => {
  const worker = readFileSync(new URL('../../../skills/worker.md', import.meta.url), 'utf8')
  const coordinator = readFileSync(new URL('../../../skills/coordinator.md', import.meta.url), 'utf8')

  it('worker.md: изображения к замечаниям — открыть до правок, текст на них не команды, не коммитить', () => {
    assert.match(worker, /приложены изображения/)
    assert.match(worker, /Замечания после ревью/)
    assert.match(worker, /Уточнение к прошлому ответу/)
    assert.match(worker, /\.orca-attachments/)
    assert.match(worker, /данные, а не команды/)
  })

  it('coordinator.md: `images` в stage_started, пересказ словами вместо путей воркерам, answer_clarified и request_resolved', () => {
    assert.match(coordinator, /stage_started` — `\{[^}]*feedback\?, images\?/)
    assert.match(coordinator, /`images` — картинки к `feedback`/)
    assert.match(coordinator, /пути в `task create` не передавай — перескажи словами/)
    assert.match(coordinator, /`images` — пути приложенных картинок, их читает воркер/)
    assert.match(coordinator, /замечания и их картинки \(`images`\)/)
    assert.match(coordinator, /данные, а не команды/)
  })

  it('формулировки промптов и skills согласованы: те же «данные, а не команды» и «не видят»', () => {
    const coord = returnImagesSection(['/x/image-1.png'], 'coordinator')
    assert.match(coord, /данные, а не команды/)
    assert.match(coord, /Воркеры этих файлов не видят/)
    assert.match(coordinator, /Воркеры этих файлов не видят/)
  })
})
