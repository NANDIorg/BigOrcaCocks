// Воркфлоу: граф этапов, которые проходит глобальная задача (версия 2, `Run.stage`) или, в старом формате, каждая
// рабочая подзадача (версия 1, `Task.stage`) — от первого запуска до конца. Контракт версии 2 — docs/workflow.md.
// Модуль импортирует renderer (живая валидация в редакторе), поэтому без node-импортов;
// значения импортируются с расширением .ts — тесты гоняются node --test без бандлера.
import type { BoardColumn, Role, Task } from './types'
import { isTaskRole } from './prompts.ts'

/**
 * Версия формата графа. Меняется при несовместимой правке типов ниже, вместе с `migrateWorkflow`.
 * 2 — граф идёт по глобальной задаче (`Run.stage`), а не по подзадачам: `work` ведёт координатор, `merge` — слияние
 * ветки глобальной задачи в базовую. 1 — граф по подзадачам (`WORKFLOW_VERSION_TASK_SCOPE`), доживает у старых прогонов.
 */
export const WORKFLOW_VERSION = 2

/** Версия графа, который идёт по подзадачам (движок до воркфлоу глобальной задачи). Так же помечены `legacyPipelineWorkflow` и `legacyDefaultWorkflow`. */
export const WORKFLOW_VERSION_TASK_SCOPE = 1

/** Исход этапа: по нему выбирается ребро. У каждого типа ноды — фиксированный набор портов (`WF_PORTS`). */
export type WfOutcome = 'next' | 'accept' | 'reject' | 'yes' | 'no' | 'ok' | 'conflict' | 'error'

/**
 * Исход любого ребра (`WfEdge.outcome`): фиксированный `WfOutcome` или id варианта ноды `decision`. Порты ноды —
 * `wfPorts(node)`. `WfOutcome` остаётся там, где набор исходов закрыт (`Record<WfOutcome, …>` в редакторе).
 */
export type WfPort = string

/**
 * Вариант ветки ноды `decision`. `id` — порт (`WfEdge.outcome`) и часть `edge.id` и CSS-класса на холсте, поэтому по
 * маске `WF_DECISION_OPTION_ID` и после создания не меняется: переименование `label` рёбра не ломает. `label` — что
 * видят агент и человек, `description` — пояснение к варианту (в промпте агента и подсказке кнопки в Инбоксе).
 */
export interface WfDecisionOption {
  id: string
  label: string
  description?: string
}

/** Маска id варианта ноды `decision`. */
export const WF_DECISION_OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** Сколько вариантов у ноды `decision`: меньше двух — не развилка, больше восьми не помещается на порты ноды. */
export const WF_DECISION_MIN_OPTIONS = 2
export const WF_DECISION_MAX_OPTIONS = 8

/**
 * Операции ноды `git` (v1). Только то, что укладывается в модель «один worktree на ветку задачи»
 * (`orca/<taskId>`, слияние — нода `merge`): без merge/rebase/reset, удаления веток и `push --force`.
 * Подробности и обоснование — `docs/workflow.md` («Нода Git»).
 */
export const WF_GIT_OPERATIONS = ['create_branch', 'checkout', 'commit', 'push'] as const
export type WfGitOperation = (typeof WF_GIT_OPERATIONS)[number]

/** Remote по умолчанию для `push`. */
export const WF_GIT_DEFAULT_REMOTE = 'origin'

/**
 * Условие из закрытого списка предикатов. Произвольных выражений нет намеренно: их не провалидировать
 * и не показать в редакторе.
 */
export type WfCondition =
  /** Задача (в версии 2 — глобальная, по `Run.stage.visits`) заходила в ноду `node` не меньше `atLeast` раз (лимит повторов). */
  | { kind: 'attempts'; node: string; atLeast: number }
  /** Роль рабочей задачи — одна из `roleIds`. Только граф по подзадачам: у глобальной задачи роли нет, в графе версии 2 это ошибка. */
  | { kind: 'role'; roleIds: string[] }
  /** Все файлы ветки подходят под маску. Зарезервировано под v2: пока не исполняется и не проходит валидацию. */
  | { kind: 'files'; glob: string }

/**
 * Что воркер этапа «Работа» сдаёт на показ человеку (макеты, скриншоты, описание вариантов): текст задания
 * и обязателен ли показ. Смотрит показ человек на следующей ноде `human` (запрос approval).
 */
export interface WfShowcase {
  what: string
  /** Без показа `orca-board done` не пройдёт (`TaskStore.finishDispatch`). */
  required?: boolean
}

interface WfNodeBase {
  id: string
  /** Позиция на холсте редактора. */
  x: number
  y: number
  title?: string
  /** Колонка доски, в которой стоит задача на этом этапе; нет — колонка по умолчанию для этапа. */
  column?: string
  /**
   * Из какого шаблона (`WfNodeTemplate.id`) нода вставлена: вставка — копия, ссылка нужна только редактору для
   * «Обновить из шаблона». Исполнитель и валидация содержимого её не читают.
   */
  templateId?: string
}

/** Операция и её параметры; лишние для операции поля игнорируются (валидация предупреждает). */
export interface WfGitParams {
  operation: WfGitOperation
  /** Шаблон имени ветки (`create_branch` — новая, `checkout` — существующая). Подстановки: `{taskId}`, `{slug}`. */
  branch?: string
  /** Откуда создать ветку (`create_branch`); пусто — текущая ветка корня репозитория (та, куда сольёт `merge`). */
  base?: string
  /** Шаблон сообщения коммита (`commit`). Подстановки: `{taskId}`, `{slug}`, `{title}`. */
  message?: string
  /** Remote для `push`; пусто — `origin` (`WF_GIT_DEFAULT_REMOTE`). */
  remote?: string
}

export type WfNode = WfNodeBase &
  (
    | { type: 'start' }
    /**
     * Работа. В графе глобальной задачи (версия 2) роли этапа необязательны: `roleIds` — ноль, одна или несколько
     * ролей, агентов которых координатор набирает по `stage_started`. Без ролей он сам выбирает роль каждой
     * подзадачи из рабочих ролей типа (одна нода покрывает и фронт, и бэк); с ролями — только из списка. Читать
     * список нужно через `wfWorkRoleIds`. `roleId` — одна роль в форме версии 1 (и первой правки версии 2): читается
     * как список из одной роли, `migrateWorkflow` переносит её в `roleIds`; в графе по подзадачам (версия 1)
     * это роль задачи. `instructions` и `showcase` попадают в промпт воркера разделом «Этап» (`workerTaskPrompt`);
     * нормализованный вид — `wfWorkStage`.
     *
     * `subflow` — путь, который проходит каждая подзадача этапа (только в графе версии 2). Нет — путь по умолчанию
     * `defaultSubflow()`. Исполняет его движок по подзадачам (`Task.stage`, `TaskStore.advanceStage`).
     */
    | { type: 'work'; roleIds?: string[]; /** @deprecated одна роль версии 1, см. выше */ roleId?: string; instructions?: string; showcase?: WfShowcase; subflow?: WfSubflow }
    /**
     * Вопрос человеку: агент роли ноды задаёт вопросы штатным `orca-board ask`, они идут человеку, минуя
     * координатора; ответы попадают в промпт следующих этапов. Код на этапе не меняется. `instructions` — о чём
     * спросить, обязательны. В графе глобальной задачи роль обязательна, а задачу создаёт приложение (одна); в графе по
     * подзадачам пусто — роль задачи, и роль этапа не становится ролью задачи (в отличие от `work`).
     */
    | { type: 'ask'; roleId?: string; instructions: string }
    /**
     * Гейт-агент: отдельная задача-проверка; исход — accept/reject. В графе глобальной задачи проверяет ветку
     * глобальной задачи целиком против `RunGit.base`, в графе по подзадачам — ветку рабочей задачи.
     */
    | { type: 'gate'; roleId: string; instructions?: string }
    /**
     * Гейт-человек: запрос в Инбоксе «Принять» / «Вернуть». В графе глобальной задачи — approval уровня прогона
     * (без задачи, `TaskStore.requestRunApproval`), карточка встаёт на «Проверку».
     */
    | { type: 'human'; instructions?: string }
    /**
     * Решение ИИ: развилка, где ветку выбирает агент роли `roleId`, отвечая на `question` по смыслу задачи
     * (`decision choose`); не может — решает человек в Инбоксе с теми же вариантами (запрос `decision`). Порты — id
     * `options` (`wfPorts`), по ребру на вариант. `instructions` — критерии «как решать». Только граф глобальной
     * задачи, в пути подзадачи запрещена. Контракт — docs/workflow.md, «Нода «Решение ИИ»».
     */
    | { type: 'decision'; question: string; roleId: string; options: WfDecisionOption[]; instructions?: string }
    | { type: 'condition'; test: WfCondition }
    /**
     * Слияние. В графе глобальной задачи — ветки глобальной задачи в `RunGit.base` локально (в защищённые ветки — нет:
     * `workflow_blocked`); в графе по подзадачам — ветки подзадачи в ветку глобальной задачи.
     */
    | { type: 'merge' }
    /**
     * Git-операция без агента: приложение само выполняет `operation` в worktree (глобальной задачи в версии 2, задачи в
     * версии 1). Какие поля нужны какой операции — `wfGitFieldUse`; в `branch` и `message` работают подстановки
     * (`renderGitTemplate`). В графе глобальной задачи доступны только `commit` и `push`.
     */
    | WfGitParams & { type: 'git' }
    /** Конец. `merged` — для отображения: задача пришла сюда со слитой веткой. */
    | { type: 'end'; merged?: boolean }
  )

export type WfNodeType = WfNode['type']

export interface WfEdge {
  id: string
  from: string
  outcome: WfPort
  to: string
}

export interface Workflow {
  version: number
  nodes: WfNode[]
  edges: WfEdge[]
}

/**
 * Путь подзадачи этапа «Работа» (`work.subflow`): граф без версии — версия у внешнего графа, а сам путь читается
 * как часть графа версии 2. Внутри ноды работают как в графе по подзадачам (`WfContext.scope: 'subtask'`): `work` —
 * воркер подзадачи, `gate` — проверка ветки подзадачи, `merge` — ветка подзадачи в ветку глобальной задачи. Нельзя
 * `ask` и вложенный `subflow` (глубина 1). Контракт — docs/workflow.md, «Путь подзадачи».
 */
export interface WfSubflow {
  nodes: WfNode[]
  edges: WfEdge[]
}

/**
 * Порты по типу ноды: для каждого исхода из списка должно быть ровно одно исходящее ребро. У `decision` порты свои у
 * каждой ноды (id вариантов) — здесь пусто, читать порты ноды нужно через `wfPorts`. Ключ `decision` всё равно нужен:
 * по ключам этой таблицы валидация узнаёт известные типы.
 */
export const WF_PORTS: Record<WfNodeType, WfOutcome[]> = {
  start: ['next'],
  work: ['next'],
  ask: ['next'],
  gate: ['accept', 'reject'],
  human: ['accept', 'reject'],
  decision: [],
  condition: ['yes', 'no'],
  merge: ['ok', 'conflict'],
  git: ['ok', 'error'],
  end: []
}

const NODE_TYPE_TITLES: Record<WfNodeType, string> = {
  start: 'Старт',
  work: 'Работа',
  ask: 'Вопрос человеку',
  gate: 'Проверка',
  human: 'Человек',
  decision: 'Решение ИИ',
  condition: 'Условие',
  merge: 'Мерж',
  git: 'Git',
  end: 'Конец'
}

