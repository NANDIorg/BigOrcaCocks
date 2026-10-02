// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EXTRA_ARGS_MAX_COUNT, EXTRA_ARGS_MAX_LENGTH, parseExtraArgs, reservedFlagsIn } from './launch-args.ts'

const args = (text: string): string[] => {
  const r = parseExtraArgs(text)
  assert.equal(r.ok, true, `ожидался разбор: ${JSON.stringify(text)} → ${JSON.stringify(r)}`)
  return r.ok ? r.args : []
}

describe('parseExtraArgs: разбор', () => {
  it('пусто и одни пробелы — без аргументов', () => {
    assert.deepEqual(parseExtraArgs(''), { ok: true, args: [] })
    assert.deepEqual(parseExtraArgs('  \t\n\r\n '), { ok: true, args: [] })
  })

  it('разделители — пробелы, табы и переводы строк; лишние схлопываются', () => {
    assert.deepEqual(args('--search'), ['--search'])
    assert.deepEqual(args('  -s   workspace-write\t--search\n-a never\r\n--x  '), ['-s', 'workspace-write', '--search', '-a', 'never', '--x'])
  })

  it('одинарные кавычки — буквально, без экранирования', () => {
    assert.deepEqual(args(`--name 'a b'`), ['--name', 'a b'])
    assert.deepEqual(args(`--name 'a \\" \\\\ "b" $HOME'`), ['--name', 'a \\" \\\\ "b" $HOME'])
  })

  it('двойные кавычки: только \\" и \\\\ — экранирование, прочие \\ буквальны', () => {
    assert.deepEqual(args(`--name "a b"`), ['--name', 'a b'])
    assert.deepEqual(args(`--name "say \\"hi\\""`), ['--name', 'say "hi"'])
    assert.deepEqual(args(`--path "C:\\\\dir\\\\"`), ['--path', 'C:\\dir\\'])
    assert.deepEqual(args(`--re "\\d+\\n 'x'"`), ['--re', `\\d+\\n 'x'`])
  })

  it('кавычки склеиваются с соседним текстом; "" — пустой аргумент', () => {
    assert.deepEqual(args(`--dir="a b"`), ['--dir=a b'])
    assert.deepEqual(args(`--dir='a b'/"c d"/e`), ['--dir=a b/c d/e'])
    assert.deepEqual(args(`--name ""`), ['--name', ''])
    assert.deepEqual(args(`--name '' -x`), ['--name', '', '-x'])
  })

  it('перевод строки и таб внутри кавычек — часть значения', () => {
    assert.deepEqual(args(`--text "a\n\tb"`), ['--text', 'a\n\tb'])
  })

  it('вне кавычек \\ буквален: Windows-пути не ломаются', () => {
    assert.deepEqual(args('--add-dir C:\\Users\\me\\proj'), ['--add-dir', 'C:\\Users\\me\\proj'])
    assert.deepEqual(args('--add-dir "C:\\Program Files\\App"'), ['--add-dir', 'C:\\Program Files\\App'])
    assert.deepEqual(args('--x a\\ b'), ['--x', 'a\\', 'b'])
  })

  it('никаких раскрытий shell: $VAR, ~, *, ;, |, &&, > остаются как есть', () => {
    assert.deepEqual(args('--a $HOME ~/x *.ts ; | && > `id` $(id)'), ['--a', '$HOME', '~/x', '*.ts', ';', '|', '&&', '>', '`id`', '$(id)'])
  })

  it('юникод', () => {
    assert.deepEqual(args('--name "Задача №1 🐋" --тег=да'), ['--name', 'Задача №1 🐋', '--тег=да'])
  })
})

