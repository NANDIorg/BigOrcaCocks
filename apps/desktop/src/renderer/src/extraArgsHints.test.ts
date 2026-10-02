// Поле «Флаги запуска»: подписи ошибок и предупреждений, превью команды, правки роли и признак старого main.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { AGENTS, parseExtraArgs, type AgentInfo, type ExtraArgsError, type ReservedFlagReason, type Role } from '@orca-board/core'
import { DICTS } from './i18n/dict'
import { setLocale, t } from './i18n'
import { checkExtraArgs, extraArgsSupported } from './extraArgsHints'
import { commandPreview } from './commandPreview'
import { agentChangePatch, duplicatedRole, rolesForSave, withPatch, withSavableExtraArgs } from './roleEdit'

afterEach(() => setLocale('ru'))

const info = (id: AgentInfo['id'], supportsExtraArgs?: true): AgentInfo =>
  ({ id, title: id, installed: true, enabled: true, models: [], defaults: {}, ...(supportsExtraArgs ? { supportsExtraArgs } : {}) })

/** Проверка флагов исполнителя без модели и effort. */
const check = (agent: AgentInfo['id'], extraArgs: string): ReturnType<typeof checkExtraArgs> => checkExtraArgs(t, { agent, extraArgs })

test('extraArgsSupported — признак нового main; старый main его не выставляет', () => {
  assert.equal(extraArgsSupported([info('claude'), info('codex')]), false)
  assert.equal(extraArgsSupported([]), false)
  assert.equal(extraArgsSupported([info('claude', true), info('codex', true)]), true)
})

test('checkExtraArgs — пусто и обычные флаги: без ошибок и предупреждений', () => {
  assert.deepEqual(checkExtraArgs(t, { agent: 'claude' }), { args: [], warnings: [] })
  assert.deepEqual(check('claude', '   '), { args: [], warnings: [] })
  assert.deepEqual(check('claude', '--verbose --add-dir "/a b"'), { args: ['--verbose', '--add-dir', '/a b'], warnings: [] })
})