/** Порты ноды: id вариантов у `decision`, у остальных типов — `WF_PORTS`. Варианты не массив (граф в обход валидации) — портов нет. */
export function wfPorts(node: WfNode): WfPort[] {
  if (node.type === 'decision') return Array.isArray(node.options) ? node.options.map((o) => o.id) : []
  return WF_PORTS[node.type] ?? []
}

/** Название ноды для сообщений и UI: заданное пользователем или по типу. */
export function wfNodeTitle(node: WfNode): string {
  return node.title?.trim() || NODE_TYPE_TITLES[node.type] || node.id
}

/**
 * Этап «Работа» или «Вопрос человеку» для промпта воркера и проверки `done`: без пустых полей, тексты обрезаны
 * по краям. `showcase` бывает только у `work`.
 */
export interface WfWorkStage {
  nodeId: string
  type: 'work' | 'ask'
  title: string
  /** Роль этапа «Вопрос человеку» (в графе глобальной задачи обязательна; у графа по подзадачам — нет). */
  roleId?: string
  /** Роли этапа «Работа» (`wfWorkRoleIds`); нет поля — этап не ограничивает роли подзадач. */
  roleIds?: string[]
  instructions?: string
  showcase?: WfShowcase
}

/**
 * Роли ноды «Работа»: `roleIds` без пустых и повторов; нет — прежняя одна роль `roleId` как список из одной; ни того
 * ни другого — пусто (любые рабочие роли типа). Граф приходит из файла или UI, поэтому поля читаются без доверия к типам.
 */
export function wfWorkRoleIds(node: { roleIds?: unknown; roleId?: unknown }): string[] {
  const raw: unknown[] = Array.isArray(node.roleIds) ? node.roleIds : node.roleId !== undefined ? [node.roleId] : []
  return [...new Set(raw.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim()))]
}

/**
 * Нормализованный показ ноды: `what` без пробелов по краям, `required` только `true`. Пустой `what` — показа нет:
 * граф с такой нодой отвергает `validateWorkflow`, но старый или битый граф исполнитель не должен ронять.
 */
export function wfShowcase(node: WfNode): WfShowcase | undefined {
  if (node.type !== 'work' || !node.showcase || typeof node.showcase !== 'object') return undefined
  const what = typeof node.showcase.what === 'string' ? node.showcase.what.trim() : ''
  if (!what) return undefined
  return node.showcase.required === true ? { what, required: true } : { what }
}

/** Этап `nodeId`, если это нода «Работа» или «Вопрос человеку»; иначе (нет ноды, другой тип) — undefined. */
export function wfWorkStage(wf: Workflow, nodeId: string): WfWorkStage | undefined {
  const node = wf.nodes.find((n) => n.id === nodeId)
  if (!node || (node.type !== 'work' && node.type !== 'ask')) return undefined
  const instructions = typeof node.instructions === 'string' ? node.instructions.trim() : ''
  const showcase = wfShowcase(node)
  const roleIds = node.type === 'work' ? wfWorkRoleIds(node) : []
  return {
    nodeId: node.id, type: node.type, title: wfNodeTitle(node),
    ...(node.type === 'ask' && node.roleId ? { roleId: node.roleId } : {}),
    ...(roleIds.length > 0 ? { roleIds } : {}),
    ...(instructions ? { instructions } : {}),
    ...(showcase ? { showcase } : {})
  }
}

// ---------- нода git: параметры и шаблоны ----------

/** Поля ноды `git`, о которых спрашивает операция. */
export type WfGitField = 'branch' | 'base' | 'message' | 'remote'

/**
 * Какие поля использует операция: `required` — без них граф не пройдёт валидацию, `optional` — есть значение
 * по умолчанию. Остальные поля операцией игнорируются (валидация предупреждает). Единый источник для
 * валидации, исполнителя и формы редактора.
 */
export const WF_GIT_FIELD_USE: Readonly<Record<WfGitOperation, { required: readonly WfGitField[]; optional: readonly WfGitField[] }>> = {
  create_branch: { required: ['branch'], optional: ['base'] },
  checkout: { required: ['branch'], optional: [] },
  commit: { required: ['message'], optional: [] },
  push: { required: [], optional: ['remote'] }
}

/** Подстановки шаблонов: в имени ветки — без `{title}` (в названии задачи пробелы и кириллица). */
export const WF_GIT_BRANCH_PLACEHOLDERS = ['taskId', 'slug'] as const
export const WF_GIT_MESSAGE_PLACEHOLDERS = ['taskId', 'slug', 'title'] as const

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
}

/**
 * Слаг из названия задачи для имени ветки: латиница в нижнем регистре, кириллица транслитерируется, всё прочее —
 * дефис; не длиннее 40 символов; пустое название — `task`. Детерминирован: два вызова с одним названием дают одну ветку.
 */
export function wfGitSlug(title: string): string {
  const latin = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('')
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '')
  return slug || 'task'
}

/** Значения подстановок для задачи. */
export function wfGitVars(task: Pick<Task, 'id' | 'title'>): Record<string, string> {
  return { taskId: task.id, slug: wfGitSlug(task.title), title: task.title.trim() }
}

/** Имена подстановок `{…}` шаблона в порядке появления (с повторами). */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1])
}

/** Подставляет значения в шаблон; неизвестная подстановка остаётся как есть (её ловит `validateWorkflow`). */
export function renderGitTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^{}]*)\}/g, (all, name: string) => (name in vars ? vars[name] : all))
}

/**
 * Имя ветки допустимо для git (упрощённый `git check-ref-format --branch`): не пустое, без пробелов и
 * управляющих символов, без `~ ^ : ? * [ \ { }`, без `..`, `//`, `@{`, не начинается с `-` или `/`, не кончается
 * `/`, `.` или `.lock`, части между `/` не начинаются с `.`. Возвращает true, если имя годится.
 */
