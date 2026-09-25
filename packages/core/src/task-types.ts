// Типы задач (TaskType, docs/architecture.md → «Типы задач»): тип выбирается у глобальной задачи и задаёт её
// роли, воркфлоу, правила агентов доски и режим разрешений. У проекта остаются колонки и агенты.
// Здесь — модель типа, заготовки типов и единое правило «какой тип у прогона» (`resolveRunType`);
// хранение библиотеки и миграция projects.json — в main.
// Модуль импортирует renderer, поэтому без node-импортов; значения импортируются с расширением .ts.
import type { Role, Run } from './types'
import type { Workflow } from './workflow'
import { DEFAULT_ROLES } from './types.ts'
import { defaultWorkflow, pipelineWorkflow } from './workflow.ts'

/** Режим разрешений Claude Code; тот же список, что `PermissionMode` в apps/desktop/src/shared/ipc.ts. */
export type TaskTypePermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

/**
 * Настройки типа. Колонок и агентов тут нет — они у проекта. Пустое поле — встроенное значение:
 * DEFAULT_ROLES, дефолтный граф по ролям, без правил, режим `auto`.
 */
export interface TaskTypeSettings {
  permissionMode?: TaskTypePermissionMode
  roles?: Role[]
  /** Правила агентов доски: блок `# Правила проекта` в системном промпте (`withAgentRules`). */
  agentRules?: string
  /**
   * Граф воркфлоу. Колонки нод (`node.column`) по доске не проверяются: тип общий для проектов с разными
   * колонками, переход в неизвестную колонку исполнитель пропускает.
   */
  workflow?: Workflow
}

/**
 * Тип задачи. Связь живая: прогон берёт роли типа из библиотеки при каждом запуске агента, так что смена
 * модели роли действует со следующего запуска во всех проектах.
 */
export interface TaskType {
  /**
   * У заготовок (`presetTaskTypes`) — осмысленные ('frontend'; совпадают с id бывших встроенных шаблонов проектов,
   * поэтому старые проекты мигрируют без таблицы соответствий), у созданных человеком — сгенерированные.
   */
  id: string
  title: string
  /** Одна строка в списке выбора типа. */
  description?: string
  settings: TaskTypeSettings
}

/**
 * Снимок типа в прогоне (`Run.taskType`) — страховка, если тип удалят из библиотеки: прогон доработает на
 * ролях и правилах, с которыми был создан. Граф сюда не входит — его снимок лежит в `Run.workflow`.
 */
export interface TaskTypeSnapshot {
  id: string
  title: string
  roles: Role[]
  agentRules?: string
  permissionMode?: TaskTypePermissionMode
}

/** Тип нового прогона для store (`createRun`, `createGlobalTask`): id, снимок и граф для `Run.workflow`. */
export interface RunTypeInput {
  typeId: string
  snapshot: TaskTypeSnapshot
  /** Нет — прогон без снимка графа (граф из будущей версии): пойдёт по графу типа из `runWorkflow`. */
  workflow?: Workflow
}

/** Тип с раскрытыми значениями по умолчанию — то, что нужно воркеру, координатору, воркфлоу и UI. */
export interface ResolvedTaskType {
  typeId: string
  title: string
  roles: Role[]
  /** Пусто — правил нет. */
  agentRules: string
  permissionMode: TaskTypePermissionMode
  /** Граф типа — для прогонов без снимка графа (`Run.workflow`). */
  workflow: Workflow
}

/** Итог разрешения типа прогона (`resolveRunType`). */
export interface ResolvedRunType extends ResolvedTaskType {
  /**
   * Откуда взяли: `type` — тип прогона из библиотеки, `snapshot` — тип удалён, взят снимок `Run.taskType`,
   * `default` — у прогона нет типа («Входящие», старый прогон), взят тип проекта по умолчанию.
   */
  source: 'type' | 'snapshot' | 'default'
}

/**
 * Id заготовки «Программирование»: предпочтительный запасной тип, если тип по умолчанию удалён. Сам тип тоже
 * можно удалить — тогда запасной тип первый в библиотеке (`resolveRunType`, `defaultTaskTypeId` в main).
 */