describe('parseExtraArgs: ошибки', () => {
  it('quote — незакрытая кавычка', () => {
    assert.deepEqual(parseExtraArgs(`--name "a b`), { ok: false, error: 'quote', detail: '"' })
    assert.deepEqual(parseExtraArgs(`--name 'a b`), { ok: false, error: 'quote', detail: "'" })
    assert.deepEqual(parseExtraArgs(`--name "a\\"`), { ok: false, error: 'quote', detail: '"' })
  })

  it('separator — токен "--" в любом месте, в том числе в кавычках', () => {
    assert.deepEqual(parseExtraArgs('--search -- x'), { ok: false, error: 'separator', detail: '--' })
    assert.deepEqual(parseExtraArgs('--search "--"'), { ok: false, error: 'separator', detail: '--' })
    assert.deepEqual(parseExtraArgs('--'), { ok: false, error: 'separator', detail: '--' })
    assert.deepEqual(args('--a=-- ---'), ['--a=--', '---'])
  })

  it('notFlag — первый токен не флаг (подкоманда, путь, пустой, одиночный дефис)', () => {
    assert.deepEqual(parseExtraArgs('exec --search'), { ok: false, error: 'notFlag', detail: 'exec' })
    assert.deepEqual(parseExtraArgs('"mcp list"'), { ok: false, error: 'notFlag', detail: 'mcp list' })
    assert.deepEqual(parseExtraArgs('"" --x'), { ok: false, error: 'notFlag', detail: '' })
    assert.deepEqual(parseExtraArgs('- --x'), { ok: false, error: 'notFlag', detail: '-' })
    // Не первым позиционное значение допустимо — это значение флага.
    assert.deepEqual(args('-s read-only'), ['-s', 'read-only'])
  })

  it('control — управляющие символы, включая NUL, и в кавычках', () => {
    assert.deepEqual(parseExtraArgs('--a\u0000b'), { ok: false, error: 'control', detail: 'U+0000' })
    assert.deepEqual(parseExtraArgs('--a "x\u001by"'), { ok: false, error: 'control', detail: 'U+001B' })
    assert.deepEqual(parseExtraArgs('--a \u007f'), { ok: false, error: 'control', detail: 'U+007F' })
  })

  it('length — строка длиннее лимита; ровно лимит проходит', () => {
    const exact = `--a ${'x'.repeat(EXTRA_ARGS_MAX_LENGTH - 4)}`
    assert.equal(exact.length, EXTRA_ARGS_MAX_LENGTH)
    assert.equal(args(exact).length, 2)
    assert.deepEqual(parseExtraArgs(`${exact}x`), { ok: false, error: 'length', detail: String(EXTRA_ARGS_MAX_LENGTH + 1) })
    assert.deepEqual(parseExtraArgs(' '.repeat(EXTRA_ARGS_MAX_LENGTH + 1)), { ok: false, error: 'length', detail: String(EXTRA_ARGS_MAX_LENGTH + 1) })
  })

  it('count — аргументов больше лимита; ровно лимит проходит', () => {
    assert.equal(EXTRA_ARGS_MAX_LENGTH, 2000)
    assert.equal(EXTRA_ARGS_MAX_COUNT, 64)
    assert.equal(args(Array(EXTRA_ARGS_MAX_COUNT).fill('-a').join(' ')).length, EXTRA_ARGS_MAX_COUNT)
    assert.deepEqual(
      parseExtraArgs(Array(EXTRA_ARGS_MAX_COUNT + 1).fill('-a').join(' ')),
      { ok: false, error: 'count', detail: String(EXTRA_ARGS_MAX_COUNT + 1) }
    )
  })
})