export function isValidGitBranchName(name: string): boolean {
  if (!name || name === '@') return false
  if (/[\s\x00-\x1f\x7f~^:?*[\\{}]/.test(name)) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/** Remote — имя без пробелов и не флаг (`-…`): подставляется в `git push <remote>`. */
export function isValidGitRemoteName(name: string): boolean {
  return !!name && !/[\s\x00-\x1f\x7f]/.test(name) && !name.startsWith('-')
}

/**
 * Шаблон имени ветки после подстановки: годится ли результат. Проверяет `validateWorkflow` (с образцом
 * значений) и исполнитель (с настоящими) — слаг и id гарантируют допустимость, а вот шаблон вроде `feat/{slug}.`
 * или с пробелом — нет.
 */
export function gitBranchTemplateValid(template: string, vars: Readonly<Record<string, string>>): boolean {
  return isValidGitBranchName(renderGitTemplate(template, vars))
}

// ---------- дефолт и миграция ----------

/**
 * Проверка в линейном графе глобальной задачи (`pipelineWorkflow`): гейт-агент проверяет ветку глобальной
 * задачи целиком, `human` — решение человека. Отказ любой проверки возвращает в последнюю «Работу».
 */
export type WfPipelineCheck =
  | { type: 'gate'; id: string; roleId: string; title?: string; instructions?: string }
  | { type: 'human'; id: string; title?: string; instructions?: string }

/** Этап «Работа» линейного графа: id ноды, роли агентов (нет — любые рабочие роли типа) и тексты. */
export interface WfPipelineWork {
  id: string
  roleIds?: string[]
  title?: string
  instructions?: string
}

const PIPELINE_STEP_X = 220
/** Id и название финальной проверки человеком, которую `pipelineWorkflow` добавляет, если последняя проверка — не `human`. */
export const PIPELINE_FINAL_CHECK_ID = 'check'
// Не «Проверка»: так называется нода `gate` по умолчанию, и перевод встроенных названий узнаёт их по тексту.
const PIPELINE_FINAL_CHECK_TITLE = 'Проверка человеком'
const PIPELINE_WORK_TITLE = 'Реализация'

/**
 * Роль по умолчанию для нод с обязательной ролью (`ask`, миграция v1 → v2): `developer`, иначе первая рабочая (не служебная и не
 * `reviewer`) роль, иначе `reviewer` (других нет), иначе `developer` — валидация укажет, что роли в проекте нет.
 */
export function defaultWorkRole(roles: readonly Pick<Role, 'id'>[]): string {
  const ids = roles.map((r) => r.id).filter(isTaskRole)
  if (ids.includes('developer')) return 'developer'
  return ids.find((id) => id !== 'reviewer') ?? ids[0] ?? 'developer'
}

/**
 * Конструктор типового графа глобальной задачи: старт → работа (одна или несколько по порядку) → проверки по
 * порядку → «Проверка» человеком → конец. Отказ любой проверки возвращает в последнюю «Работу». Финальная
 * проверка человеком — нода `human` `check` — добавляется, если последняя из `checks` не `human`: без неё
 * результат ушёл бы в «Сделано» без человека. Из него собраны `defaultWorkflow` и графы заготовок типов задач
 * (task-types.ts), поэтому id стабильны: `work`, `end`, `check`, `e_<нода>_<исход>`.
 */
export function pipelineWorkflow(
  checks: readonly WfPipelineCheck[],
  opts: { work?: readonly WfPipelineWork[]; roleIds?: string[] } = {}
): Workflow {
  const works: readonly WfPipelineWork[] = opts.work?.length ? opts.work : [{ id: 'work', ...(opts.roleIds?.length ? { roleIds: opts.roleIds } : {}) }]
  const nodes: WfNode[] = [{ id: 'start', type: 'start', x: 0, y: 0 }]
  const edges: WfEdge[] = []
  let x = 0
  // Куда ведёт выход предыдущего шага: его выход задаётся, когда известен следующий шаг.
  let link: (to: string) => void = (to) => edges.push({ id: 'e_start', from: 'start', outcome: 'next', to })
  const back = works[works.length - 1].id
  for (const w of works) {
    x += PIPELINE_STEP_X
    link(w.id)
    nodes.push({
      id: w.id, type: 'work', title: w.title ?? PIPELINE_WORK_TITLE, x, y: 0,
      ...(w.roleIds?.length ? { roleIds: [...w.roleIds] } : {}),
      ...(w.instructions ? { instructions: w.instructions } : {})
    })
    link = (to) => edges.push({ id: `e_${w.id}`, from: w.id, outcome: 'next', to })
  }
  const all: readonly WfPipelineCheck[] = checks.at(-1)?.type === 'human'
    ? checks
    : [...checks, { type: 'human', id: PIPELINE_FINAL_CHECK_ID, title: PIPELINE_FINAL_CHECK_TITLE }]
  for (const c of all) {
    x += PIPELINE_STEP_X
    link(c.id)
    const text = { ...(c.title ? { title: c.title } : {}), ...(c.instructions ? { instructions: c.instructions } : {}) }
    nodes.push(c.type === 'gate'
      ? { id: c.id, type: 'gate', roleId: c.roleId, ...text, x, y: 0 }
      : { id: c.id, type: 'human', ...text, x, y: 0 })
    const from = c.id
    link = (to) => edges.push(
      { id: `e_${from}_accept`, from, outcome: 'accept', to },
      { id: `e_${from}_reject`, from, outcome: 'reject', to: back }
    )
  }
  x += PIPELINE_STEP_X
  link('end')
  nodes.push({ id: 'end', type: 'end', x, y: 0 })
  return { version: WORKFLOW_VERSION, nodes, edges }
}

/**
 * Дефолтный граф глобальной задачи, повторяющий прежнее поведение (работа → ревью → «Проверка» человеком):
 * старт → «Реализация» без роли (координатор сам выбирает роли подзадач из рабочих ролей типа) → ревью агентом,
 * если есть роль `reviewer` → «Проверка» человеком (accept → конец, reject → «Реализация») → конец. Слияния в
 * базовую ветку нет: это решает человек графом типа.
 */
export function defaultWorkflow(roles: readonly Pick<Role, 'id'>[]): Workflow {
  const hasReviewer = roles.some((r) => r.id === 'reviewer')
  return pipelineWorkflow(hasReviewer ? [{ type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' }] : [])
}

/**
 * Проверка в линейном графе по подзадачам (`legacyPipelineWorkflow`). `onlyForRoles` — проверка только для задач
 * этих ролей: перед ней ставится условие по роли, остальные задачи её пропускают.
 */
export type WfLegacyPipelineCheck =
  | { type: 'gate'; id: string; roleId: string; title?: string; instructions?: string; onlyForRoles?: string[] }
  | { type: 'human'; id: string; title?: string; instructions?: string; onlyForRoles?: string[] }

const CONFLICT_INSTRUCTIONS =
  'Ветка не сливается без конфликтов. Разрешите конфликт в ветке задачи и примите её или верните в работу.'

/**
 * Путь подзадачи по умолчанию — у ноды `work` без `subflow`: воркер → мерж в ветку глобальной задачи → конец;
 * конфликт мержа уходит человеку («Принять» — снова мерж, «Вернуть» — в работу). Это тот же путь, что зашит в движке
 * прогона (`subtaskDone` → `mergeSubtask`). id стабильны: `start`, `work`, `merge`, `conflict`, `end`, `e_<нода>_<исход>`.
 * Каждый вызов возвращает новый граф: вызывающий код может его править.
 */
export function defaultSubflow(): WfSubflow {
  return {
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'work', type: 'work', x: PIPELINE_STEP_X, y: 0 },
      { id: 'merge', type: 'merge', x: PIPELINE_STEP_X * 2, y: 0 },
      { id: 'end', type: 'end', merged: true, x: PIPELINE_STEP_X * 3, y: 0 },
      { id: 'conflict', type: 'human', title: 'Конфликт мержа', instructions: CONFLICT_INSTRUCTIONS, x: PIPELINE_STEP_X * 2, y: 180 }
    ],
    edges: [
      { id: 'e_start_next', from: 'start', outcome: 'next', to: 'work' },
      { id: 'e_work_next', from: 'work', outcome: 'next', to: 'merge' },
      { id: 'e_merge_ok', from: 'merge', outcome: 'ok', to: 'end' },
      { id: 'e_merge_conflict', from: 'merge', outcome: 'conflict', to: 'conflict' },
      { id: 'e_conflict_accept', from: 'conflict', outcome: 'accept', to: 'merge' },
      { id: 'e_conflict_reject', from: 'conflict', outcome: 'reject', to: 'work' }
    ]
  }
}

/**
 * Типовой граф **по подзадачам** (версия 1): старт → работа → проверки → мерж → конец. Отказ проверки возвращает в
 * работу, конфликт мержа уходит человеку. Только для прогонов старого движка (`Run.workflowScope` не задан) и
 * «Входящих» — новые прогоны идут по `pipelineWorkflow`. id стабильны: `work`, `merge`, `end`, `conflict`,
 * `e_<нода>_<исход>`; условие роли — `<id проверки>_if`.
 */
export function legacyPipelineWorkflow(checks: readonly WfLegacyPipelineCheck[]): Workflow {
  const nodes: WfNode[] = [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'work', type: 'work', title: 'Работа', x: PIPELINE_STEP_X, y: 0 }
  ]
  const edges: WfEdge[] = [{ id: 'e_start', from: 'start', outcome: 'next', to: 'work' }]
  let x = PIPELINE_STEP_X
  let link: (to: string) => void = (to) => edges.push({ id: 'e_work', from: 'work', outcome: 'next', to })
  for (const c of checks) {
    let entry: string = c.id
    let skip: string | undefined
    if (c.onlyForRoles?.length) {
      skip = `${c.id}_if`
      entry = skip
      x += PIPELINE_STEP_X
      nodes.push({ id: skip, type: 'condition', title: c.title ? `${c.title}?` : 'Условие по роли', test: { kind: 'role', roleIds: [...c.onlyForRoles] }, x, y: 0 })
    }
    link(entry)
    if (skip) edges.push({ id: `e_${skip}_yes`, from: skip, outcome: 'yes', to: c.id })
    x += PIPELINE_STEP_X
    const text = { ...(c.title ? { title: c.title } : {}), ...(c.instructions ? { instructions: c.instructions } : {}) }
    nodes.push(c.type === 'gate'
      ? { id: c.id, type: 'gate', roleId: c.roleId, ...text, x, y: 0 }
      : { id: c.id, type: 'human', ...text, x, y: 0 })
    const from = c.id
    const skipFrom = skip
    link = (to) => {
      edges.push(
        { id: `e_${from}_accept`, from, outcome: 'accept', to },
        { id: `e_${from}_reject`, from, outcome: 'reject', to: 'work' }
      )
      if (skipFrom) edges.push({ id: `e_${skipFrom}_no`, from: skipFrom, outcome: 'no', to })
    }
  }
  x += PIPELINE_STEP_X
  link('merge')
  nodes.push(
    { id: 'merge', type: 'merge', x, y: 0 },
    { id: 'end', type: 'end', merged: true, x: x + PIPELINE_STEP_X, y: 0 },
    { id: 'conflict', type: 'human', title: 'Конфликт мержа', x, y: 180, instructions: CONFLICT_INSTRUCTIONS }
  )
  edges.push(
    { id: 'e_merge_ok', from: 'merge', outcome: 'ok', to: 'end' },
    { id: 'e_merge_conflict', from: 'merge', outcome: 'conflict', to: 'conflict' },
    { id: 'e_conflict_accept', from: 'conflict', outcome: 'accept', to: 'merge' },
    { id: 'e_conflict_reject', from: 'conflict', outcome: 'reject', to: 'work' }
  )
  return { version: WORKFLOW_VERSION_TASK_SCOPE, nodes, edges }
}

/**
 * Дефолтный граф **по подзадачам** (версия 1), повторяющий поведение до воркфлоу: работа → ревью → мерж → конец,
 * отказ — обратно в работу. Есть роль `reviewer` — ревью делает агент, нет — человек. Им пользуется движок
 * подзадач, когда у старого прогона нет снимка графа: граф версии 2 (`defaultWorkflow`) по подзадачам не ходит.
 */
export function legacyDefaultWorkflow(roles: readonly Pick<Role, 'id'>[]): Workflow {
  const hasReviewer = roles.some((r) => r.id === 'reviewer')
  return legacyPipelineWorkflow([
    hasReviewer
      ? { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' }
      : { type: 'human', id: 'review', title: 'Ревью человеком' }
  ])
}

/**
 * Граф воркфлоу глобальной задачи (версия 2) в виде графа **по подзадачам** (версия 1): его читает старый движок
 * для прогонов без своего снимка («Входящие», прогон до воркфлоу), у которых граф берётся из типа задачи. Раньше такая
 * подзадача шла по графу типа — гейты и проверки сохраняются, а смысл нод меняется так:
 * - `work` теряет роль: подзадача сама выбрала роль, а этап её не переопределяет;
 * - финальная «Проверка» человеком (`PIPELINE_FINAL_CHECK_ID`, accept → конец) снимается: результат принимает
 *   глобальная задача, а не каждая подзадача;
 * - перед концом появляется `merge` (подзадача → ветка глобальной задачи) и «Конфликт мержа» у человека, если
 *   в графе своего `merge` нет (свой `merge` версии 2 — слияние прогона в базу — остаётся как есть).
 * Граф версии 1 возвращается как есть. Исходный граф не меняется.
 */
export function toTaskScopeWorkflow(wf: Workflow): Workflow {
  if (wf.version < WORKFLOW_VERSION) return wf
  // Путь подзадачи (`subflow`) в графе по подзадачам не читается: он сам и есть граф подзадачи (`TaskStore.taskWorkflow`).
  let nodes: WfNode[] = wf.nodes.map((n) => (n.type === 'work' ? (({ roleId: _roleId, roleIds: _roleIds, subflow: _subflow, ...rest }) => rest)(n) as WfNode : { ...n }))
  let edges: WfEdge[] = wf.edges.map((e) => ({ ...e }))
  const isEnd = (id: string): boolean => nodes.find((n) => n.id === id)?.type === 'end'
  // Финальная проверка человеком: входящие в неё переходы ведут туда, куда вёл её accept.
  const finalCheck = nodes.find((n) => n.type === 'human' && n.id === PIPELINE_FINAL_CHECK_ID)
  const acceptTo = finalCheck ? edges.find((e) => e.from === finalCheck.id && e.outcome === 'accept')?.to : undefined
  if (finalCheck && acceptTo !== undefined && isEnd(acceptTo)) {
    edges = edges.filter((e) => e.from !== finalCheck.id).map((e) => (e.to === finalCheck.id ? { ...e, to: acceptTo } : e))
    nodes = nodes.filter((n) => n.id !== finalCheck.id)
  }
  if (!nodes.some((n) => n.type === 'merge')) {
    const end = nodes.find((n) => n.type === 'end')
    const firstWork = nodes.find((n) => n.type === 'work')
    if (end && firstWork) {
      const free = (base: string): string => (nodes.some((n) => n.id === base) ? `${base}_task` : base)
      const merge = free('merge')
      const conflict = free('conflict')
      const endIds = new Set(nodes.filter((n) => n.type === 'end').map((n) => n.id))
      edges = edges.map((e) => (endIds.has(e.to) ? { ...e, to: merge } : e))
      nodes.push(
        { id: merge, type: 'merge', x: end.x, y: end.y },
        { id: conflict, type: 'human', title: 'Конфликт мержа', x: end.x, y: end.y + 180, instructions: CONFLICT_INSTRUCTIONS }
      )
      edges.push(
        { id: `e_${merge}_ok`, from: merge, outcome: 'ok', to: end.id },
        { id: `e_${merge}_conflict`, from: merge, outcome: 'conflict', to: conflict },
        { id: `e_${conflict}_accept`, from: conflict, outcome: 'accept', to: merge },
        { id: `e_${conflict}_reject`, from: conflict, outcome: 'reject', to: firstWork.id }
      )
      nodes = nodes.map((n) => (n.id === end.id && n.type === 'end' ? { ...n, merged: true } : n))
    }
  }
  return { version: WORKFLOW_VERSION_TASK_SCOPE, nodes, edges }
}

/** Про что предупреждает миграция графа (`WfMigrationNote.code`). */
export type WfMigrationCode =
  | 'mergeRemoved' | 'roleConditionRemoved' | 'gitNodeRemoved' | 'nodeOrphaned'
  | 'askRoleSet' | 'attemptsTargetRemoved' | 'noHumanBeforeEnd'

/** Предупреждение человеку о том, что миграция изменила граф; `message` — по-русски, для показа как есть. */
export interface WfMigrationNote {
  code: WfMigrationCode
  nodeId?: string
  message: string
}

/**
 * Приводит граф старой версии формата к `WORKFLOW_VERSION` и сообщает, что изменилось (`WfMigrationNote`).
 * Граф из будущей версии не трогает: его отвергнет `validateWorkflow` («обновите приложение»).
 *
 * v1 → v2 (граф по подзадачам → граф по глобальной задаче; подробности — docs/workflow.md, «Миграция»):
 * - `merge` v1 снимается: он значил «подзадача → ветка глобальной задачи», теперь это автоматика приложения, а
 *   `merge` v2 — слияние ветки глобальной задачи в базовую, и молча подменять смысл нельзя. Переходы в него ведут
 *   дальше по исходу `ok` (обычно в конец); ноды, в которые после этого никто не ведёт («Конфликт мержа»), снимаются;
 * - `condition: role` снимается с переходом по `yes`: у глобальной задачи роли нет;
 * - `git create_branch/checkout` снимаются с переходом по `ok`: ветка глобальной задачи одна, её задаёт шаблон проекта;
 * - роль `work` переносится в `roleIds`; `work` без роли остаётся без роли (координатор выбирает роли подзадач сам)
 *   и предупреждения не даёт;
 * - `ask` без роли получает `defaultWorkRole(roles)` — у вопроса роль обязательна (`roles` нет — `developer`).
 */
export function migrateWorkflowReport(
  wf: Workflow,
  roles: readonly Pick<Role, 'id'>[] = []
): { workflow: Workflow; notes: WfMigrationNote[] } {
  if (!(wf.version < WORKFLOW_VERSION)) return { workflow: wf, notes: [] }
  const notes: WfMigrationNote[] = []
  const title = (n: WfNode): string => wfNodeTitle(n)
  let nodes: WfNode[] = wf.nodes.map((n) => ({ ...n }))
  let edges: WfEdge[] = wf.edges.map((e) => ({ ...e }))

  /** Порт, по которому проходит снимаемая нода; undefined — нода остаётся. */
  const bypass = (n: WfNode): WfOutcome | undefined => {
    if (n.type === 'merge') return 'ok'
    if (n.type === 'condition' && n.test?.kind === 'role') return 'yes'
    if (n.type === 'git' && (n.operation === 'create_branch' || n.operation === 'checkout')) return 'ok'
    return undefined
  }
  const before = new Map(nodes.map((n) => [n.id, n]))
  const start = nodes.find((n) => n.type === 'start')
  const reachable = (ns: readonly WfNode[], es: readonly WfEdge[]): Set<string> => {
    const seen = new Set<string>()
    const queue = start ? [start.id] : []
    const ids = new Set(ns.map((n) => n.id))
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id) || !ids.has(id)) continue
      seen.add(id)
      queue.push(...es.filter((e) => e.from === id).map((e) => e.to))
    }
    return seen
  }
  const reachedBefore = reachable(nodes, edges)

  const removed = new Set(nodes.filter((n) => bypass(n) !== undefined).map((n) => n.id))
  const fallbackEnd = nodes.find((n) => n.type === 'end')?.id
  /** Куда ведёт переход в `id` после снятия нод: по их портам, пока не встретится оставшаяся нода. */
  const resolve = (id: string): string | undefined => {
    const seen = new Set<string>()
    let cur = id
    while (removed.has(cur)) {
      if (seen.has(cur)) return fallbackEnd
      seen.add(cur)
      const port = bypass(before.get(cur)!)
      const next = edges.find((e) => e.from === cur && e.outcome === port)
      if (!next) return fallbackEnd
      cur = next.to
    }
    return cur
  }
  if (removed.size > 0) {
    const kept: WfEdge[] = []
    for (const e of edges) {
      if (removed.has(e.from)) continue
      const to = resolve(e.to)
      if (to !== undefined) kept.push({ ...e, to })
    }
    for (const id of removed) {
      const n = before.get(id)!
      if (n.type === 'merge') {
        notes.push({ code: 'mergeRemoved', nodeId: id, message: `нода «${title(n)}» снята: подзадачи теперь сливаются в ветку глобальной задачи автоматически. Слияние ветки в базовую добавьте отдельной нодой «Мерж» сами` })
      } else if (n.type === 'condition') {
        notes.push({ code: 'roleConditionRemoved', nodeId: id, message: `условие по роли «${title(n)}» снято: у глобальной задачи нет роли, путь идёт по «Да»` })
      } else if (n.type === 'git') {
        notes.push({ code: 'gitNodeRemoved', nodeId: id, message: `нода «${title(n)}» снята: у глобальной задачи одна ветка, её имя задаёт шаблон в настройках проекта` })
      }
    }
    nodes = nodes.filter((n) => !removed.has(n.id))
    edges = kept
    // Ноды, в которые дошли бы только через снятые («Конфликт мержа»), теряют вход — снимаем и их.
    const reachedAfter = reachable(nodes, edges)
    const orphans = nodes.filter((n) => reachedBefore.has(n.id) && !reachedAfter.has(n.id))
    for (const n of orphans) {
      notes.push({ code: 'nodeOrphaned', nodeId: n.id, message: `нода «${title(n)}» снята: после удаления мержа в неё не ведёт ни один переход` })
    }
    const gone = new Set(orphans.map((n) => n.id))
    nodes = nodes.filter((n) => !gone.has(n.id))
    edges = edges.filter((e) => !gone.has(e.from) && !gone.has(e.to))
    for (const n of nodes) {
      if (n.type === 'condition' && n.test?.kind === 'attempts' && (removed.has(n.test.node) || gone.has(n.test.node))) {
        notes.push({ code: 'attemptsTargetRemoved', nodeId: n.id, message: `условие «${title(n)}» считает заходы в снятую ноду «${n.test.node}» — выберите другую` })
      }
    }
  }

  const role = defaultWorkRole(roles)
  nodes = nodes.map((n) => {
    if (n.type === 'work') {
      const { roleId: _roleId, roleIds: _roleIds, ...rest } = n
      const roleIds = wfWorkRoleIds(n)
      return roleIds.length > 0 ? { ...rest, roleIds } : rest
    }
    if (n.type === 'ask' && !n.roleId) {
      notes.push({ code: 'askRoleSet', nodeId: n.id, message: `этап «${title(n)}»: роль не была задана — подставлена «${role}». Вопросы задаёт агент этой роли, проверьте выбор` })
      return { ...n, roleId: role }
    }
    return n
  })

  const noHuman = endWithoutHuman(nodes, edges)
  if (noHuman) {
    notes.push({ code: 'noHumanBeforeEnd', nodeId: noHuman.id, message: `путь к «${title(noHuman)}» идёт без ноды «Человек»: результат уйдёт в «Сделано» без вашей проверки. Добавьте «Человек» перед концом` })
  }
  return { workflow: { ...wf, version: WORKFLOW_VERSION, nodes, edges }, notes }
}