export const GENERAL_TASK_TYPE_ID = 'general'

/** Описание типа, созданного миграцией из настроек проекта (`taskTypeFromLegacyProject`). */
export const LEGACY_TASK_TYPE_DESCRIPTION = 'Перенесён из настроек проекта при переходе на типы задач'

// ---------- роли ----------

/** Роль из DEFAULT_ROLES (копия, чтобы типы не делили объекты с дефолтом). */
function baseRole(id: string): Role {
  const role = DEFAULT_ROLES.find((r) => r.id === id)
  if (!role) throw new Error(`нет роли «${id}» в DEFAULT_ROLES`)
  return { ...role }
}

/** Роль на основе DEFAULT_ROLES с правками типа. */
function role(id: string, patch: Partial<Role> = {}): Role {
  return { ...baseRole(id), ...patch }
}

/** Служебные роли: у всех заготовок одинаковые, из DEFAULT_ROLES. */
const serviceRoles = (): Role[] => [baseRole('coordinator'), baseRole('assistant')]

/** Общее для всех рабочих ролей: как сдавать работу. */
const DONE_REPORT = 'В сводке `done` перечисли, что изменил и какие проверки запускал с результатом; что не проверял — так и напиши.'

const FRONTEND_PROMPT = [
  'Ты работаешь над фронтендом.',
  '- Компоненты — в стиле соседних: те же подходы к состоянию, стилям и именованию.',
  '- Доступность: семантичная разметка, подписи у полей, работа с клавиатуры, достаточный контраст.',
  '- Адаптив: проверяй узкую ширину и длинные тексты.',
  '- Новые UI-библиотеки и зависимости — только если задача этого требует, с объяснением в коммите.',
  '- Изменения интерфейса проверяй в браузере (dev-сервер), а не только сборкой и тайпчеком.'
].join('\n')

const BACKEND_PROMPT = [
  'Ты работаешь над бэкендом.',
  '- Контракт API (ручки, форматы, коды ошибок) меняй только если это требует задача; изменение опиши в сводке.',
  '- Миграции — новыми файлами и обратимые; уже применённые не правь.',
  '- На каждую новую или изменённую ручку — тест.',
  '- Ошибки обрабатывай явно, с понятным сообщением и без утечки внутренних деталей наружу.'
].join('\n')

const MOBILE_PROMPT = [
  'Ты работаешь над мобильным приложением.',
  '- Следуй платформенным гайдлайнам (Material / Human Interface Guidelines) и стилю соседних экранов.',
  '- Не трогай подписи сборки, версию и build number.',
  '- Сборки долгие, ошибки дорогие: перед сдачей убедись, что проект собирается.'
].join('\n')

const REVIEW_PROMPT = [
  'Проверяй ветку по существу: соответствие задаче, ошибки, пропущенные случаи, тесты.',
  'Отклоняй с конкретным списком «что исправить»; стиль, который не противоречит правилам проекта, — не повод для отказа.'
].join('\n')

const BACKEND_REVIEW_PROMPT = [
  REVIEW_PROMPT,
  'Особое внимание: безопасность (авторизация, инъекции, секреты), транзакции и согласованность данных, N+1 и тяжёлые запросы, обратимость миграций.'
].join('\n')

const FRONTEND_RULES = 'В сводке `done` пиши, запускал ли dev-сервер и что проверил глазами; если не запускал — так и напиши.'

const BACKEND_RULES = [
  'Не меняй публичный контракт API без задачи на это.',
  'Миграции — только новые файлы, уже существующие не правь.'
].join('\n')

const MOBILE_RULES = [
  'Версию приложения и build number не меняй.',
  'Строки и ресурсы — только через ресурсы платформы, без хардкода в коде экранов.'
].join('\n')

const AUTOTEST_RULES = 'Каждый автотест — с id тест-кейса в TMS.'

const developer = (title: string, prompt: string, patch: Partial<Role> = {}): Role =>
  role('developer', { title, systemPrompt: `${prompt}\n\n${DONE_REPORT}`, ...patch })

const reviewer = (prompt = REVIEW_PROMPT, patch: Partial<Role> = {}): Role =>
  role('reviewer', { systemPrompt: prompt, ...patch })