test('checkExtraArgs — текст ошибки с деталью и пределом; флагов при ошибке нет', () => {
  const quote = check('claude', '--dir "a')
  assert.deepEqual(quote.args, [])
  assert.match(quote.error ?? '', /кавычка "/)
  assert.match(check('codex', 'exec --json').error ?? '', /«exec»/)
  assert.match(check('claude', '--a -- b').error ?? '', /«--»/)
  assert.match(check('claude', '--a\u0000').error ?? '', /U\+0000/)
  assert.match(check('claude', `--a ${'x'.repeat(2000)}`).error ?? '', /2004 символов, максимум 2000/)
  assert.match(check('claude', Array(65).fill('-a').join(' ')).error ?? '', /65, максимум 64/)
})

test('checkExtraArgs — ошибка говорит, что не сохранятся только флаги, а остальные поля сохраняются', () => {
  for (const text of ['--dir "a', 'exec --json', '--a -- b', '--a\u0000']) {
    const error = check('claude', text).error ?? ''
    assert.match(error, /Флаги не сохранятся, пока ошибка не исправлена/, text)
    assert.match(error, /Остальные поля сохраняются\.$/, text)
  }
  setLocale('en')
  assert.match(check('claude', '"').error ?? '', /won’t be saved until this is fixed.*Other fields are saved\.$/)
})

test('checkExtraArgs — Windows-путь с \\ перед закрывающей двойной кавычкой: подсказка про одинарные кавычки', () => {
  const tip = /одинарные кавычки или уберите завершающий «\\»/
  assert.equal(parseExtraArgs('--add-dir "C:\\dir\\"').ok, false)
  assert.match(check('claude', '--add-dir "C:\\dir\\"').error ?? '', tip)
  assert.match(check('claude', '--add-dir "C:\\dir\\" --verbose').error ?? '', tip)
  // Советы из подсказки разбираются.
  assert.deepEqual(check('claude', "--add-dir 'C:\\dir\\'").args, ['--add-dir', 'C:\\dir\\'])
  assert.deepEqual(check('claude', '--add-dir "C:\\dir"').args, ['--add-dir', 'C:\\dir'])
  // Обычная незакрытая кавычка — без подсказки про путь.
  assert.doesNotMatch(check('claude', '--dir "a').error ?? '', tip)
  assert.doesNotMatch(check('claude', "--dir 'C:\\dir\\\"").error ?? '', tip)
  setLocale('en')
  assert.match(check('claude', '--add-dir "C:\\dir\\"').error ?? '', /single quotes or drop the trailing “\\”/)
})

test('checkExtraArgs — зарезервированные флаги дают предупреждения, а не ошибку', () => {
  const claude = checkExtraArgs(t, { agent: 'claude', model: 'sonnet', extraArgs: '--model opus -p --verbose --dangerously-skip-permissions' })
  assert.equal(claude.error, undefined)
  assert.deepEqual(claude.warnings.map((w) => w.flag), ['--model', '-p', '--dangerously-skip-permissions'])
  // Флаг подставляет компонент (`withCode`): в тексте остаётся плейсхолдер.
  assert.ok(claude.warnings.every((w) => w.text.includes('{flag}')))
  assert.match(claude.warnings[0].text, /«Модель»/)
  // Правила — агента: тот же флаг у агента без списка не зарезервирован.
  assert.deepEqual(check('goose', '--model opus').warnings, [])
  assert.deepEqual(
    checkExtraArgs(t, { agent: 'codex', effort: 'low', extraArgs: '-c model_reasoning_effort=high' }).warnings.map((w) => w.flag),
    ['-c model_reasoning_effort=']
  )
})

test('checkExtraArgs — про модель и effort предупреждает, только когда поле исполнителя заполнено', () => {
  const flags = (exec: Parameters<typeof checkExtraArgs>[1]): string[] => checkExtraArgs(t, exec).warnings.map((w) => w.flag)
  const extraArgs = '--model opus --effort max'
  // Поля пустые: приложение своих флагов не ставит — флаги пользователя действуют, конфликта нет.
  assert.deepEqual(flags({ agent: 'claude', extraArgs }), [])
  assert.deepEqual(flags({ agent: 'claude', model: '', effort: '', extraArgs }), [])
  // Каждое поле — своё предупреждение.
  assert.deepEqual(flags({ agent: 'claude', model: 'sonnet', extraArgs }), ['--model'])
  assert.deepEqual(flags({ agent: 'claude', effort: 'low', extraArgs }), ['--effort'])
  assert.deepEqual(flags({ agent: 'claude', model: 'sonnet', effort: 'low', extraArgs }), ['--model', '--effort'])
  // codex: `-m` и `-c model=` — про модель, `-c model_reasoning_effort=` — про effort.
  const codex = '-m gpt-5 -c model=gpt-5 -c model_reasoning_effort=high'
  assert.deepEqual(flags({ agent: 'codex', extraArgs: codex }), [])
  assert.deepEqual(flags({ agent: 'codex', model: 'o3', extraArgs: codex }), ['-m', '-c model='])
  assert.deepEqual(flags({ agent: 'codex', effort: 'low', extraArgs: codex }), ['-c model_reasoning_effort='])
  // Остальные причины от полей не зависят.
  assert.deepEqual(
    flags({ agent: 'claude', extraArgs: '--dangerously-skip-permissions --resume x -p --system-prompt y' }),
    ['--dangerously-skip-permissions', '--resume', '-p', '--system-prompt']
  )
})

test('checkExtraArgs — тексты на языке интерфейса', () => {
  setLocale('en')
  assert.match(check('claude', '"').error ?? '', /Unclosed quote/)
  assert.match(checkExtraArgs(t, { agent: 'claude', effort: 'low', extraArgs: '--effort max' }).warnings[0].text, /Effort field/)
})

test('у каждого кода ошибки и каждой причины из реестра есть текст в ru и en', () => {
  const errors: Record<ExtraArgsError, true> = { quote: true, separator: true, notFlag: true, control: true, length: true, count: true }
  const reasons = new Set<ReservedFlagReason>(AGENTS.flatMap((a) => ('reservedFlags' in a ? a.reservedFlags.map((r) => r.reason) : [])))
  for (const dict of [DICTS.ru, DICTS.en]) {
    const config: Record<string, unknown> = dict.config
    for (const code of Object.keys(errors)) assert.equal(typeof config[`roles.extraArgsError.${code}`], 'string', code)
    for (const reason of reasons) assert.match(String(config[`roles.extraArgsReserved.${reason}`]), /\{flag\}/, reason)
  }
})

test('commandPreview — флаги пользователя сразу после команды, перед флагами приложения', () => {
  assert.equal(
    commandPreview(t, { agent: 'claude', model: 'opus', extraArgs: '--verbose --add-dir "/a b"' }, 'worker', '‹задание›', 'auto'),
    "claude --verbose --add-dir '/a b' --permission-mode auto --allowedTools 'Bash(orca-board:*)' --model opus " +
      '--append-system-prompt ‹skills/worker.md› ‹задание›'
  )
  assert.match(commandPreview(t, { agent: 'goose', extraArgs: '--debug' }, 'worker', '‹задание›'), /^GOOSE_MODE=approve goose run --debug --interactive /)
  assert.equal(commandPreview(t, { agent: 'shell', extraArgs: '-l' }, 'worker', '‹задание›'), "'$SHELL' -l")
})

test('commandPreview — без флагов команда прежняя; неразобранные флаги заменяет пометка', () => {
  const plain = commandPreview(t, { agent: 'codex', model: 'gpt-5' }, 'worker', '‹задание›')
  assert.equal(commandPreview(t, { agent: 'codex', model: 'gpt-5', extraArgs: '  ' }, 'worker', '‹задание›'), plain)
  // Пометка стоит на месте флагов, а разделитель `--` перед заданием (codex ставит его вместе с флагами пользователя)
  // остаётся: превью показывает, каким был бы запуск, если бы флаги разобрались.
  assert.equal(
    commandPreview(t, { agent: 'codex', model: 'gpt-5', extraArgs: '--search "oops' }, 'worker', '‹задание›'),
    plain.replace('codex ', 'codex ‹флаги не разобраны› ').replace(' ‹skills/', ' -- ‹skills/')
  )
  // Разобранные флаги: variadic `--image` закрыт разделителем — как в реальном запуске.
  assert.equal(
    commandPreview(t, { agent: 'codex', model: 'gpt-5', extraArgs: '--image "a b.png"' }, 'worker', '‹задание›'),
    `codex --image 'a b.png' -c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"' -m gpt-5 -- ‹skills/worker.md› --- ‹задание›`
  )
})

test('commandPreview — полный доступ типа задачи виден в аргументах Codex и Claude', () => {
  assert.equal(
    commandPreview(t, { agent: 'codex' }, 'worker', '‹задание›', 'bypassPermissions'),
    `codex -c 'sandbox_mode="danger-full-access"' -c 'approval_policy="never"' ‹skills/worker.md› --- ‹задание›`
  )
  assert.match(
    commandPreview(t, { agent: 'claude' }, 'worker', '‹задание›', 'bypassPermissions'),
    /--permission-mode bypassPermissions/
  )
})

test('commandPreview — показывает окружение разрешений и отдельный файл настроек Amp', () => {
  assert.match(commandPreview(t, { agent: 'goose' }, 'worker', '‹задание›', 'bypassPermissions'), /^GOOSE_MODE=auto goose run /)
  const open = commandPreview(t, { agent: 'opencode' }, 'worker', '‹задание›', 'acceptEdits')
  assert.match(open, /^OPENCODE_PERMISSION='/)
  assert.ok(open.includes('"edit":{"*":"allow"}'))
  assert.ok(open.includes('"bash":{"*":"ask"}'))
  const amp = commandPreview(t, { agent: 'amp' }, 'worker', '‹задание›', 'auto')
  assert.match(amp, /--settings-file ‹/)
  assert.ok(amp.includes('"amp.dangerouslyAllowAll":false'))
})

test('withPatch — флаги хранятся как введены, пустые и из одних пробелов удаляются', () => {
  const r: Role = { id: 'dev', title: 'Dev', agent: 'claude' }
  // Пробел в конце — человек ещё печатает: обрезка съела бы ввод.
  assert.equal(withPatch(r, { extraArgs: '--verbose ' }).extraArgs, '--verbose ')
  assert.equal('extraArgs' in withPatch({ ...r, extraArgs: '--verbose' }, { extraArgs: '' }), false)
  assert.equal('extraArgs' in withPatch({ ...r, extraArgs: '--verbose' }, { extraArgs: '  ' }), false)
  // Невалидный ввод из черновика не выбрасывается: причину объясняет подпись, в main он не уходит (`rolesForSave`).
  assert.equal(withPatch(r, { extraArgs: 'exec' }).extraArgs, 'exec')
  assert.equal(parseExtraArgs('exec').ok, false)
})

test('смена агента сбрасывает флаги запуска вместе с моделью и effort', () => {
  const r: Role = { id: 'dev', title: 'Dev', agent: 'claude', model: 'opus', effort: 'high', extraArgs: '--verbose', systemPrompt: 'p' }
  assert.deepEqual(withPatch(r, agentChangePatch('codex')), { id: 'dev', title: 'Dev', agent: 'codex', systemPrompt: 'p' })
})

test('дублирование роли переносит флаги запуска и остальные поля; оригинал не меняется', () => {
  const r: Role = { id: 'dev', title: 'Dev', agent: 'codex', model: 'gpt-5', effort: 'low', systemPrompt: 'p', extraArgs: '--search --add-dir "/a b"' }
  const copy = duplicatedRole(r, 'dev_2', 'Dev (копия)')
  assert.deepEqual(copy, { ...r, id: 'dev_2', title: 'Dev (копия)' })
  assert.equal(copy.extraArgs, '--search --add-dir "/a b"')
  assert.equal(r.id, 'dev')
  assert.equal(r.title, 'Dev')
  // Роль без флагов остаётся без поля: пустой extraArgs не появляется.
  assert.equal('extraArgs' in duplicatedRole({ id: 'a', title: 'A', agent: 'claude' }, 'b', 'B'), false)
})

test('rolesForSave — негодные флаги не уходят в main: соседнее поле сохраняется, флаги остаются прежние', () => {
  const saved: Role[] = [
    { id: 'dev', title: 'Dev', agent: 'claude', extraArgs: '--verbose' },
    { id: 'qa', title: 'QA', agent: 'codex' }
  ]
  // Человек дописал незакрытую кавычку и сменил effort, название и инструкции.
  const draft: Role[] = [
    { id: 'dev', title: 'Developer', agent: 'claude', effort: 'low', systemPrompt: 'p', extraArgs: '--verbose "oops' },
    { id: 'qa', title: 'QA', agent: 'codex', model: 'gpt-5', extraArgs: 'exec --json' }
  ]
  const out = rolesForSave(draft, saved)
  assert.deepEqual(out, [
    { id: 'dev', title: 'Developer', agent: 'claude', effort: 'low', systemPrompt: 'p', extraArgs: '--verbose' },
    // Прежних флагов не было — поля нет вовсе.
    { id: 'qa', title: 'QA', agent: 'codex', model: 'gpt-5' }
  ])
  assert.ok(out.every((r) => parseExtraArgs(r.extraArgs ?? '').ok))
  // Черновик не тронут: в поле ввода остаётся введённое.
  assert.equal(draft[0].extraArgs, '--verbose "oops')
  assert.equal(draft[1].extraArgs, 'exec --json')
})

test('rolesForSave — годные флаги уходят как введены, пустые очищают поле', () => {
  const saved: Role[] = [{ id: 'dev', title: 'Dev', agent: 'claude', extraArgs: '--verbose' }]
  const typed: Role[] = [{ id: 'dev', title: 'Dev', agent: 'claude', extraArgs: '--verbose --add-dir "/a b" ' }]
  assert.deepEqual(rolesForSave(typed, saved), typed)
  // Годная роль уходит тем же объектом — без лишних копий.
  assert.equal(rolesForSave(typed, saved)[0], typed[0])
  // Поле стёрли (`withPatch` удаляет пустое) — прежние флаги не возвращаются.
  const cleared = [withPatch(saved[0], { extraArgs: '' })]
  assert.deepEqual(rolesForSave(cleared, saved), [{ id: 'dev', title: 'Dev', agent: 'claude' }])
  // Исправил ошибку — следующий же вызов отправляет новые флаги; основа — то, что ушло в прошлый раз.
  const sent = rolesForSave([{ ...saved[0], extraArgs: '--debug "' }], saved)
  assert.equal(sent[0].extraArgs, '--verbose')
  assert.equal(rolesForSave([{ ...saved[0], extraArgs: '--debug "x"' }], sent)[0].extraArgs, '--debug "x"')
})

test('rolesForSave — смена агента по-прежнему сбрасывает флаги; флаги другого агента не подставляются', () => {
  const saved: Role[] = [{ id: 'dev', title: 'Dev', agent: 'claude', model: 'opus', extraArgs: '--verbose' }]
  // Агент сменён, пока в поле негодный текст: сброс флагов годный и уходит.
  const changed = [withPatch({ ...saved[0], extraArgs: '--verbose "oops' }, agentChangePatch('codex'))]
  assert.deepEqual(rolesForSave(changed, saved), [{ id: 'dev', title: 'Dev', agent: 'codex' }])
  // Сохранение смены агента не прошло (основа — прежний агент), а в поле уже негодные флаги нового: флаги claude к codex не уходят.
  assert.deepEqual(rolesForSave([{ ...changed[0], extraArgs: '--search "' }], saved), [{ id: 'dev', title: 'Dev', agent: 'codex' }])
})

test('rolesForSave — новая роль и копия с негодными флагами уходят без флагов; негодная основа не подставляется', () => {
  const saved: Role[] = [{ id: 'dev', title: 'Dev', agent: 'claude', extraArgs: '--verbose' }]
  const copy = duplicatedRole({ ...saved[0], extraArgs: '--verbose "oops' }, 'dev_2', 'Dev 2')
  assert.deepEqual(rolesForSave([saved[0], copy], saved), [saved[0], { id: 'dev_2', title: 'Dev 2', agent: 'claude' }])
  // Основа сама негодная (файл правили руками, старый main) — в main не уходит и она.
  const broken = { agent: 'claude' as const, extraArgs: 'exec' }
  assert.deepEqual(withSavableExtraArgs({ agent: 'claude', extraArgs: '"' }, broken), { agent: 'claude' })
  assert.deepEqual(withSavableExtraArgs({ agent: 'claude', extraArgs: '"' }, undefined), { agent: 'claude' })
})