/**
 * Приводит граф старой версии к `WORKFLOW_VERSION` (`migrateWorkflowReport` без предупреждений: их показывает
 * вызывающий код, которому они нужны). Роли типа — для роли этапов без неё.
 */
export function migrateWorkflow(wf: Workflow, roles: readonly Pick<Role, 'id'>[] = []): Workflow {
  return migrateWorkflowReport(wf, roles).workflow
}

/**
 * Первая нода «Конец», до которой есть путь от старта, не проходящий ни через одну ноду `human`; undefined — такого
 * пути нет. Общая для валидации (предупреждение) и миграции.
 */
function endWithoutHuman(nodes: readonly WfNode[], edges: readonly WfEdge[]): WfNode | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const start = nodes.find((n) => n.type === 'start')
  if (!start) return undefined
  const seen = new Set<string>()
  const queue = [start.id]
  while (queue.length) {
    const id = queue.shift()!
    const n = byId.get(id)
    if (!n || seen.has(id) || n.type === 'human') continue
    seen.add(id)
    if (n.type === 'end') return n
    queue.push(...edges.filter((e) => e.from === id).map((e) => e.to))
  }
  return undefined
}

// ---------- валидация ----------

/**
 * Тексты проблем графа по коду (русские: их читают main, CLI и агенты). `{node}` и другие параметры —
 * из `WfIssue.params`; renderer переводит проблему по `code` с теми же параметрами (i18n config → `wf.issue.*`).
 */
