// Шаблоны проектов («типы проектов», docs/architecture.md): именованные наборы настроек, из которых проект
// получает копию при добавлении. Здесь — тип шаблона и встроенные шаблоны; хранение пользовательских и
// миграция старого `projects.json → defaults` — в main (projects.ts).
// Модуль импортирует renderer (выбор типа, редактор шаблонов), поэтому без node-импортов;
// значения импортируются с расширением .ts — тесты гоняются node --test без бандлера.
import type { AgentKind, BoardColumn, Role } from './types'
import type { Workflow } from './workflow'
import { DEFAULT_COLUMNS, DEFAULT_ROLES } from './types.ts'
import { defaultWorkflow, pipelineWorkflow } from './workflow.ts'

/** Режим разрешений Claude Code; тот же список, что `PermissionMode` в apps/desktop/src/shared/ipc.ts. */
export type TemplatePermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

/**
 * Настройки шаблона — те же разделы, что у проекта и `ProjectDefaults` в main. Пустое поле — встроенное
 * значение (DEFAULT_ROLES, DEFAULT_COLUMNS, дефолтный граф по ролям, все агенты, режим `auto`).
 */
export interface ProjectTemplateSettings {
  permissionMode?: TemplatePermissionMode
  /** undefined — все установленные агенты. */
  enabledAgents?: AgentKind[]
  roles?: Role[]
  columns?: BoardColumn[]
  /** Правила доски (`Project.agentRules`): блок `# Правила проекта` в системном промпте агентов доски. */
  agentRules?: string
  workflow?: Workflow
}

/**
 * Шаблон проекта. Проект при добавлении получает КОПИЮ `settings` и запоминает `templateId`; живой связи нет,
 * правка шаблона до проектов не доходит без явного применения.
 */
export interface ProjectTemplate {
  /** Встроенные — осмысленные ('frontend'), пользовательские — сгенерированные. */
  id: string
  title: string
  /** Одна строка в карточке выбора типа. */
  description?: string
  /**
   * Встроенный шаблон из кода: только для чтения (его можно дублировать) и обновляется вместе с приложением,
   * поэтому в projects.json не хранится.
   */
  builtin?: boolean
  settings: ProjectTemplateSettings
}

/** Id встроенного шаблона «Общий» — он же шаблон по умолчанию после миграции старого `defaults`. */
export const GENERAL_TEMPLATE_ID = 'general'

// ---------- роли ----------

/** Роль из DEFAULT_ROLES (копия, чтобы шаблоны не делили объекты с дефолтом). */
function baseRole(id: string): Role {
  const role = DEFAULT_ROLES.find((r) => r.id === id)
  if (!role) throw new Error(`нет роли «${id}» в DEFAULT_ROLES`)
  return { ...role }
}

/** Роль на основе DEFAULT_ROLES с правками шаблона. */
function role(id: string, patch: Partial<Role> = {}): Role {
  return { ...baseRole(id), ...patch }
}

/** Служебные роли: у всех шаблонов одинаковые, из DEFAULT_ROLES. */
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

// ---------- встроенные шаблоны ----------

function generalTemplate(): ProjectTemplate {
  const roles = DEFAULT_ROLES.map((r) => ({ ...r }))
  return {
    id: GENERAL_TEMPLATE_ID,
    title: 'Общий',
    description: 'Программист, ревьюер и QA; ревью агентом, затем мерж.',
    builtin: true,
    settings: { roles, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), workflow: defaultWorkflow(roles) }
  }
}

function frontendTemplate(): ProjectTemplate {
  return {
    id: 'frontend',
    title: 'Фронтенд',
    description: 'Фронтендер и UI-ревьюер; после ревью агентом — проверка человеком глазами.',
    builtin: true,
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
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'human', id: 'eyes', title: 'Посмотреть глазами', instructions: EYES_CHECK }
      ]),
      agentRules: FRONTEND_RULES
    }
  }
}

function backendTemplate(): ProjectTemplate {
  return {
    id: 'backend',
    title: 'Бэкенд',
    description: 'Бэкендер, ревьюер на сильной модели и QA с прогоном тестов перед мержем.',
    builtin: true,
    settings: {
      roles: [
        ...serviceRoles(),
        developer('Бэкендер', BACKEND_PROMPT),
        reviewer(BACKEND_REVIEW_PROMPT, { model: 'opus' }),
        role('qa', { systemPrompt: `Гоняй интеграционные тесты ветки и проверяй поведение ручек, а не только юнит-тесты.\n\n${DONE_REPORT}` })
      ],
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'gate', id: 'tests', roleId: 'qa', title: 'Прогон тестов',
          instructions: 'Прогони тесты проекта (юнит и интеграционные) на ветке задачи. Принимай, только если всё зелёное; иначе верни с выводом упавших тестов.' }
      ]),
      agentRules: BACKEND_RULES
    }
  }
}

function fullstackTemplate(): ProjectTemplate {
  return {
    id: 'fullstack',
    title: 'Fullstack',
    description: 'Отдельные роли фронтенда и бэкенда; задачи фронтенда дополнительно смотрит человек.',
    builtin: true,
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
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'human', id: 'eyes', title: 'Посмотреть глазами', instructions: EYES_CHECK, onlyForRoles: ['frontend'] }
      ]),
      agentRules: `${FRONTEND_RULES}\n${BACKEND_RULES}`
    }
  }
}

function mobileTemplate(): ProjectTemplate {
  return {
    id: 'mobile',
    title: 'Мобилка',
    description: 'Мобильный разработчик и QA на эмуляторе; перед мержем — проверка человеком.',
    builtin: true,
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
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      workflow: pipelineWorkflow([
        { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' },
        { type: 'human', id: 'approve', title: 'Проверка перед мержем',
          instructions: 'Соберите ветку и проверьте на устройстве или эмуляторе, затем примите или верните в работу.' }
      ]),
      agentRules: MOBILE_RULES
    }
  }
}

function autotestsTemplate(): ProjectTemplate {
  return {
    id: 'autotests',
    title: 'Автотесты',
    description: 'Автотестер вместо программиста и ревьюер с фокусом на стабильность тестов.',
    builtin: true,
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
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      workflow: pipelineWorkflow([{ type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' }]),
      agentRules: AUTOTEST_RULES
    }
  }
}

function docsTemplate(): ProjectTemplate {
  return {
    id: 'docs',
    title: 'Документация / аналитика',
    description: 'Автор на быстрой модели; результат принимает человек, без агентного ревью.',
    builtin: true,
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
      columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
      workflow: pipelineWorkflow([
        { type: 'human', id: 'review', title: 'Ревью человеком' }
      ])
    }
  }
}

/**
 * Встроенные шаблоны. Функция, а не константа: каждый вызов отдаёт свежие объекты, и вызывающий код может
 * править копию, не портя встроенные. Порядок — порядок карточек выбора типа.
 */
export function builtinTemplates(): ProjectTemplate[] {
  return [
    generalTemplate(),
    frontendTemplate(),
    backendTemplate(),
    fullstackTemplate(),
    mobileTemplate(),
    autotestsTemplate(),
    docsTemplate()
  ]
}

/** Встроенные шаблоны (снимок `builtinTemplates()`); менять нельзя — для правок бери копию из `builtinTemplates()`. */
export const BUILTIN_TEMPLATES: readonly ProjectTemplate[] = builtinTemplates()

/** Встроенный шаблон по id (свежая копия) или undefined. */
export function builtinTemplate(id: string): ProjectTemplate | undefined {
  return builtinTemplates().find((t) => t.id === id)
}
