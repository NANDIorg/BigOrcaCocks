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
  /**
   * Id сессии, который приложение задаёт агенту заранее (uuid): по нему main находит транскрипт с токенами
   * для статистики. Учитывают только агенты с `acceptsSessionId`.
   */
  sessionId?: string
}

/** Подсказка модели для UI: значение для CLI и необязательная подпись. */
export interface ModelHint {
  value: string
  label?: string
}

/**
 * Модель агента для выбора в UI.
 * `efforts` — уровни рассуждений, допустимые именно для этой модели; нет поля — общий список агента (effortOptions).
 */
export interface ModelOption {
  id: string
  label: string
  efforts?: readonly string[]
}

export interface AgentSpec {
  id: string
  /** Название для UI. */
  title: string
  /** Бинарник, который ищем в PATH. */
  bin: string
  /** Аргументы для получения версии (нет — версию не спрашиваем). */
  versionArgs?: string[]
  /** @deprecated Используй `models`. Подсказки моделей для datalist в UI (не ограничение: можно ввести любую). */
  modelHints?: readonly ModelHint[]
  /** Фиксированный список моделей агента (не ограничение: можно ввести любую). Нет — список берётся из конфига агента или пуст. */
  models?: readonly ModelOption[]
  /** Допустимые уровни effort; [] — агент effort не поддерживает. */
  effortOptions: readonly string[]
  /**
   * Интерактивный CLI не выходит сам после финального ответа, а ждёт ввода. Терминал координатора
   * на таком агенте приложение закрывает после run_done и без сигнала `runs finish` — по долгой тишине
   * (см. `coordinatorsToClose`; с сигналом или при ручном done закрывается терминал любого агента).
   */
  lingersAfterAnswer?: boolean
  /** Агент принимает id сессии от приложения (`AgentInvokeOptions.sessionId`); остальным main его не генерирует. */
  acceptsSessionId?: boolean
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
    models: [
      { id: 'opus', label: 'Opus (актуальный)' },
      { id: 'sonnet', label: 'Sonnet (актуальный)' },
      { id: 'haiku', label: 'Haiku (актуальный)' },
      { id: 'claude-opus-5', label: 'claude-opus-5' },
      { id: 'claude-sonnet-5', label: 'claude-sonnet-5' },
      { id: 'claude-fable-5-1', label: 'claude-fable-5-1' },
      { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' }
    ],
    effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
    acceptsSessionId: true,
    // Режим разрешений проекта + orca-board всегда без вопросов.
    invoke: (system, prompt, opts) => ({
      command: 'claude',
      args: [
        '--permission-mode', opts.permissionMode,
        '--allowedTools', 'Bash(orca-board:*)',
        ...modelFlag('--model', opts.model),
        ...modelFlag('--effort', opts.effort),
        ...modelFlag('--session-id', opts.sessionId),
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
    lingersAfterAnswer: true,
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
  /**
   * Модели агента для выбора в UI: у claude — фиксированный список из реестра, у codex — из ~/.codex/models_cache.json.
   * [] — списка нет, модель в UI вводится свободным текстом.
   */
  models: ModelOption[]
  /**
   * Дефолты агента из его конфига (сейчас только codex: ~/.codex/config.toml).
   * Всегда заполнен: у агента без конфига — {}.
   */
  defaults: { model?: string; effort?: string }
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

/** Модели агента для выбора в UI; [] — модель вводится свободным текстом. */
export function modelOptions(info: AgentInfo): ModelOption[] {
  return info.models
}

/** Уровни effort для выбранной модели: её собственные, если заданы, иначе общий список агента. */
export function effortOptionsFor(info: AgentInfo, model?: string): readonly string[] {
  const own = model ? info.models.find((m) => m.id === model)?.efforts : undefined
  return own ?? effortOptions(info.id)
}

/** Подпись модели по id: label из списка агента, иначе сам id; нет id — undefined. */
export function modelLabel(info: AgentInfo | undefined, modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  return info?.models.find((m) => m.id === modelId)?.label ?? modelId
}

/** Сырой элемент ~/.codex/models_cache.json (только нужные поля). */
interface CodexCacheModel {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  supported_reasoning_levels?: unknown
}

/**
 * Список моделей codex из текста ~/.codex/models_cache.json (`{ models: [{ slug, display_name, supported_reasoning_levels }] }`).
 * Скрытые (`visibility: "hide"`) пропускаются, если это не модель по умолчанию. `defaultModel` (из config.toml)
 * помечается «(по умолчанию)»; если её нет в кэше — добавляется первой. Битый/пустой текст — только дефолтная модель или [].
 */
export function parseCodexModelsCache(text: string | undefined, defaultModel?: string): ModelOption[] {
  let raw: CodexCacheModel[] = []
  try {
    const parsed = text ? (JSON.parse(text) as { models?: unknown }) : undefined
    if (parsed && Array.isArray(parsed.models)) raw = parsed.models as CodexCacheModel[]
  } catch {
    raw = []
  }
  const models: ModelOption[] = []
  for (const m of raw) {
    if (!m || typeof m.slug !== 'string' || !m.slug) continue
    const isDefault = m.slug === defaultModel
    if (m.visibility === 'hide' && !isDefault) continue
    const name = typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((l: unknown) => (l as { effort?: unknown })?.effort)
          .filter((e): e is string => typeof e === 'string' && e.length > 0)
      : []
    models.push({
      id: m.slug,
      label: isDefault ? `${name} (по умолчанию)` : name,
      ...(efforts.length ? { efforts } : {})
    })
  }
  if (defaultModel && !models.some((m) => m.id === defaultModel)) {
    models.unshift({ id: defaultModel, label: `${defaultModel} (по умолчанию)` })
  }
  return models
}