export const WF_ISSUE_TEXTS = {
  versionUnknown: 'неизвестная версия формата воркфлоу: {version}',
  versionFuture: 'воркфлоу сохранён в формате версии {version}, приложение знает только {known} — обновите приложение',
  versionOld: 'воркфлоу в старом формате версии {version} — нужна миграция (migrateWorkflow)',
  nodeEmptyId: 'нода «{node}»: пустой id',
  nodeDuplicateId: 'нода «{node}»: id «{id}» уже занят другой нодой',
  nodeUnknownType: 'нода «{id}»: неизвестный тип «{type}»',
  edgeEmptyId: 'переход {from} → {to}: пустой id',
  edgeDuplicateId: 'переход «{id}»: id уже занят другим переходом',
  edgeNoSource: 'переход «{id}»: нет ноды-источника «{from}»',
  edgeNoTarget: 'нода «{node}»: переход «{outcome}» ведёт в несуществующую ноду «{to}»',
  noStart: 'нет ноды «Старт»',
  startDuplicate: 'нода «{node}»: нода «Старт» должна быть одна',
  edgeIntoStart: 'нода «{node}»: в старт не может вести переход (из «{from}»)',
  noEnd: 'нет ноды «Конец»',
  extraOutcomeEnd: 'нода «{node}»: лишний переход «{outcome}» — из конца переходов быть не может',
  extraOutcome: 'нода «{node}»: лишний переход «{outcome}» — у ноды этого типа есть только {ports}',
  missingOutcome: 'нода «{node}»: нет перехода для {port}',
  duplicateOutcome: 'нода «{node}»: больше одного перехода для {port}',
  noPathToEnd: 'нода «{node}»: из неё нет пути к концу — задача застрянет',
  conditionCycle: 'нода «{node}»: цикл из одних условий — задача никуда не придёт',
  roleMissing: 'нода «{node}»: нет роли «{role}» в проекте',
  roleService: 'нода «{node}»: роль «{role}» служебная, задачам не назначается',
  roleAgentOff: 'нода «{node}»: агент роли «{role}» ({agent}) выключен в проекте — задача остановится на этом этапе',
  columnMissing: 'нода «{node}»: нет колонки «{column}» на доске',
  gateNoRole: 'нода «{node}»: не выбрана роль проверяющего',
  askNoInstructions: 'нода «{node}»: не задано, о чём спросить человека',
  instructionsNotString: 'нода «{node}»: «Что сделать на этапе» должно быть строкой',
  showcaseNoWhat: 'нода «{node}»: не задано, что показать человеку',
  showcaseRequiredNotBool: 'нода «{node}»: «показ обязателен» должен быть да/нет',
  attemptsNoNode: 'нода «{node}»: условие считает заходы в несуществующую ноду «{target}»',
  attemptsBadCount: 'нода «{node}»: число заходов должно быть целым и не меньше 1',
  workRolesNotList: 'нода «{node}»: роли этапа должны быть списком id ролей',
  askNoRole: 'нода «{node}»: не выбрана роль — вопросы человеку задаёт агент этой роли',
  conditionRoleRun: 'нода «{node}»: условие по роли не работает в воркфлоу глобальной задачи — у неё нет роли',
  filesUnsupported: 'нода «{node}»: условие по файлам ветки пока не поддерживается',
  conditionUnknown: 'нода «{node}»: неизвестный вид условия',
  noWorkReachable: 'от старта не достижима ни одна нода «Работа» — воркер никогда не запустится',
  unreachable: 'нода «{node}»: недостижима от старта',
  endlessLoop: 'нода «{node}»: возврат в работу без лимита повторов — отказы могут повторяться бесконечно',
  showcaseUnseen: 'нода «{node}»: показ человеку задан, но дальше нет ноды «Человек» до следующей работы или мержа — показ никто не увидит',
  noHumanBeforeEnd: 'нода «{node}»: путь к концу идёт без ноды «Человек» — результат уйдёт в «Сделано» без вашей проверки',
  mergeAgain: 'нода «{node}»: после мержа путь снова ведёт в мерж «{merge}»',
  decisionNoQuestion: 'нода «{node}»: не задан вопрос, на который отвечает агент',
  decisionNoRole: 'нода «{node}»: не выбрана роль — ветку выбирает агент этой роли',
  decisionOptionsNotList: 'нода «{node}»: варианты должны быть списком с id и названием',
  decisionTooFewOptions: 'нода «{node}»: вариантов {count}, нужно не меньше {min}',
  decisionTooManyOptions: 'нода «{node}»: вариантов {count}, можно не больше {max}',
  decisionOptionBadId: 'нода «{node}»: id варианта «{option}» недопустим — строчная латиница, цифры, «_» и «-», до 32 символов',
  decisionOptionDuplicateId: 'нода «{node}»: id варианта «{option}» повторяется',
  decisionOptionNoLabel: 'нода «{node}»: у варианта «{option}» нет названия',
  decisionSameTarget: 'нода «{node}»: все варианты ведут в одну ноду — решение ничего не меняет',
  decisionDuplicateLabel: 'нода «{node}»: у вариантов одинаковое название «{label}» — агент и человек их не различат',
  gitBadOperation: 'нода «{node}»: неизвестная git-операция «{operation}»',
  gitFieldNotString: 'нода «{node}»: поле «{field}» должно быть строкой',
  gitNoBranch: 'нода «{node}»: для операции {operation} не задано имя ветки',
  gitNoMessage: 'нода «{node}»: для операции commit не задано сообщение коммита',
  gitBranchInvalid: 'нода «{node}»: имя ветки «{branch}» недопустимо для git (пробелы, «..», спецсимволы, «/» или «.» по краям — правила `git check-ref-format`)',
  gitBaseInvalid: 'нода «{node}»: базовая ветка «{base}» недопустима для git',
  gitBaseSameAsBranch: 'нода «{node}»: новая ветка «{branch}» совпадает с базовой',
  gitRemoteInvalid: 'нода «{node}»: имя remote «{remote}» недопустимо (пробелы или «-» в начале)',
  gitUnknownPlaceholder: 'нода «{node}»: в поле «{field}» неизвестная подстановка «{placeholder}», доступны: {available}',
  gitParamIgnored: 'нода «{node}»: поле «{field}» не используется операцией {operation} — значение игнорируется',
  gitRunOperation: 'нода «{node}»: операция {operation} недоступна в воркфлоу глобальной задачи — у неё одна ветка, её имя задаёт шаблон проекта',
  templateIdNotString: 'нода «{node}»: id шаблона должен быть непустой строкой',
  subflowInvalid: 'нода «{node}»: путь подзадачи должен быть графом с полями nodes и edges',
  subflowOnNonWork: 'нода «{node}»: путь подзадачи бывает только у ноды «Работа»',
  subflowInTaskScope: 'нода «{node}»: путь подзадачи задан в графе по подзадачам (версия 1) — он есть только в графе глобальной задачи',
  subflowNested: 'нода «{node}»: у ноды внутри пути подзадачи не может быть своего пути — вложенность только одна',
  subflowNoWork: 'от старта не достижима ни одна нода «Работа» — воркер подзадачи никогда не запустится',
  subflowAskNotAllowed: 'нода «{node}»: «Вопрос человеку» недоступен в пути подзадачи — вопросы задаются этапом глобальной задачи',
  subflowDecisionNotAllowed: 'нода «{node}»: «Решение ИИ» недоступно в пути подзадачи — развилка ставится в графе глобальной задачи',
  subflowNoMerge: 'нода «{node}»: путь от старта приходит в конец, минуя «Мерж» — коммиты подзадачи не попадут в ветку глобальной задачи',
  subflowDoubleReview: 'нода «{node}»: проверка есть и в пути подзадачи, и дальше в графе — ветка будет проверена дважды; если хватает проверки каждой подзадачи, внешнюю можно убрать',
  templateNoId: 'шаблон: пустой id',
  templateNoTitle: 'шаблон: не задано название',
  templateNotString: 'шаблон «{template}»: поле «{field}» должно быть строкой',
  templateBadUpdatedAt: 'шаблон «{template}»: время обновления должно быть числом',
  templateBadNode: 'шаблон «{template}»: нода шаблона должна быть объектом с известным типом',
  templateNodeStart: 'шаблон «{template}»: ноду «Старт» шаблоном сделать нельзя — в графе она одна и создаётся вместе с ним'
} as const

/** Префикс сообщения о проблеме внутри пути подзадачи; `{node}` — название ноды «Работа», которой принадлежит путь. */
export const WF_SUBFLOW_PREFIX = 'нода «{node}» → путь подзадачи: '

export type WfIssueCode = keyof typeof WF_ISSUE_TEXTS

/**
 * Проблема графа; `nodeId`/`edgeId` — что подсветить на холсте. `code` и `params` — для перевода в UI:
 * названия нод в `params` — через `WfValidationContext.nodeTitle`.
 */
export interface WfIssue {
  message: string
  code?: WfIssueCode
  params?: Record<string, string | number>
  /** Нода на холсте; проблема внутри пути подзадачи — путь `<нода «Работа»>/<нода пути>` (например, `impl/rev`). */
  nodeId?: string
  /** Переход на холсте; внутри пути подзадачи — так же с префиксом `<нода «Работа»>/`. */
  edgeId?: string
  /**
   * Только проблема внутри пути подзадачи: нода «Работа», которой принадлежит путь. `message` уже начинается с
   * `WF_SUBFLOW_PREFIX`; renderer переводит проблему по `code` и добавляет тот же префикс сам.
   */
  subflowOf?: { nodeId: string; title: string }
}

export interface WfValidation {
  /** С ошибками граф не сохраняется. */
  errors: WfIssue[]
  /** С предупреждениями сохранить можно. */
  warnings: WfIssue[]
}

export interface WfValidationContext {
  roles: readonly Pick<Role, 'id' | 'title' | 'agent'>[]
  /**
   * Колонки доски; нет — проверка колонок нод пропускается: граф типа задачи общий для проектов с разными
   * колонками (неизвестную колонку исполнитель в рантайме пропускает).
   */
  columns?: readonly Pick<BoardColumn, 'id'>[]
  /** Агенты, включённые в проекте; нет — проверка «агент роли выключен» пропускается. */
  enabledAgents?: readonly string[]
  /** Название ноды в тексте проблемы; нет — `wfNodeTitle` (русские названия типов). renderer передаёт переведённые. */
  nodeTitle?: (node: WfNode) => string
  /**
   * Что проверяется: граф глобальной задачи (`'run'`, по умолчанию) или путь подзадачи (`'subtask'`). Путь подзадачи
   * проверяет `validateWorkflow` сам, рекурсивно, у каждой ноды `work` с `subflow`; снаружи `'subtask'` передают,
   * только чтобы проверить путь отдельно (редактор пути).
   */
  scope?: 'run' | 'subtask'
}

const KNOWN_TYPES = Object.keys(WF_PORTS) as WfNodeType[]

/**
 * Проверка графа. Вызывают renderer (подсказки в редакторе) и main (перед сохранением).
 * Роль могут удалить после сохранения, поэтому исполнитель повторяет проверку роли сам (`nextStage` → blocked).
 *
 * Путь подзадачи (`work.subflow`) проверяется здесь же, рекурсивно, со `scope: 'subtask'`: проблемы пути приходят
 * с префиксом `WF_SUBFLOW_PREFIX` и `nodeId` вида `impl/rev`. Отличия пути от графа глобальной задачи: `ask`
 * запрещён, вложенного пути нет, условие по роли допустимо (у подзадачи роль есть), не предупреждаем про конец
 * без человека, зато предупреждаем про конец в обход мержа.
 */
