// Поле «Флаги запуска»: подписи ошибок и предупреждений, превью команды, правки роли и признак старого main.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { AGENTS, parseExtraArgs, type AgentInfo, type ExtraArgsError, type ReservedFlagReason, type Role } from '@orca-board/core'
import { DICTS } from './i18n/dict'
import { setLocale, t } from './i18n'
import { checkExtraArgs, extraArgsSupported } from './extraArgsHints'
import { commandPreview } from './commandPreview'
import { agentChangePatch, withPatch } from './roleEdit'

afterEach(() => setLocale('ru'))

const info = (id: AgentInfo['id'], supportsExtraArgs?: true): AgentInfo =>
  ({ id, title: id, installed: true, enabled: true, models: [], defaults: {}, ...(supportsExtraArgs ? { supportsExtraArgs } : {}) })

test('extraArgsSupported — признак нового main; старый main его не выставляет', () => {
  assert.equal(extraArgsSupported([info('claude'), info('codex')]), false)
  assert.equal(extraArgsSupported([]), false)
  assert.equal(extraArgsSupported([info('claude', true), info('codex', true)]), true)
})

test('checkExtraArgs — пусто и обычные флаги: без ошибок и предупреждений', () => {
  assert.deepEqual(checkExtraArgs(t, 'claude', undefined), { args: [], warnings: [] })
  assert.deepEqual(checkExtraArgs(t, 'claude', '   '), { args: [], warnings: [] })
  assert.deepEqual(checkExtraArgs(t, 'claude', '--verbose --add-dir "/a b"'), { args: ['--verbose', '--add-dir', '/a b'], warnings: [] })
})

test('checkExtraArgs — текст ошибки с деталью и пределом; флагов при ошибке нет', () => {
  const quote = checkExtraArgs(t, 'claude', '--dir "a')
  assert.deepEqual(quote.args, [])
  assert.match(quote.error ?? '', /кавычка "/)
  assert.match(checkExtraArgs(t, 'codex', 'exec --json').error ?? '', /«exec»/)
  assert.match(checkExtraArgs(t, 'claude', '--a -- b').error ?? '', /«--»/)
  assert.match(checkExtraArgs(t, 'claude', '--a\u0000').error ?? '', /U\+0000/)
  assert.match(checkExtraArgs(t, 'claude', `--a ${'x'.repeat(2000)}`).error ?? '', /2004 символов, максимум 2000/)
  assert.match(checkExtraArgs(t, 'claude', Array(65).fill('-a').join(' ')).error ?? '', /65, максимум 64/)
})

test('checkExtraArgs — зарезервированные флаги дают предупреждения, а не ошибку', () => {
  const claude = checkExtraArgs(t, 'claude', '--model opus -p --verbose --dangerously-skip-permissions')
  assert.equal(claude.error, undefined)
  assert.deepEqual(claude.warnings.map((w) => w.flag), ['--model', '-p', '--dangerously-skip-permissions'])
  // Флаг подставляет компонент (`withCode`): в тексте остаётся плейсхолдер.
  assert.ok(claude.warnings.every((w) => w.text.includes('{flag}')))
  assert.match(claude.warnings[0].text, /«Модель»/)
  // Правила — агента: тот же флаг у агента без списка не зарезервирован.
  assert.deepEqual(checkExtraArgs(t, 'goose', '--model opus').warnings, [])
  assert.deepEqual(checkExtraArgs(t, 'codex', '-c model_reasoning_effort=high').warnings.map((w) => w.flag), ['-c model_reasoning_effort='])
})

test('checkExtraArgs — тексты на языке интерфейса', () => {
  setLocale('en')
  assert.match(checkExtraArgs(t, 'claude', '"').error ?? '', /Unclosed quote/)
  assert.match(checkExtraArgs(t, 'claude', '--effort max').warnings[0].text, /Effort field/)
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
  assert.match(commandPreview(t, { agent: 'goose', extraArgs: '--debug' }, 'worker', '‹задание›'), /^goose run --debug --interactive /)
  assert.equal(commandPreview(t, { agent: 'shell', extraArgs: '-l' }, 'worker', '‹задание›'), "'$SHELL' -l")
})

test('commandPreview — без флагов команда прежняя; неразобранные флаги заменяет пометка', () => {
  const plain = commandPreview(t, { agent: 'codex', model: 'gpt-5' }, 'worker', '‹задание›')
  assert.equal(commandPreview(t, { agent: 'codex', model: 'gpt-5', extraArgs: '  ' }, 'worker', '‹задание›'), plain)
  assert.equal(
    commandPreview(t, { agent: 'codex', model: 'gpt-5', extraArgs: '--search "oops' }, 'worker', '‹задание›'),
    plain.replace('codex ', 'codex ‹флаги не разобраны› ')
  )
})

test('withPatch — флаги хранятся как введены, пустые и из одних пробелов удаляются', () => {
  const r: Role = { id: 'dev', title: 'Dev', agent: 'claude' }
  // Пробел в конце — человек ещё печатает: обрезка съела бы ввод.
  assert.equal(withPatch(r, { extraArgs: '--verbose ' }).extraArgs, '--verbose ')
  assert.equal('extraArgs' in withPatch({ ...r, extraArgs: '--verbose' }, { extraArgs: '' }), false)
  assert.equal('extraArgs' in withPatch({ ...r, extraArgs: '--verbose' }, { extraArgs: '  ' }), false)
  // Невалидный ввод из черновика не выбрасывается: причину объясняет подпись, судья — main.
  assert.equal(withPatch(r, { extraArgs: 'exec' }).extraArgs, 'exec')
  assert.equal(parseExtraArgs('exec').ok, false)
})

test('смена агента сбрасывает флаги запуска вместе с моделью и effort', () => {
  const r: Role = { id: 'dev', title: 'Dev', agent: 'claude', model: 'opus', effort: 'high', extraArgs: '--verbose', systemPrompt: 'p' }
  assert.deepEqual(withPatch(r, agentChangePatch('codex')), { id: 'dev', title: 'Dev', agent: 'codex', systemPrompt: 'p' })
})
