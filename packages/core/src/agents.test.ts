// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENTS, effortOptionsFor, getAgent, modelLabel, parseCodexModelsCache, type AgentInfo, type AgentInvokeOptions } from './agents.ts'
import { promptChannel } from './prompts.ts'

const cache = (models: unknown[]): string => JSON.stringify({ models })

describe('parseCodexModelsCache', () => {
  it('пустой/битый кэш без дефолта — []', () => {
    assert.deepEqual(parseCodexModelsCache(undefined), [])
    assert.deepEqual(parseCodexModelsCache(''), [])
    assert.deepEqual(parseCodexModelsCache('{не json'), [])
    assert.deepEqual(parseCodexModelsCache(cache([])), [])
  })

  it('пустой кэш с дефолтом — только дефолтная модель', () => {
    assert.deepEqual(parseCodexModelsCache('{не json', 'gpt-x'), [{ id: 'gpt-x', label: 'gpt-x (по умолчанию)' }])
  })

  it('efforts из supported_reasoning_levels; без поля или пустое — без efforts', () => {
    const text = cache([
      { slug: 'a', display_name: 'A', supported_reasoning_levels: [{ effort: 'low', description: '' }, { effort: 'max', description: '' }] },
      { slug: 'b', display_name: 'B' },
      { slug: 'c', display_name: 'C', supported_reasoning_levels: [] }
    ])
    assert.deepEqual(parseCodexModelsCache(text), [
      { id: 'a', label: 'A', efforts: ['low', 'max'] },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' }
    ])
  })

  it('дефолтная модель из кэша помечается, не из кэша — добавляется первой', () => {
    const text = cache([{ slug: 'a', display_name: 'A' }, { slug: 'b', display_name: 'B' }])
    assert.deepEqual(parseCodexModelsCache(text, 'b').map((m) => m.label), ['A', 'B (по умолчанию)'])
    assert.deepEqual(parseCodexModelsCache(text, 'z'), [
      { id: 'z', label: 'z (по умолчанию)' },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ])
  })

  it('скрытые модели пропускаются, кроме дефолтной', () => {
    const text = cache([{ slug: 'a', display_name: 'A', visibility: 'hide' }, { slug: 'b', display_name: 'B', visibility: 'hide' }])
    assert.deepEqual(parseCodexModelsCache(text, 'b'), [{ id: 'b', label: 'B (по умолчанию)' }])
  })
})

describe('effortOptionsFor / modelLabel', () => {
  const info: AgentInfo = {
    id: 'codex', title: 'Codex', installed: true, enabled: true, defaults: {},
    models: [{ id: 'a', label: 'A', efforts: ['low', 'xhigh'] }, { id: 'b', label: 'B' }]
  }

  it('efforts модели, иначе общий список агента', () => {
    assert.deepEqual(effortOptionsFor(info, 'a'), ['low', 'xhigh'])
    assert.deepEqual(effortOptionsFor(info, 'b'), ['low', 'medium', 'high'])
    assert.deepEqual(effortOptionsFor(info), ['low', 'medium', 'high'])
  })

  it('label по id, неизвестный — сам id', () => {
    assert.equal(modelLabel(info, 'a'), 'A')
    assert.equal(modelLabel(info, 'zzz'), 'zzz')
    assert.equal(modelLabel(undefined, 'zzz'), 'zzz')
    assert.equal(modelLabel(info, undefined), undefined)
  })
})

