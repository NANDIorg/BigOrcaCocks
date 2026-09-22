/**
 * Реестр известных CLI-агентов. Из него выводится AgentKind и названия для UI,
 * а также способ запуска каждого агента (команда + аргументы).
 */

export interface AgentInvocation {
  command: string
  args: string[]
}

export interface AgentInvokeOptions {
  /** Режим разрешений Claude Code (auto | bypassPermissions | acceptEdits). */
  permissionMode: string
  /** Оболочка пользователя ($SHELL), для агента shell. */
  shell: string
  /** Модель агента; пусто — по умолчанию у агента. */
  model?: string
  /** Уровень рассуждений (effort); пусто — по умолчанию у агента. Учитывают только claude и codex. */
  effort?: string
}

/** Подсказка модели для UI: значение для CLI и необязательная подпись. */
export interface ModelHint {
  value: string
  label?: string
}

export interface AgentSpec {
  id: string
  /** Название для UI. */
  title: string
  /** Бинарник, который ищем в PATH. */
  bin: string
  /** Аргументы для получения версии (нет — версию не спрашиваем). */
  versionArgs?: string[]
  /** Подсказки моделей для datalist в UI (не ограничение: можно ввести любую). */
  modelHints?: readonly ModelHint[]
  /** Допустимые уровни effort; [] — агент effort не поддерживает. */
  effortOptions: readonly string[]
  /** Как передать системную инструкцию (system) и задание (prompt). */
  invoke(system: string, prompt: string, opts: AgentInvokeOptions): AgentInvocation
}

/** Системная инструкция и задание одним текстом — для агентов без отдельного system prompt. */
function combine(system: string, prompt: string): string {
  return `${system}\n\n---\n\n${prompt}`
}

/** Флаг со значением (модель, effort) для аргументов CLI; пустое значение — без флага. */
function modelFlag(flag: string, model?: string): string[] {
  return model ? [flag, model] : []
}

export const AGENTS = [
  {
    id: 'claude',
    title: 'Claude Code',
    bin: 'claude',
    versionArgs: ['--version'],
    modelHints: [
      { value: 'opus', label: 'opus — актуальный Opus' },
      { value: 'sonnet', label: 'sonnet — актуальный Sonnet' },
      { value: 'haiku', label: 'haiku — актуальный Haiku' },
      { value: 'claude-opus-5' },
      { value: 'claude-sonnet-5' },
      { value: 'claude-fable-5-1' }
    ],
    effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Режим разрешений проекта + orca-board всегда без вопросов.
    invoke: (system, prompt, opts) => ({
      command: 'claude',
      args: [
        '--permission-mode', opts.permissionMode,
        '--allowedTools', 'Bash(orca-board:*)',
        ...modelFlag('--model', opts.model),
        ...modelFlag('--effort', opts.effort),
        '--append-system-prompt', system,
        prompt
      ]
    })
  },
  {
    id: 'codex',
    title: 'Codex',
    bin: 'codex',
    versionArgs: ['--version'],
    effortOptions: ['low', 'medium', 'high'],
    invoke: (system, prompt, opts) => ({
      command: 'codex',
      args: [
        ...modelFlag('-m', opts.model),
        ...(opts.effort ? ['-c', `model_reasoning_effort=${opts.effort}`] : []),
        combine(system, prompt)
      ]
    })
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    bin: 'opencode',
    versionArgs: ['--version'],
    effortOptions: [],
    invoke: (system, prompt, opts) => ({
      command: 'opencode',
      args: [...modelFlag('--model', opts.model), '--prompt', combine(system, prompt)]
    })
  },
  {
    id: 'gemini',
    title: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    effortOptions: [],
    // Интерактивный режим с начальным промптом.
    invoke: (system, prompt, opts) => ({
      command: 'gemini',
      args: [...modelFlag('-m', opts.model), '-i', combine(system, prompt)]
    })
  },
  {
    id: 'cursor',
    title: 'Cursor Agent',
    bin: 'cursor-agent',
    versionArgs: ['--version'],
    effortOptions: [],
    invoke: (system, prompt, opts) => ({
      command: 'cursor-agent',
      args: [...modelFlag('--model', opts.model), combine(system, prompt)]
    })
  },
  {
    id: 'amp',
    title: 'Amp',
    bin: 'amp',
    versionArgs: ['--version'],
    effortOptions: [],
    // Модель не выбирается из CLI — игнорируем.
    invoke: (system, prompt) => ({ command: 'amp', args: [combine(system, prompt)] })
  },
  {
    id: 'copilot',
    title: 'GitHub Copilot CLI',
    bin: 'copilot',
    versionArgs: ['--version'],
    effortOptions: [],
    // Модель не выбирается из CLI — игнорируем.
    invoke: (system, prompt) => ({ command: 'copilot', args: ['-i', combine(system, prompt)] })
  },
  {
    id: 'goose',
    title: 'Goose',
    bin: 'goose',
    versionArgs: ['--version'],
    effortOptions: [],
    // Модель задаётся конфигом goose, из CLI — игнорируем.
    invoke: (system, prompt) => ({
      command: 'goose',
      args: ['run', '--interactive', '--text', combine(system, prompt)]
    })
  },
  {
    id: 'shell',
    title: 'Оболочка',
    // Реальная команда — $SHELL пользователя, но для проверки «установлен» ищем sh: он есть всегда.
    bin: 'sh',
    effortOptions: [],
    invoke: (_system, _prompt, opts) => ({ command: opts.shell, args: [] })
  }
] as const satisfies readonly AgentSpec[]

export type AgentKind = (typeof AGENTS)[number]['id']

export const AGENT_IDS: AgentKind[] = AGENTS.map((a) => a.id)

export const AGENT_TITLES: Record<AgentKind, string> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a.title])
) as Record<AgentKind, string>

export const DEFAULT_AGENT: AgentKind = 'claude'

/** Что знает приложение об агенте: из реестра + установлен ли + включён ли в проекте. */
export interface AgentInfo {
  id: AgentKind
  title: string
  installed: boolean
  enabled: boolean
  version?: string
  /** Дефолты агента из его конфига (сейчас только codex: ~/.codex/config.toml). */
  defaults?: { model?: string; effort?: string }
}

export function getAgent(id: string): AgentSpec | undefined {
  return AGENTS.find((a) => a.id === id)
}

export function isAgentKind(id: string): id is AgentKind {
  return AGENTS.some((a) => a.id === id)
}

/** Подсказки моделей агента для UI; у неизвестного агента или без подсказок — []. */
export function modelHints(agent: string): readonly ModelHint[] {
  return getAgent(agent)?.modelHints ?? []
}

/** Уровни effort агента для UI; у неизвестного агента или без поддержки effort — []. */
export function effortOptions(agent: string): readonly string[] {
  return getAgent(agent)?.effortOptions ?? []
}