export function validateWorkflow(wf: Workflow, ctx: WfValidationContext): WfValidation {
  const errors: WfIssue[] = []
  const warnings: WfIssue[] = []
  const title = ctx.nodeTitle ?? wfNodeTitle
  /** Проверяется путь подзадачи, а не граф глобальной задачи. */
  const sub = ctx.scope === 'subtask'
  const issue = (code: WfIssueCode, params: Record<string, string | number> = {}, at: { nodeId?: string; edgeId?: string } = {}): WfIssue => ({
    message: WF_ISSUE_TEXTS[code].replace(/\{(\w+)\}/g, (all, k: string) => (k in params ? String(params[k]) : all)),
    code,
    ...(Object.keys(params).length ? { params } : {}),
    ...at
  })
  /** Проблема ноды `n`: её название — параметр `node`, она же подсвечивается. */
  const at = (n: WfNode, code: WfIssueCode, params: Record<string, string | number> = {}, edgeId?: string): WfIssue =>
    issue(code, { node: title(n), ...params }, { nodeId: n.id, ...(edgeId ? { edgeId } : {}) })

  // 1. Версия, id, ссылки рёбер.
  if (!Number.isInteger(wf.version) || wf.version < 1) {
    errors.push(issue('versionUnknown', { version: String(wf.version) }))
  } else if (wf.version > WORKFLOW_VERSION) {
    errors.push(issue('versionFuture', { version: wf.version, known: WORKFLOW_VERSION }))
  } else if (wf.version < WORKFLOW_VERSION) {
    errors.push(issue('versionOld', { version: wf.version }))
  }

  const nodes = new Map<string, WfNode>()
  for (const n of wf.nodes) {
    if (!n.id || !n.id.trim()) {
      errors.push(issue('nodeEmptyId', { node: title(n) }))
      continue
    }
    if (nodes.has(n.id)) {
      errors.push(at(n, 'nodeDuplicateId', { id: n.id }))
      continue
    }
    if (!KNOWN_TYPES.includes(n.type)) {
      errors.push(issue('nodeUnknownType', { id: n.id, type: String(n.type) }, { nodeId: n.id }))
      continue
    }
    nodes.set(n.id, n)
  }

  const edgeIds = new Set<string>()
  const edges: WfEdge[] = []
  for (const e of wf.edges) {
    if (!e.id || !e.id.trim()) {
      errors.push(issue('edgeEmptyId', { from: e.from, to: e.to }))
      continue
    }
    if (edgeIds.has(e.id)) {
      errors.push(issue('edgeDuplicateId', { id: e.id }, { edgeId: e.id }))
      continue
    }
    edgeIds.add(e.id)
    const from = nodes.get(e.from)
    const to = nodes.get(e.to)
    if (!from) {
      errors.push(issue('edgeNoSource', { id: e.id, from: e.from }, { edgeId: e.id }))
      continue
    }
    if (!to) {
      errors.push(at(from, 'edgeNoTarget', { outcome: e.outcome, to: e.to }, e.id))
      continue
    }
    edges.push(e)
  }

  // 2. Ровно один start без входящих рёбер, хотя бы один end.
  const starts = [...nodes.values()].filter((n) => n.type === 'start')
  if (starts.length === 0) errors.push(issue('noStart'))
  for (const extra of starts.slice(1)) {
    errors.push(at(extra, 'startDuplicate'))
  }
  for (const e of edges) {
    const to = nodes.get(e.to)!
    if (to.type === 'start') {
      errors.push(at(to, 'edgeIntoStart', { from: title(nodes.get(e.from)!) }, e.id))
    }
  }
  if (![...nodes.values()].some((n) => n.type === 'end')) errors.push(issue('noEnd'))

  // 3. Каждый порт — ровно одно ребро, чужих исходов нет.
  for (const n of nodes.values()) {
    const out = edges.filter((e) => e.from === n.id)
    const ports = wfPorts(n)
    for (const e of out) {
      if (!ports.includes(e.outcome)) {
        errors.push(n.type === 'end'
          ? at(n, 'extraOutcomeEnd', { outcome: e.outcome }, e.id)
          : at(n, 'extraOutcome', { outcome: e.outcome, ports: ports.join(', ') }, e.id))
      }
    }
    for (const port of ports) {
      const byPort = out.filter((e) => e.outcome === port)
      if (byPort.length === 0) errors.push(at(n, 'missingOutcome', { port }))
      for (const dup of byPort.slice(1)) {
        errors.push(at(n, 'duplicateOutcome', { port }, dup.id))
      }
    }
  }

  const succ = (id: string): string[] => edges.filter((e) => e.from === id).map((e) => e.to)
  const reach = (from: string[], next: (id: string) => string[], skip?: (id: string) => boolean): Set<string> => {
    const seen = new Set<string>()
    const queue = [...from]
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id) || skip?.(id)) continue
      seen.add(id)
      queue.push(...next(id))
    }
    return seen
  }
  const start = starts[0]
  const fromStart = start ? reach([start.id], succ) : new Set<string>()

  // 4. Из каждой достижимой ноды достижим конец (обратный обход от концов).
  const ends = [...nodes.values()].filter((n) => n.type === 'end').map((n) => n.id)
  const toEnd = reach(ends, (id) => edges.filter((e) => e.to === id).map((e) => e.from))
  for (const id of fromStart) {
    if (!toEnd.has(id)) errors.push(at(nodes.get(id)!, 'noPathToEnd'))
  }

  // 5. Цикл из одних условий зациклил бы nextStage.
  const isCondition = (id: string): boolean => nodes.get(id)?.type === 'condition'
  const inConditionCycle = new Set<string>()
  for (const n of nodes.values()) {
    if (n.type !== 'condition') continue
    const loop = reach(succ(n.id).filter(isCondition), (id) => succ(id).filter(isCondition))
    if (loop.has(n.id)) inConditionCycle.add(n.id)
  }
  for (const id of inConditionCycle) {
    errors.push(at(nodes.get(id)!, 'conditionCycle'))
  }

  /** Путь подзадачи ноды `work`: место, вложенность, версия графа, затем рекурсивная проверка пути. */
  const checkSubflow = (n: Extract<WfNode, { type: 'work' }>): void => {
    const raw: unknown = n.subflow
    if (raw === undefined) return
    if (sub) return void errors.push(at(n, 'subflowNested'))
    if (wf.version < WORKFLOW_VERSION) return void errors.push(at(n, 'subflowInTaskScope'))
    const path = raw as { nodes?: unknown; edges?: unknown } | null
    const isObjects = (list: unknown): list is object[] => Array.isArray(list) && list.every((x) => x !== null && typeof x === 'object')
    if (!path || typeof path !== 'object' || !isObjects(path.nodes) || !isObjects(path.edges)) {
      return void errors.push(at(n, 'subflowInvalid'))
    }
    const inner = validateWorkflow(
      { version: WORKFLOW_VERSION, nodes: path.nodes as WfNode[], edges: path.edges as WfEdge[] },
      { ...ctx, scope: 'subtask' }
    )
    const lift = (i: WfIssue): WfIssue => ({
      ...i,
      message: WF_SUBFLOW_PREFIX.replace('{node}', title(n)) + i.message,
      nodeId: i.nodeId !== undefined ? `${n.id}/${i.nodeId}` : n.id,
      ...(i.edgeId !== undefined ? { edgeId: `${n.id}/${i.edgeId}` } : {}),
      subflowOf: { nodeId: n.id, title: title(n) }
    })
    errors.push(...inner.errors.map(lift))
    warnings.push(...inner.warnings.map(lift))
  }

  // 6. Ссылки нод на роли, ноды и колонки.
  const roleById = new Map(ctx.roles.map((r) => [r.id, r]))
  const checkRole = (n: WfNode, roleId: string): void => {
    const role = roleById.get(roleId)
    if (!role) {
      errors.push(at(n, 'roleMissing', { role: roleId }))
    } else if (!isTaskRole(roleId)) {
      errors.push(at(n, 'roleService', { role: role.title }))
    } else if (ctx.enabledAgents && !ctx.enabledAgents.includes(role.agent)) {
      warnings.push(at(n, 'roleAgentOff', { role: role.title, agent: role.agent }))
    }
  }
  const columnIds = ctx.columns ? new Set(ctx.columns.map((c) => c.id)) : undefined
  for (const n of nodes.values()) {
    if (n.column !== undefined && columnIds && !columnIds.has(n.column)) {
      errors.push(at(n, 'columnMissing', { column: n.column }))
    }
    if (n.type === 'gate') {
      if (!n.roleId) errors.push(at(n, 'gateNoRole'))
      else checkRole(n, n.roleId)
    }
    if (n.type === 'ask' && sub) {
      // Вопросы человеку — этап глобальной задачи: иначе человеку пришла бы анкета на каждую подзадачу.
      errors.push(at(n, 'subflowAskNotAllowed'))
    } else if (n.type === 'ask') {
      // Воркфлоу идёт по глобальной задаче: у неё нет роли, поэтому вопрос задаёт агент роли этапа.
      if (!n.roleId) errors.push(at(n, 'askNoRole'))
      else checkRole(n, n.roleId)
    }
    if (n.type === 'work') {
      // Роли этапа необязательны: нет ни одной — подзадачам роль выбирает координатор из рабочих ролей типа.
      const raw: unknown = n.roleIds
      if (raw !== undefined && (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string'))) {
        errors.push(at(n, 'workRolesNotList'))
      } else {
        for (const roleId of wfWorkRoleIds(n)) checkRole(n, roleId)
      }
    }
    if (n.type === 'ask' && !sub && (typeof n.instructions !== 'string' || !n.instructions.trim())) {
      errors.push(at(n, 'askNoInstructions'))
    }
    if (n.templateId !== undefined && (typeof n.templateId !== 'string' || !n.templateId.trim())) {
      errors.push(at(n, 'templateIdNotString'))
    }
    if (n.type === 'work') checkSubflow(n)
    else if ((n as { subflow?: unknown }).subflow !== undefined) errors.push(at(n, 'subflowOnNonWork'))
    if (n.type === 'work') {
      if (n.instructions !== undefined && typeof n.instructions !== 'string') {
        errors.push(at(n, 'instructionsNotString'))
      }
      const sc: unknown = n.showcase
      if (sc !== undefined) {
        const obj = sc && typeof sc === 'object' ? (sc as Record<string, unknown>) : undefined
        if (!obj || typeof obj.what !== 'string' || !obj.what.trim()) {
          errors.push(at(n, 'showcaseNoWhat'))
        } else if (obj.required !== undefined && typeof obj.required !== 'boolean') {
          errors.push(at(n, 'showcaseRequiredNotBool'))
        }
      }
    }
    if (n.type === 'git') validateGitNode(n, at, errors, warnings)
    if (n.type === 'condition') {
      const t = n.test
      if (t.kind === 'attempts') {
        if (!nodes.has(t.node)) errors.push(at(n, 'attemptsNoNode', { target: t.node }))
        if (!Number.isInteger(t.atLeast) || t.atLeast < 1) errors.push(at(n, 'attemptsBadCount'))
      } else if (t.kind === 'role') {
        // У подзадачи роль есть, а у глобальной задачи — нет.
        if (!sub) errors.push(at(n, 'conditionRoleRun'))
      } else if (t.kind === 'files') {
        errors.push(at(n, 'filesUnsupported'))
      } else {
        errors.push(at(n, 'conditionUnknown'))
      }
    }
  }

  // 7. Хотя бы одна работа на пути от старта.
  if (start && ![...fromStart].some((id) => nodes.get(id)!.type === 'work')) {
    errors.push(issue(sub ? 'subflowNoWork' : 'noWorkReachable', {}, { nodeId: start.id }))
  }

  // Предупреждения.
  for (const n of nodes.values()) {
    if (start && !fromStart.has(n.id)) warnings.push(at(n, 'unreachable'))
  }

  // Цикл останавливают лимит повторов и человек: возврат через «Вернуть» — каждый раз его решение, а не
  // автоматический круг. Иначе пресет «N отказов → человек» (его «Вернуть» и «Конфликт мержа» ведут в работу)
  // всё равно получал бы это предупреждение.
  const stopsLoop = (id: string): boolean => {
    const n = nodes.get(id)
    return n?.type === 'human' || (n?.type === 'condition' && n.test.kind === 'attempts')
  }
  for (const n of nodes.values()) {
    if (n.type !== 'work' || !fromStart.has(n.id)) continue
    // Работа достижима из самой себя в обход лимита повторов и человека — возвраты могут идти бесконечно.
    if (reach(succ(n.id), succ, stopsLoop).has(n.id)) {
      warnings.push(at(n, 'endlessLoop'))
    }
  }

  // Показ смотрит человек на следующей ноде `human`. Другая «Работа» сдаст свой done, а человек после мержа
  // (конфликт) смотрит уже не показ — дальше них не идём.
  const passesShowcase = (id: string): boolean => {
    const t = nodes.get(id)?.type
    return t === 'work' || t === 'merge'
  }
  for (const n of nodes.values()) {
    if (n.type !== 'work' || !fromStart.has(n.id) || !wfShowcase(n)) continue
    const after = reach(succ(n.id), succ, passesShowcase)
    if (![...after].some((id) => nodes.get(id)!.type === 'human')) {
      warnings.push(at(n, 'showcaseUnseen'))
    }
  }

  const isMerge = (id: string): boolean => nodes.get(id)?.type === 'merge'
  // Без человека перед концом глобальная задача уходит в «Сделано» сама: разрешено (полностью автоматический
  // граф), но человек должен это видеть.
  // В пути подзадачи человек не нужен: путь по умолчанию (воркер → мерж) его не содержит.
  const unattendedEnd = start && !sub ? endWithoutHuman([...nodes.values()], edges) : undefined
  if (unattendedEnd) warnings.push(at(unattendedEnd, 'noHumanBeforeEnd'))

  // Путь подзадачи в обход мержа: коммиты подзадачи остались бы в её ветке, а этап глобальной задачи закрылся.
  if (sub && start) {
    const bypass = [...reach([start.id], succ, isMerge)].map((id) => nodes.get(id)!).find((x) => x.type === 'end')
    if (bypass) warnings.push(at(bypass, 'subflowNoMerge'))
  }

  // Проверка и в пути подзадачи, и дальше в графе: ветка проверяется дважды.
  if (!sub) {
    for (const n of nodes.values()) {
      const path = n.type === 'work' ? (n.subflow as Partial<WfSubflow> | undefined) : undefined
      if (!path || !fromStart.has(n.id) || !Array.isArray(path.nodes) || !path.nodes.some((x) => x?.type === 'gate')) continue
      if ([...reach(succ(n.id), succ)].some((id) => nodes.get(id)!.type === 'gate')) warnings.push(at(n, 'subflowDoubleReview'))
    }
  }

  for (const n of nodes.values()) {
    if (n.type !== 'merge' || !fromStart.has(n.id)) continue
    const ok = edges.find((e) => e.from === n.id && e.outcome === 'ok')
    if (!ok) continue
    const again = [...reach([ok.to], succ, (id) => id === n.id)].find((id) => isMerge(id))
    if (again) {
      warnings.push(at(n, 'mergeAgain', { merge: title(nodes.get(again)!) }, ok.id))
    }
  }

  return { errors, warnings }
}