const EYES_CHECK = 'Посмотрите результат глазами: запустите ветку и проверьте интерфейс, затем примите или верните в работу.'

// ---------- заготовки типов ----------

function generalType(): TaskType {
  const roles = DEFAULT_ROLES.map((r) => ({ ...r }))
  return {
    id: GENERAL_TASK_TYPE_ID,
    title: 'Программирование',
    description: 'Программист, ревьюер и QA; ревью агентом, затем мерж.',
    settings: { roles, workflow: defaultWorkflow(roles) }
  }
}

function frontendType(): TaskType {
  return {
    id: 'frontend',
    title: 'Фронтенд',
    description: 'Фронтендер и UI-ревьюер; после ревью агентом — проверка человеком глазами.',
    settings: {
      roles: [
        ...serviceRoles(),
        developer('Фронтендер', FRONTEND_PROMPT),
        reviewer(),
        {
          id: 'ui-review', title: 'UI-ревьюер', agent: 'claude',
          description: 'Смотрит вёрстку и скриншоты: консистентность с дизайн-системой, адаптив, состояния.',
          systemPrompt: [
            'Проверяй интерфейс: вёрстку, скриншоты на разной ширине, пустые и ошибочные состояния.',
            'Сверяй с дизайн-системой проекта: отступы, цвета, типографика, компоненты.',
            DONE_REPORT
          ].join('\n')
        },
        role('qa', { systemPrompt: `Пиши и прогоняй e2e-тесты (Playwright или то, что уже есть в проекте) на пользовательские сценарии.\n\n${DONE_REPORT}` })
      ],
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'human', id: 'eyes', title: 'Посмотреть глазами', instructions: EYES_CHECK }
      ], { roleId: 'developer' }),
      agentRules: FRONTEND_RULES
    }
  }
}

function backendType(): TaskType {
  return {
    id: 'backend',
    title: 'Бэкенд',
    description: 'Бэкендер, ревьюер на сильной модели и QA с прогоном тестов перед мержем.',
    settings: {
      roles: [
        ...serviceRoles(),
        developer('Бэкендер', BACKEND_PROMPT),
        reviewer(BACKEND_REVIEW_PROMPT, { model: 'opus' }),
        role('qa', { systemPrompt: `Гоняй интеграционные тесты ветки и проверяй поведение ручек, а не только юнит-тесты.\n\n${DONE_REPORT}` })
      ],
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'gate', id: 'tests', roleId: 'qa', title: 'Прогон тестов',
          instructions: 'Прогони тесты проекта (юнит и интеграционные) на ветке задачи. Принимай, только если всё зелёное; иначе верни с выводом упавших тестов.' }
      ], { roleId: 'developer' }),
      agentRules: BACKEND_RULES
    }
  }
}

function fullstackType(): TaskType {
  return {
    id: 'fullstack',
    title: 'Фронтенд и бэкенд',
    description: 'Отдельные роли фронтенда и бэкенда; задачи фронтенда дополнительно смотрит человек.',
    settings: {
      roles: [
        role('coordinator', {
          systemPrompt: 'Декомпозируй по слоям: одна задача — одна роль (frontend или backend). Контракт API — отдельная задача, от которой зависят задачи обеих сторон.'
        }),
        baseRole('assistant'),
        { id: 'frontend', title: 'Фронтендер', agent: 'claude', description: 'Пишет клиентскую часть: компоненты, экраны, стили.', systemPrompt: `${FRONTEND_PROMPT}\n\n${DONE_REPORT}` },
        { id: 'backend', title: 'Бэкендер', agent: 'claude', description: 'Пишет серверную часть: API, данные, миграции.', systemPrompt: `${BACKEND_PROMPT}\n\n${DONE_REPORT}` },
        reviewer(),
        role('qa', { systemPrompt: `Пиши и прогоняй тесты: e2e на сценарии интерфейса, интеграционные на ручки.\n\n${DONE_REPORT}` })
      ],
      // Этап «Работа» ведут агенты одной роли, поэтому слои — два этапа по порядку: контракт API — на бэкенде.
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'human', id: 'eyes', title: 'Посмотреть глазами', instructions: EYES_CHECK }
      ], {
        work: [
          { id: 'backend', roleId: 'backend', title: 'Бэкенд' },
          { id: 'work', roleId: 'frontend', title: 'Фронтенд' }
        ]
      }),
      agentRules: `${FRONTEND_RULES}\n${BACKEND_RULES}`
    }
  }
}