describe('invoke: argv агентов и флаги пользователя (extraArgs)', () => {
  const SYS = 'SYSTEM'
  const TASK = 'TASK'
  const BOTH = `${SYS}\n\n---\n\n${TASK}`
  const min: AgentInvokeOptions = { permissionMode: 'auto', shell: '/bin/zsh' }
  const full: AgentInvokeOptions = { permissionMode: 'acceptEdits', shell: '/bin/zsh', model: 'M', effort: 'high', sessionId: 'uuid-1' }
  /** Флаги пользователя: variadic-флаг в конце — он не должен оказаться рядом с промптом. */
  const extra = ['--search', '--add-dir', '/tmp/a b']
  const X = '<extra>'

  /**
   * Эталон argv каждого агента, записанный литералами: `X` — место флагов пользователя.
   * Без `extraArgs` argv — тот же список без `X`, то есть ровно как до появления флагов.
   */
  const expected: Record<string, { command: string; min: string[]; full: string[] }> = {
    claude: {
      command: 'claude',
      min: [X, '--permission-mode', 'auto', '--allowedTools', 'Bash(orca-board:*)', '--append-system-prompt', SYS, TASK],
      full: [
        X, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(orca-board:*)', '--model', 'M', '--effort', 'high',
        '--session-id', 'uuid-1', '--append-system-prompt', SYS, TASK
      ]
    },
    codex: { command: 'codex', min: [X, BOTH], full: [X, '-m', 'M', '-c', 'model_reasoning_effort=high', BOTH] },
    opencode: { command: 'opencode', min: [X, '--prompt', BOTH], full: [X, '--model', 'M', '--prompt', BOTH] },
    gemini: { command: 'gemini', min: [X, '-i', BOTH], full: [X, '-m', 'M', '-i', BOTH] },
    cursor: { command: 'cursor-agent', min: [X, BOTH], full: [X, '--model', 'M', BOTH] },
    amp: { command: 'amp', min: [X, BOTH], full: [X, BOTH] },
    copilot: { command: 'copilot', min: [X, '-i', BOTH], full: [X, '-i', BOTH] },
    // Подкоманда `run` остаётся первой: флаги пользователя относятся к ней.
    goose: { command: 'goose', min: ['run', X, '--interactive', '--text', BOTH], full: ['run', X, '--interactive', '--text', BOTH] },
    shell: { command: '/bin/zsh', min: [X], full: [X] }
  }
  const withExtra = (argv: string[], value: readonly string[]): string[] => argv.flatMap((a) => (a === X ? value : [a]))

  it('эталон есть для каждого агента реестра', () => {
    assert.deepEqual(Object.keys(expected), AGENTS.map((a) => a.id))
  })

  for (const spec of AGENTS) {
    const want = expected[spec.id]
    const invoke = (opts: AgentInvokeOptions) => getAgent(spec.id)!.invoke(SYS, TASK, opts)

    it(`${spec.id}: без extraArgs argv прежний`, () => {
      assert.deepEqual(invoke(min), { command: want.command, args: withExtra(want.min, []) })
      assert.deepEqual(invoke(full), { command: want.command, args: withExtra(want.full, []) })
      assert.deepEqual(invoke({ ...full, extraArgs: [] }), invoke(full))
    })

    it(`${spec.id}: extraArgs — перед флагами приложения и промптом`, () => {
      assert.deepEqual(invoke({ ...min, extraArgs: extra }), { command: want.command, args: withExtra(want.min, extra) })
      assert.deepEqual(invoke({ ...full, extraArgs: extra }), { command: want.command, args: withExtra(want.full, extra) })
    })

    it(`${spec.id}: extraArgs не мутируется и не попадает в argv по ссылке`, () => {
      const frozen = Object.freeze([...extra])
      const { args } = invoke({ ...min, extraArgs: frozen })
      assert.notEqual(args, frozen)
      assert.deepEqual(frozen, extra)
    })
  }

  it('promptChannel от extraArgs не зависит', () => {
    const channels = Object.fromEntries(AGENTS.map((a) => [a.id, promptChannel(a)]))
    assert.deepEqual(channels, {
      claude: 'system', codex: 'combined', opencode: 'combined', gemini: 'combined', cursor: 'combined',
      amp: 'combined', copilot: 'combined', goose: 'combined', shell: 'none'
    })
    for (const a of AGENTS) {
      const spec = getAgent(a.id)!
      const wrapped = { invoke: (s: string, p: string, o: AgentInvokeOptions) => spec.invoke(s, p, { ...o, extraArgs: extra }) }
      assert.equal(promptChannel(wrapped), channels[a.id], a.id)
    }
  })

  it('reservedFlags: у каждого правила есть флаги, написания начинаются с дефиса', () => {
    for (const a of AGENTS) {
      for (const rule of getAgent(a.id)!.reservedFlags ?? []) {
        assert.ok(rule.flags.length > 0, a.id)
        for (const flag of rule.flags) assert.match(flag, /^--?[A-Za-z]/, `${a.id}: ${flag}`)
      }
    }
  })
})