/** Проверка ноды `git`: операция, обязательные и лишние поля, подстановки, имена веток и remote. */
function validateGitNode(
  n: Extract<WfNode, { type: 'git' }>,
  at: (n: WfNode, code: WfIssueCode, params?: Record<string, string | number>) => WfIssue,
  errors: WfIssue[],
  warnings: WfIssue[]
): void {
  const op: unknown = n.operation
  if (typeof op !== 'string' || !(WF_GIT_OPERATIONS as readonly string[]).includes(op)) {
    errors.push(at(n, 'gitBadOperation', { operation: String(op) }))
    return
  }
  const operation = op as WfGitOperation
  // Остальные поля проверяем и у этих операций: человек чинит граф, глядя на все проблемы сразу.
  if (operation === 'create_branch' || operation === 'checkout') errors.push(at(n, 'gitRunOperation', { operation }))
  const use = WF_GIT_FIELD_USE[operation]
  const FIELDS: WfGitField[] = ['branch', 'base', 'message', 'remote']
  const value = (f: WfGitField): string => {
    const v: unknown = n[f]
    return typeof v === 'string' ? v.trim() : ''
  }
  for (const f of FIELDS) {
    const v: unknown = n[f]
    if (v === undefined) continue
    if (typeof v !== 'string') {
      errors.push(at(n, 'gitFieldNotString', { field: f }))
      continue
    }
    if (!use.required.includes(f) && !use.optional.includes(f) && v.trim()) {
      warnings.push(at(n, 'gitParamIgnored', { field: f, operation }))
    }
  }
  const checkPlaceholders = (f: 'branch' | 'message', available: readonly string[]): void => {
    for (const name of new Set(placeholders(value(f)))) {
      if (!available.includes(name)) {
        errors.push(at(n, 'gitUnknownPlaceholder', {
          field: f, placeholder: `{${name}}`, available: available.map((a) => `{${a}}`).join(', ')
        }))
      }
    }
  }
  const sample = { taskId: 'task_x', slug: 'x', title: 'x' }

  if (use.required.includes('branch')) {
    const branch = value('branch')
    if (typeof n.branch === 'string' || n.branch === undefined) {
      if (!branch) errors.push(at(n, 'gitNoBranch', { operation }))
      else {
        checkPlaceholders('branch', WF_GIT_BRANCH_PLACEHOLDERS)
        // Подстановки проверены выше: образец значений нужен только для остального шаблона.
        if (!gitBranchTemplateValid(branch, sample)) errors.push(at(n, 'gitBranchInvalid', { branch }))
        else if (operation === 'create_branch' && value('base') === branch) {
          errors.push(at(n, 'gitBaseSameAsBranch', { branch }))
        }
      }
    }
  }
  if (operation === 'create_branch' && value('base') && !isValidGitBranchName(value('base'))) {
    errors.push(at(n, 'gitBaseInvalid', { base: value('base') }))
  }
  if (operation === 'commit' && (typeof n.message === 'string' || n.message === undefined)) {
    if (!value('message')) errors.push(at(n, 'gitNoMessage'))
    else checkPlaceholders('message', WF_GIT_MESSAGE_PLACEHOLDERS)
  }
  if (operation === 'push' && value('remote') && !isValidGitRemoteName(value('remote'))) {
    errors.push(at(n, 'gitRemoteInvalid', { remote: value('remote') }))
  }
}

// ---------- исполнение ----------

/**
 * Позиция на графе: подзадачи (`Task.stage`, версия 1) или глобальной задачи (`Run.stage`, версия 2). `visits` —
 * сколько раз заходили в каждую ноду (для `attempts`).
 */
export interface WfStage {
  nodeId: string
  visits: Record<string, number>
}

/** Что сделать исполнителю (main), когда задача (или глобальная задача — для `Run.stage`) пришла в ноду. */
export type WfAction =
  | { type: 'start_worker'; nodeId: string; roleId?: string }
  /**
   * Только воркфлоу глобальной задачи: этап «Работа» — координатору отправлен `stage_started`, он набирает агентов
   * ролей `roleIds` (пусто — любых рабочих ролей типа). Приложение агентов само не запускает.
   */
  | { type: 'start_stage'; nodeId: string; roleIds: string[] }
  /** Только воркфлоу глобальной задачи: этап `ask` — приложение создаёт одну задачу роли `roleId`, её вопросы идут человеку. */
  | { type: 'create_ask'; nodeId: string; roleId: string }
  | { type: 'create_gate'; nodeId: string; roleId: string }
  /**
   * Только воркфлоу глобальной задачи: нода `decision` — приложение создаёт одну задачу-решатель роли `roleId`
   * (помечена `Task.gateFor`), агент выбирает вариант командой `decision choose` или передаёт решение человеку.
   */
  | { type: 'create_decision'; nodeId: string; roleId: string }
  | { type: 'request_human'; nodeId: string }
  | { type: 'merge'; nodeId: string }
  /**
   * Git-операция ноды `git`. Шаблоны `branch`/`message` не подставлены: исполнитель вызывает
   * `renderGitTemplate(x, wfGitVars(task))`. `remote` для `push` уже с умолчанием, для остальных операций
   * ненужные поля опущены.
   */
  | { type: 'git'; nodeId: string; operation: WfGitOperation; branch?: string; base?: string; message?: string; remote?: string }
  | { type: 'done'; nodeId: string; merged: boolean }
  /** Идти дальше нельзя: задача стоит в `nodeId`, нужен человек или координатор. */
  | { type: 'blocked'; nodeId: string; reason: string }

export interface WfContext {
  /** Роль рабочей задачи — для условия `role`. Воркфлоу глобальной задачи (`scope: 'run'`) роли не имеет. */
  roleId?: string
  /** Роли проекта сейчас; есть — у гейта (и у `work`/`ask` прогона) проверяется, что роль не удалили. */
  roleIds?: readonly string[]
  /**
   * Чья позиция на графе: подзадачи (нет поля, движок до воркфлоу глобальной задачи), глобальной задачи
   * (`'run'`, `Run.stage`) или подзадачи на пути ноды `work` (`'subtask'`, `Task.stage` на `work.subflow`). От неё
   * зависит действие `work`/`ask` и то, что `condition: role` посчитать нельзя. `'subtask'` — прежнее поведение без
   * поля, но `ask` в пути запрещён (`blocked`).
   */
  scope?: 'run' | 'subtask'
}

export interface WfStep {
  stage: WfStage
  action: WfAction
}

/**
 * Действие для ноды, в которой стоит задача. Отдельно от `nextStage` — чтобы повторить эффект после
 * рестарта или после исправления причины `blocked` (роль гейта вернули).
 */
export function stageAction(wf: Workflow, stage: WfStage, ctx: WfContext): WfAction {
  const node = wf.nodes.find((n) => n.id === stage.nodeId)
  if (!node) return { type: 'blocked', nodeId: stage.nodeId, reason: `в воркфлоу нет ноды «${stage.nodeId}»` }
  switch (node.type) {
    case 'work':
    case 'ask':
      if (ctx.scope === 'run') return runWorkAction(node, ctx)
      if (ctx.scope === 'subtask' && node.type === 'ask') {
        return { type: 'blocked', nodeId: node.id, reason: `нода «${wfNodeTitle(node)}»: «Вопрос человеку» недоступен в пути подзадачи` }
      }
      // Тот же start_worker: исполнитель (main) различает работу и вопрос по типу ноды.
      {
        // Граф по подзадачам: у ноды `work` роль — одна прежняя, несколько ролей там смысла не имеют.
        const roleIds = node.type === 'work' ? wfWorkRoleIds(node) : []
        const roleId = node.type === 'ask' ? node.roleId : roleIds.length === 1 ? roleIds[0] : undefined
        return roleId ? { type: 'start_worker', nodeId: node.id, roleId } : { type: 'start_worker', nodeId: node.id }
      }
    case 'gate':
      if (ctx.roleIds && !ctx.roleIds.includes(node.roleId)) {
        return { type: 'blocked', nodeId: node.id, reason: `нода «${wfNodeTitle(node)}»: нет роли «${node.roleId}» в проекте` }
      }
      return { type: 'create_gate', nodeId: node.id, roleId: node.roleId }
    case 'human':
      return { type: 'request_human', nodeId: node.id }
    case 'decision':
      // Заглушка контракта: исполнитель ноды ещё не написан, граф честно встаёт, а не идёт мимо развилки.
      return { type: 'blocked', nodeId: node.id, reason: `нода «${wfNodeTitle(node)}»: «Решение ИИ» пока не поддерживается` }
    case 'merge':
      return { type: 'merge', nodeId: node.id }
    case 'git':
      return gitAction(node)
    case 'end':
      return { type: 'done', nodeId: node.id, merged: node.merged ?? false }
    default:
      // start и condition не бывают позицией задачи: nextStage проходит их сразу.
      return { type: 'blocked', nodeId: node.id, reason: `нода «${wfNodeTitle(node)}» не может быть этапом задачи` }
  }
}

/**
 * Действие `work`/`ask` в воркфлоу глобальной задачи. `work` — роли необязательны, но заданные должны быть в проекте;
 * у `ask` роль обязательна.
 */
function runWorkAction(node: Extract<WfNode, { type: 'work' | 'ask' }>, ctx: WfContext): WfAction {
  const blocked = (reason: string): WfAction => ({ type: 'blocked', nodeId: node.id, reason: `нода «${wfNodeTitle(node)}»: ${reason}` })
  if (node.type === 'work') {
    const roleIds = wfWorkRoleIds(node)
    const missing = ctx.roleIds ? roleIds.filter((r) => !ctx.roleIds!.includes(r)) : []
    if (missing.length > 0) return blocked(`нет ${missing.length > 1 ? 'ролей' : 'роли'} ${missing.map((r) => `«${r}»`).join(', ')} в проекте`)
    return { type: 'start_stage', nodeId: node.id, roleIds }
  }
  if (!node.roleId) return blocked('не выбрана роль, которая задаёт вопросы')
  if (ctx.roleIds && !ctx.roleIds.includes(node.roleId)) return blocked(`нет роли «${node.roleId}» в проекте`)
  return { type: 'create_ask', nodeId: node.id, roleId: node.roleId }
}