describe('reservedFlagsIn', () => {
  it('claude: флаги приложения с кодом причины, в порядке появления', () => {
    assert.deepEqual(
      reservedFlagsIn('claude', ['--model', 'opus', '--effort=high', '--dangerously-skip-permissions', '--resume', '-p', '--system-prompt', 'x']),
      [
        { flag: '--model', reason: 'model' },
        { flag: '--effort', reason: 'effort' },
        { flag: '--dangerously-skip-permissions', reason: 'permission' },
        { flag: '--resume', reason: 'session' },
        { flag: '-p', reason: 'print' },
        { flag: '--system-prompt', reason: 'systemPrompt' }
      ]
    )
    assert.deepEqual(
      reservedFlagsIn('claude', ['--permission-mode', 'plan', '--session-id', 'u', '-c', '-r', '--fork-session', '--print', '--append-system-prompt', 'x']).map((f) => f.reason),
      ['permission', 'session', 'session', 'session', 'session', 'print', 'systemPrompt']
    )
  })

  it('свободные флаги не отмечаются; похожие по префиксу — тоже', () => {
    assert.deepEqual(reservedFlagsIn('claude', ['--add-dir', '/tmp', '--mcp-config', 'a.json', '--verbose', '--model-x', '--fallback-model', 'm']), [])
    assert.deepEqual(reservedFlagsIn('codex', ['--search', '--add-dir', '/tmp', '-c', 'model_provider=x']), [])
    assert.deepEqual(reservedFlagsIn('claude', []), [])
  })

  it('повтор флага — одно предупреждение; слитное значение и связка коротких узнаются', () => {
    assert.deepEqual(reservedFlagsIn('claude', ['--model', 'a', '--model=b']), [{ flag: '--model', reason: 'model' }])
    assert.deepEqual(reservedFlagsIn('claude', ['-pc']), [{ flag: '-p', reason: 'print' }])
    assert.deepEqual(reservedFlagsIn('codex', ['-mgpt-5']), [{ flag: '-m', reason: 'model' }])
  })

  it('codex: -c зарезервирован для модели, effort и разрешений', () => {
    assert.deepEqual(reservedFlagsIn('codex', ['-m', 'gpt-5', '-c', 'model_reasoning_effort=high']), [
      { flag: '-m', reason: 'model' },
      { flag: '-c model_reasoning_effort=', reason: 'effort' }
    ])
    assert.deepEqual(reservedFlagsIn('codex', ['--config=model=o3', '--config', 'model_reasoning_effort=low']), [
      { flag: '--config model=', reason: 'model' },
      { flag: '--config model_reasoning_effort=', reason: 'effort' }
    ])
    assert.deepEqual(reservedFlagsIn('codex', ['-c', 'sandbox_mode=read-only', '--config=approval_policy=never', '-c', 'model_provider=x', '-c']), [
      { flag: '-c sandbox_mode=', reason: 'permission' },
      { flag: '--config approval_policy=', reason: 'permission' }
    ])
  })

  it('codex: ручные sandbox/approval и обход режима типа дают предупреждение', () => {
    for (const flag of ['--sandbox', '-s', '--ask-for-approval', '-a', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--approve-for-me']) {
      assert.deepEqual(reservedFlagsIn('codex', [flag]), [{ flag, reason: 'permission' }])
    }
    assert.deepEqual(reservedFlagsIn('codex', ['-sdanger-full-access', '--ask-for-approval=never']), [
      { flag: '-s', reason: 'permission' },
      { flag: '--ask-for-approval', reason: 'permission' }
    ])
  })

  it('codex: пробелы около = в настройках разрешений не скрывают предупреждение', () => {
    assert.deepEqual(reservedFlagsIn('codex', ['-c', 'sandbox_mode = read-only', '--config', ' approval_policy = never']), [
      { flag: '-c sandbox_mode=', reason: 'permission' },
      { flag: '--config approval_policy=', reason: 'permission' }
    ])
  })

  it('остальные CLI: ручные разрешения предупреждают о конфликте с режимом типа', () => {
    for (const [agent, flags] of [
      ['gemini', ['--approval-mode=plan', '--yolo', '-dy', '--sandbox']],
      ['cursor', ['--force', '-f', '--yolo', '--sandbox', '--approve-mcps']],
      ['amp', ['--settings-file=x.json', '--dangerously-allow-all']],
      ['copilot', ['--allow-all', '--yolo', '--allow-tool=write', '--deny-tool=shell', '--allow-all-paths', '--allow-all-urls']]
    ] as const) {
      const warnings = reservedFlagsIn(agent, [...flags])
      assert.equal(warnings.length, flags.length, agent)
      assert.ok(warnings.every((warning) => warning.reason === 'permission'), agent)
    }
  })

  it('флаг одного агента у другого не зарезервирован; неизвестный агент и агент без списка — []', () => {
    assert.deepEqual(reservedFlagsIn('codex', ['--effort', 'high', '--permission-mode', 'plan']), [])
    assert.deepEqual(reservedFlagsIn('gemini', ['-m', 'pro']), [{ flag: '-m', reason: 'model' }])
    assert.deepEqual(reservedFlagsIn('shell', ['--model', 'x']), [])
    assert.deepEqual(reservedFlagsIn('нет-такого', ['--model', 'x']), [])
  })
})