function mobileType(): TaskType {
  return {
    id: 'mobile',
    title: 'Мобильная разработка',
    description: 'Мобильный разработчик и QA на эмуляторе; перед мержем — проверка человеком.',
    settings: {
      roles: [
        ...serviceRoles(),
        developer('Мобильный разработчик', MOBILE_PROMPT, { effort: 'high' }),
        reviewer(),
        role('qa', {
          effort: 'high',
          systemPrompt: `Проверяй на эмуляторе, минимум на двух размерах экрана (маленький телефон и большой).\n\n${DONE_REPORT}`
        })
      ],
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'human', id: 'approve', title: 'Проверка перед мержем',
          instructions: 'Соберите ветку и проверьте на устройстве или эмуляторе, затем примите или верните в работу.' }
      ], { roleId: 'developer' }),
      agentRules: MOBILE_RULES
    }
  }
}

function autotestsType(): TaskType {
  return {
    id: 'autotests',
    title: 'QA: автотесты',
    description: 'Автотестер вместо программиста и ревьюер с фокусом на стабильность тестов.',
    settings: {
      roles: [
        ...serviceRoles(),
        {
          id: 'autotester', title: 'Автотестер', agent: 'claude',
          description: 'Пишет и чинит автотесты, продовый код не меняет.',
          systemPrompt: [
            'Ты пишешь автотесты.',
            '- Продовый код не правь: если тест упирается в дефект, оставь красный тест и свяжи его с тикетом.',
            '- Стабильность: без sleep, ожидания — по условию; ретраи — только явные и обоснованные.',
            '- Данные теста изолированы: создаёшь сам и убираешь за собой.',
            '',
            DONE_REPORT
          ].join('\n')
        },
        reviewer(`${REVIEW_PROMPT}\nОсобое внимание: флаки (ожидания, гонки), изоляция данных, читаемость шагов теста.`)
      ],
      workflow: pipelineWorkflow([{ type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' }], { roleId: 'autotester' }),
      agentRules: AUTOTEST_RULES
    }
  }
}

function docsType(): TaskType {
  return {
    id: 'docs',
    title: 'Документация',
    description: 'Автор на быстрой модели; результат принимает человек, без агентного ревью.',
    settings: {
      roles: [
        ...serviceRoles(),
        {
          id: 'writer', title: 'Автор', agent: 'claude', model: 'sonnet',
          description: 'Пишет документацию и аналитику, отвечает на вопросы по проекту.',
          systemPrompt: [
            'Пиши по существу: сначала вывод, потом обоснование; факты — со ссылкой на источник (файл, строка, документ).',
            'Если задача — ответ, а не правка файлов, сдавай ответом, а не коммитом.'
          ].join('\n')
        },
        reviewer()
      ],
      workflow: pipelineWorkflow([
        { type: 'human', id: 'review', title: 'Ревью человеком' }
      ], { roleId: 'writer' })
    }
  }
}

/**
 * Заготовки типов — обычные типы, которые main один раз кладёт в библиотеку нового пользователя (`seededTaskTypes`
 * в apps/desktop/src/main/projects.ts). Дальше они живут в projects.json наравне с созданными человеком: правятся,
 * удаляются и не возвращаются после удаления; новая версия приложения их не перетирает. Функция, а не константа:
 * каждый вызов отдаёт свежие объекты. Порядок — порядок в библиотеке после засева. Id менять нельзя: на них
 * ссылаются старые проекты и прогоны, а засев сверяет по ним уже существующие типы.
 */
export function presetTaskTypes(): TaskType[] {
  return [generalType(), frontendType(), backendType(), fullstackType(), mobileType(), autotestsType(), docsType()]
}

/** Заготовка по id (свежая копия) или undefined. */
export function presetTaskType(id: string): TaskType | undefined {
  return presetTaskTypes().find((t) => t.id === id)
}

/** Тип с раскрытыми значениями по умолчанию; роли и граф — копии, их можно править. */
export function resolveTaskType(t: TaskType): ResolvedTaskType {
  const roles = copy(t.settings.roles ?? DEFAULT_ROLES)
  return {
    typeId: t.id,
    title: t.title,
    roles,
    agentRules: t.settings.agentRules ?? '',
    permissionMode: t.settings.permissionMode ?? 'auto',
    workflow: t.settings.workflow ? copy(t.settings.workflow) : defaultWorkflow(roles)
  }
}

/** Снимок типа для `Run.taskType`. */
export function snapshotTaskType(t: TaskType): TaskTypeSnapshot {
  const r = resolveTaskType(t)
  return {
    id: r.typeId,
    title: r.title,
    roles: r.roles,
    ...(r.agentRules ? { agentRules: r.agentRules } : {}),
    ...(t.settings.permissionMode ? { permissionMode: t.settings.permissionMode } : {})
  }
}

/** Тип нового прогона для store: снимок и граф типа. */
export function runTypeInput(t: TaskType): RunTypeInput {
  return { typeId: t.id, snapshot: snapshotTaskType(t), workflow: resolveTaskType(t).workflow }
}

/**
 * Какой тип у прогона — единственное место этого правила (его зовут main и renderer):
 * `run.typeId` → тип из библиотеки `types` → снимок `run.taskType` → тип проекта по умолчанию → «Программирование»
 * → первый тип библиотеки. Заготовка «Программирование» из кода — только если библиотека пуста (main этого не
 * допускает, но renderer со старым main может передать пустой список).
 * Нет прогона («Входящие», задача без глобальной) — тип проекта по умолчанию.
 */
export function resolveRunType(
  run: Pick<Run, 'typeId' | 'taskType'> | undefined,
  types: readonly TaskType[],
  projectDefaultTypeId: string | undefined
): ResolvedRunType {
  if (run?.typeId !== undefined) {
    const own = types.find((t) => t.id === run.typeId)
    if (own) return { ...resolveTaskType(own), source: 'type' }
    if (run.taskType) {
      const snap = run.taskType
      const roles = copy(snap.roles)
      return {
        typeId: run.typeId,
        title: snap.title,
        roles,
        agentRules: snap.agentRules ?? '',
        permissionMode: snap.permissionMode ?? 'auto',
        workflow: defaultWorkflow(roles),
        source: 'snapshot'
      }
    }
  }
  const fallback =
    (projectDefaultTypeId !== undefined ? types.find((t) => t.id === projectDefaultTypeId) : undefined) ??
    types.find((t) => t.id === GENERAL_TASK_TYPE_ID) ??
    types[0] ??
    presetTaskType(GENERAL_TASK_TYPE_ID)!
  return { ...resolveTaskType(fallback), source: 'default' }
}

/**
 * Проект старого формата (роли, граф, правила и разрешения в самом проекте) → пользовательский тип
 * «<имя проекта>». Незаданный граф фиксируется как дефолтный по ролям проекта: иначе он «поехал» бы при
 * правке ролей типа. Уникальность `title` в библиотеке обеспечивает вызывающая миграция в main.
 */
export function taskTypeFromLegacyProject(
  p: { name: string; roles?: Role[]; workflow?: Workflow; agentRules?: string; permissionMode?: TaskTypePermissionMode },
  id: string
): TaskType {
  const roles = copy(p.roles ?? DEFAULT_ROLES)
  const agentRules = p.agentRules?.trim() ? p.agentRules : undefined
  return {
    id,
    title: p.name,
    description: LEGACY_TASK_TYPE_DESCRIPTION,
    settings: {
      roles,
      workflow: p.workflow ? copy(p.workflow) : defaultWorkflow(roles),
      ...(agentRules !== undefined ? { agentRules } : {}),
      ...(p.permissionMode ? { permissionMode: p.permissionMode } : {})
    }
  }
}

/** Глубокая копия JSON-данных (роли, граф): результат можно править, не портя библиотеку и снимки. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