/**
 * Действие ноды `git`. Граф с неполной нодой (сохранён старым кодом или правкой файла в обход валидации) —
 * `blocked`: это ошибка настройки, а не исход `error`, который описывает отказ самой git-операции.
 */
function gitAction(node: Extract<WfNode, { type: 'git' }>): WfAction {
  const blocked = (reason: string): WfAction => ({ type: 'blocked', nodeId: node.id, reason: `нода «${wfNodeTitle(node)}»: ${reason}` })
  const op: unknown = node.operation
  if (typeof op !== 'string' || !(WF_GIT_OPERATIONS as readonly string[]).includes(op)) {
    return blocked(`неизвестная git-операция «${String(op)}»`)
  }
  const operation = op as WfGitOperation
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const use = WF_GIT_FIELD_USE[operation]
  const action: Extract<WfAction, { type: 'git' }> = { type: 'git', nodeId: node.id, operation }
  for (const f of [...use.required, ...use.optional]) {
    const v = text(node[f])
    if (v) action[f] = v
    else if (use.required.includes(f)) {
      return blocked(f === 'branch' ? `для операции ${operation} не задано имя ветки` : 'для операции commit не задано сообщение коммита')
    }
  }
  if (operation === 'push') action.remote = action.remote ?? WF_GIT_DEFAULT_REMOTE
  return action
}

/**
 * Переход задачи по исходу текущего этапа. Чистая функция: побочные эффекты (запуск воркера, создание гейта,
 * мерж) выполняет main по `action`. Цепочка условий проходится за один вызов; повторный заход в то же условие
 * за вызов — `blocked` (граф с таким циклом отвергает validateWorkflow, но граф могли сохранить старым кодом).
 * Каждый заход в ноду, включая условия, увеличивает `visits`. При `blocked` из-за отсутствующего перехода
 * задача остаётся на прежнем этапе.
 */
export function nextStage(wf: Workflow, stage: WfStage, outcome: WfPort, ctx: WfContext): WfStep {
  const blocked = (reason: string): WfStep => ({ stage, action: { type: 'blocked', nodeId: stage.nodeId, reason } })
  const byId = new Map(wf.nodes.map((n) => [n.id, n]))
  const from = byId.get(stage.nodeId)
  if (!from) return blocked(`в воркфлоу нет ноды «${stage.nodeId}»`)

  const visits = { ...stage.visits }
  const passed = new Set<string>()
  let current = from
  let out = outcome
  for (;;) {
    const edge = wf.edges.find((e) => e.from === current.id && e.outcome === out)
    if (!edge) return blocked(`нода «${wfNodeTitle(current)}»: нет перехода для ${out}`)
    const to = byId.get(edge.to)
    if (!to) return blocked(`нода «${wfNodeTitle(current)}»: переход ${out} ведёт в несуществующую ноду «${edge.to}»`)
    visits[to.id] = (visits[to.id] ?? 0) + 1
    if (to.type !== 'condition') {
      const next: WfStage = { nodeId: to.id, visits }
      return { stage: next, action: stageAction(wf, next, ctx) }
    }
    if (passed.has(to.id)) return blocked(`нода «${wfNodeTitle(to)}»: цикл из одних условий`)
    passed.add(to.id)
    const result = evalCondition(to.test, visits, ctx)
    if (typeof result === 'string') return blocked(`нода «${wfNodeTitle(to)}»: ${result}`)
    current = to
    out = result ? 'yes' : 'no'
  }
}

/** Первый этап задачи: переход из старта. */
export function startStage(wf: Workflow, ctx: WfContext): WfStep {
  const start = wf.nodes.find((n) => n.type === 'start')
  if (!start) return { stage: { nodeId: '', visits: {} }, action: { type: 'blocked', nodeId: '', reason: 'в воркфлоу нет ноды «Старт»' } }
  return nextStage(wf, { nodeId: start.id, visits: { [start.id]: 1 } }, 'next', ctx)
}

/**
 * Переход глобальной задачи по исходу текущего этапа (`Run.stage`): то же, что `nextStage`, но в контексте прогона —
 * `work` даёт `start_stage`, `ask` — `create_ask`, условие по роли не считается. Чистая функция, как и `nextStage`:
 * эффекты выполняет main по `action`, а состояние двигает `TaskStore.advanceRunStage`.
 */
export function nextRunStage(wf: Workflow, stage: WfStage, outcome: WfPort, ctx: Omit<WfContext, 'scope' | 'roleId'> = {}): WfStep {
  return nextStage(wf, stage, outcome, { ...ctx, scope: 'run' })
}

/** Первый этап глобальной задачи: переход из старта (`startStage` в контексте прогона). */
export function startRunStage(wf: Workflow, ctx: Omit<WfContext, 'scope' | 'roleId'> = {}): WfStep {
  return startStage(wf, { ...ctx, scope: 'run' })
}

/** Действие ноды, в которой стоит глобальная задача (`stageAction` в контексте прогона): повторить эффект после рестарта. */
export function runStageAction(wf: Workflow, stage: WfStage, ctx: Omit<WfContext, 'scope' | 'roleId'> = {}): WfAction {
  return stageAction(wf, stage, { ...ctx, scope: 'run' })
}

/** Значение условия или текст причины, почему его не посчитать. */
function evalCondition(test: WfCondition, visits: Record<string, number>, ctx: WfContext): boolean | string {
  switch (test.kind) {
    case 'attempts':
      return (visits[test.node] ?? 0) >= test.atLeast
    case 'role':
      if (ctx.scope === 'run') return 'условие по роли не работает в воркфлоу глобальной задачи: у неё нет роли'
      return ctx.roleId !== undefined && test.roleIds.includes(ctx.roleId)
    case 'files':
      return 'условие по файлам ветки пока не поддерживается'
    default:
      return 'неизвестный вид условия'
  }
}

// ---------- спека задачи-гейта ----------

/** Название задачи-гейта: «<название ноды>: <название рабочей задачи>». */
export function gateTaskTitle(task: Pick<Task, 'title'>, node: Extract<WfNode, { type: 'gate' }>): string {
  return `${wfNodeTitle(node)}: ${task.title}`
}

/**
 * Спека задачи-гейта: общий шаблон для любого проекта. Как проверять в конкретном репозитории (команды сборки
 * и тестов, критерии) — в `node.instructions` или в системном промпте роли гейта, не здесь.
 */
export function gateTaskSpec(task: Pick<Task, 'id' | 'title' | 'spec' | 'branch'>, node: Extract<WfNode, { type: 'gate' }>): string {
  const branch = task.branch ?? `orca/${task.id}`
  const parts = [
    `Проверь ветку \`${branch}\` задачи ${task.id} «${task.title}».`,
    [
      `1. \`orca-board review info --task ${task.id}\` — изменённые файлы и коммиты; сам diff — \`git diff\` основной ветки с \`${branch}\`.`,
      `2. Проверь работу в своём worktree: слей ветку без коммита (\`git merge --no-commit ${branch}\`), проверь, затем отмени слияние (\`git merge --abort\`).`,
      `3. Всё хорошо — \`orca-board review accept --task ${task.id}\`. Нет — \`orca-board review reject --task ${task.id} --feedback "что исправить"\`.`,
      `4. Последней командой обязательно \`orca-board done --summary "принято"\` или \`"отклонено: …"\` — без неё проверка останется открытой.`
    ].join('\n')
  ]
  const spec = task.spec.trim()
  if (spec) parts.push(`## Задание рабочей задачи — критерии приёмки\n\n${spec}`)
  const own = node.instructions?.trim()
  if (own) parts.push(`## Как проверять\n\n${own}`)
  return parts.join('\n\n')
}

// ---------- описание для CLI ----------

/** Этап графа для `orca-board workflow show`: что делает нода и куда ведёт каждый исход. */
export interface WfStageInfo {
  id: string
  type: WfNodeType
  title: string
  /** Роль гейта, вопроса или решения (без роли — роль задачи). */
  roleId?: string
  /** Роли этапа «Работа»; нет — любые рабочие роли типа. */
  roleIds?: string[]
  instructions?: string
  /** Условие ноды `condition` человеческими словами. */
  condition?: string
  /** Что воркер «Работы» сдаёт на показ человеку. */
  showcase?: WfShowcase
  /** Операция и параметры ноды `git` (только заполненные; у `push` — с remote по умолчанию). */
  git?: Omit<Extract<WfAction, { type: 'git' }>, 'type' | 'nodeId'>
  /** Вопрос ноды `decision`. */
  question?: string
  /** Варианты ноды `decision` в порядке редактора; их id — ключи `next`. */
  options?: WfDecisionOption[]
  /** Исход (у `decision` — id варианта) → «название (id)» ноды, куда он ведёт. */
  next: Partial<Record<WfPort, string>>
}

/**
 * Граф в виде, удобном агенту: этапы в порядке обхода от старта (недостижимые — в конце) с переходами.
 * Координатор читает его, чтобы знать, что приложение сделает с задачей после `worker_done`.
 */
export function describeWorkflow(wf: Workflow): WfStageInfo[] {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]))
  const order: string[] = []
  const start = wf.nodes.find((n) => n.type === 'start')
  const queue = start ? [start.id] : []
  while (queue.length) {
    const id = queue.shift()!
    if (order.includes(id) || !byId.has(id)) continue
    order.push(id)
    queue.push(...wf.edges.filter((e) => e.from === id).map((e) => e.to))
  }
  for (const n of wf.nodes) if (!order.includes(n.id)) order.push(n.id)
  const label = (id: string): string => {
    const n = byId.get(id)
    return n ? `${wfNodeTitle(n)} (${id})` : id
  }
  return order.map((id) => {
    const n = byId.get(id)!
    const next: Partial<Record<WfPort, string>> = {}
    for (const e of wf.edges) if (e.from === id) next[e.outcome] = label(e.to)
    const info: WfStageInfo = { id, type: n.type, title: wfNodeTitle(n), next }
    if ((n.type === 'gate' || n.type === 'ask') && n.roleId) info.roleId = n.roleId
    if (n.type === 'work') {
      const roleIds = wfWorkRoleIds(n)
      if (roleIds.length > 0) info.roleIds = roleIds
    }
    if ((n.type === 'gate' || n.type === 'human') && n.instructions?.trim()) info.instructions = n.instructions.trim()
    if (n.type === 'work' || n.type === 'ask') {
      const stage = wfWorkStage(wf, n.id)
      if (stage?.instructions) info.instructions = stage.instructions
      if (stage?.showcase) info.showcase = stage.showcase
    }
    if (n.type === 'condition') info.condition = conditionText(n.test, byId)
    if (n.type === 'git') {
      const a = gitAction(n)
      if (a.type === 'git') {
        const { type: _type, nodeId: _nodeId, ...git } = a
        info.git = git
      }
    }
    return info
  })
}

function conditionText(test: WfCondition, byId: Map<string, WfNode>): string {
  switch (test.kind) {
    case 'attempts': {
      const n = byId.get(test.node)
      return `задача заходила в «${n ? wfNodeTitle(n) : test.node}» не меньше ${test.atLeast} раз`
    }
    case 'role':
      return `роль задачи — ${test.roleIds.join(', ')}`
    case 'files':
      return `все файлы ветки подходят под ${test.glob}`
    default:
      return 'неизвестное условие'
  }
}

/** JSON с отсортированными ключами: сравнение ролей и графов не зависит от порядка полей. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}
