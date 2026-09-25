// Воркфлоу: граф этапов, которые проходит одна рабочая задача от первого запуска до мержа.
// Модуль импортирует renderer (живая валидация в редакторе), поэтому без node-импортов;
// значения импортируются с расширением .ts — тесты гоняются node --test без бандлера.
import type { BoardColumn, Role, Task } from './types'
import { isTaskRole } from './prompts.ts'

/** Версия формата графа. Меняется при несовместимой правке типов ниже, вместе с `migrateWorkflow`. */
export const WORKFLOW_VERSION = 1

/** Исход этапа: по нему выбирается ребро. У каждого типа ноды — фиксированный набор портов (`WF_PORTS`). */
export type WfOutcome = 'next' | 'accept' | 'reject' | 'yes' | 'no' | 'ok' | 'conflict' | 'error'

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
  /** Задача заходила в ноду `node` не меньше `atLeast` раз (лимит повторов). */
  | { kind: 'attempts'; node: string; atLeast: number }
  /** Роль рабочей задачи — одна из `roleIds`. */
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
     * Работа воркера. Без `roleId` — роль задачи (её выбрал координатор). `instructions` и `showcase` попадают
     * в промпт воркера разделом «Этап» (`workerTaskPrompt`); нормализованный вид — `wfWorkStage`.
     */
    | { type: 'work'; roleId?: string; instructions?: string; showcase?: WfShowcase }
    /**
     * Вопрос человеку: агент роли ноды (пусто — роль задачи) задаёт вопросы штатным `orca-board ask`, они идут
     * человеку, минуя координатора; ответы попадают в промпт следующих этапов. Код на этапе не меняется.
     * `instructions` — о чём спросить, обязательны. Роль этапа не становится ролью задачи (в отличие от `work`).
     */
    | { type: 'ask'; roleId?: string; instructions: string }
    /** Гейт-агент: отдельная задача-проверка ветки рабочей задачи; исход — accept/reject. */
    | { type: 'gate'; roleId: string; instructions?: string }
    /** Гейт-человек: запрос в Инбоксе «Принять» / «Вернуть». */
    | { type: 'human'; instructions?: string }
    | { type: 'condition'; test: WfCondition }
    | { type: 'merge' }
    /**
     * Git-операция без агента: приложение само выполняет `operation` в worktree задачи. Какие поля нужны
     * какой операции — `wfGitFieldUse`; в `branch` и `message` работают подстановки (`renderGitTemplate`).
     */
    | WfGitParams & { type: 'git' }
    /** Конец. `merged` — для отображения: задача пришла сюда со слитой веткой. */
    | { type: 'end'; merged?: boolean }
  )

export type WfNodeType = WfNode['type']

export interface WfEdge {
  id: string
  from: string
  outcome: WfOutcome
  to: string
}

export interface Workflow {
  version: number
  nodes: WfNode[]
  edges: WfEdge[]
}

/** Порты по типу ноды: для каждого исхода из списка должно быть ровно одно исходящее ребро. */
export const WF_PORTS: Record<WfNodeType, WfOutcome[]> = {
  start: ['next'],
  work: ['next'],
  ask: ['next'],
  gate: ['accept', 'reject'],
  human: ['accept', 'reject'],
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
  condition: 'Условие',
  merge: 'Мерж',
  git: 'Git',
  end: 'Конец'
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
  instructions?: string
  showcase?: WfShowcase
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
  return {
    nodeId: node.id, type: node.type, title: wfNodeTitle(node),
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
 * Проверка в линейном графе (`pipelineWorkflow`): гейт-агент или человек. Отказ всегда возвращает в работу.
 * `onlyForRoles` — проверка только для задач этих ролей: перед ней ставится условие по роли, остальные задачи
 * её пропускают.
 */
export type WfPipelineCheck =
  | { type: 'gate'; id: string; roleId: string; title?: string; instructions?: string; onlyForRoles?: string[] }
  | { type: 'human'; id: string; title?: string; instructions?: string; onlyForRoles?: string[] }

const PIPELINE_STEP_X = 220
const CONFLICT_INSTRUCTIONS =
  'Ветка не сливается без конфликтов. Разрешите конфликт в ветке задачи и примите её или верните в работу.'

/**
 * Конструктор типового графа: старт → работа → проверки по порядку → мерж → конец. Отказ любой проверки
 * возвращает в работу, конфликт мержа уходит человеку (принять — снова мерж, вернуть — в работу).
 * Из него собраны `defaultWorkflow` и графы заготовок типов задач (task-types.ts), поэтому id нод
 * и рёбер стабильны: `work`, `merge`, `end`, `conflict`, `e_<нода>_<исход>`; условие роли — `<id проверки>_if`.
 */
export function pipelineWorkflow(checks: readonly WfPipelineCheck[]): Workflow {
  const nodes: WfNode[] = [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'work', type: 'work', title: 'Работа', x: PIPELINE_STEP_X, y: 0 }
  ]
  const edges: WfEdge[] = [{ id: 'e_start', from: 'start', outcome: 'next', to: 'work' }]
  let x = PIPELINE_STEP_X
  // Куда ведёт выход предыдущего шага: его выход задаётся, когда известен следующий шаг.
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
  return { version: WORKFLOW_VERSION, nodes, edges }
}

/**
 * Дефолтный граф, повторяющий поведение до воркфлоу: работа → ревью → мерж → конец, отказ — обратно в работу.
 * Есть роль `reviewer` — ревью делает агент (гейт), нет — человек. Конфликт мержа уходит человеку:
 * раньше задача с конфликтом зависала в «Ревью». Лимита повторов нет, как и раньше.
 */
export function defaultWorkflow(roles: readonly Pick<Role, 'id'>[]): Workflow {
  const hasReviewer = roles.some((r) => r.id === 'reviewer')
  return pipelineWorkflow([
    hasReviewer
      ? { type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' }
      : { type: 'human', id: 'review', title: 'Ревью человеком' }
  ])
}

/**
 * Приводит граф старой версии формата к `WORKFLOW_VERSION`. Пока версия одна — только проставляет её.
 * Граф из будущей версии не трогает: его отвергнет `validateWorkflow` («обновите приложение»).
 */
export function migrateWorkflow(wf: Workflow): Workflow {
  if (!(wf.version < WORKFLOW_VERSION)) return wf
  // Сюда добавлять шаги миграции: if (wf.version < 2) { … }
  return { ...wf, version: WORKFLOW_VERSION }
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
  roleConditionEmpty: 'нода «{node}»: в условии не выбрана ни одна роль',
  roleConditionUnknown: 'нода «{node}»: в условии роль «{role}», которой нет в типе задачи',
  filesUnsupported: 'нода «{node}»: условие по файлам ветки пока не поддерживается',
  conditionUnknown: 'нода «{node}»: неизвестный вид условия',
  noWorkReachable: 'от старта не достижима ни одна нода «Работа» — воркер никогда не запустится',
  unreachable: 'нода «{node}»: недостижима от старта',
  endlessLoop: 'нода «{node}»: возврат в работу без лимита повторов — отказы могут повторяться бесконечно',
  showcaseUnseen: 'нода «{node}»: показ человеку задан, но дальше нет ноды «Человек» до следующей работы или мержа — показ никто не увидит',
  acceptWithoutMerge: 'нода «{node}»: после accept путь ведёт в «{end}» без мержа — принятая работа не будет слита',
  mergeAgain: 'нода «{node}»: после мержа путь снова ведёт в мерж «{merge}»',
  gitBadOperation: 'нода «{node}»: неизвестная git-операция «{operation}»',
  gitFieldNotString: 'нода «{node}»: поле «{field}» должно быть строкой',
  gitNoBranch: 'нода «{node}»: для операции {operation} не задано имя ветки',
  gitNoMessage: 'нода «{node}»: для операции commit не задано сообщение коммита',
  gitBranchInvalid: 'нода «{node}»: имя ветки «{branch}» недопустимо для git (пробелы, «..», спецсимволы, «/» или «.» по краям — правила `git check-ref-format`)',
  gitBaseInvalid: 'нода «{node}»: базовая ветка «{base}» недопустима для git',
  gitBaseSameAsBranch: 'нода «{node}»: новая ветка «{branch}» совпадает с базовой',
  gitRemoteInvalid: 'нода «{node}»: имя remote «{remote}» недопустимо (пробелы или «-» в начале)',
  gitUnknownPlaceholder: 'нода «{node}»: в поле «{field}» неизвестная подстановка «{placeholder}», доступны: {available}',
  gitParamIgnored: 'нода «{node}»: поле «{field}» не используется операцией {operation} — значение игнорируется'
} as const

export type WfIssueCode = keyof typeof WF_ISSUE_TEXTS

/**
 * Проблема графа; `nodeId`/`edgeId` — что подсветить на холсте. `code` и `params` — для перевода в UI:
 * названия нод в `params` — через `WfValidationContext.nodeTitle`.
 */
export interface WfIssue {
  message: string
  code?: WfIssueCode
  params?: Record<string, string | number>
  nodeId?: string
  edgeId?: string
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
}

const KNOWN_TYPES = Object.keys(WF_PORTS) as WfNodeType[]

/**
 * Проверка графа. Вызывают renderer (подсказки в редакторе) и main (перед сохранением).
 * Роль могут удалить после сохранения, поэтому исполнитель повторяет проверку роли сам (`nextStage` → blocked).
 */
export function validateWorkflow(wf: Workflow, ctx: WfValidationContext): WfValidation {
  const errors: WfIssue[] = []
  const warnings: WfIssue[] = []
  const title = ctx.nodeTitle ?? wfNodeTitle
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
    const ports = WF_PORTS[n.type]
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
    if ((n.type === 'work' || n.type === 'ask') && n.roleId) checkRole(n, n.roleId)
    if (n.type === 'ask' && (typeof n.instructions !== 'string' || !n.instructions.trim())) {
      errors.push(at(n, 'askNoInstructions'))
    }
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
        if (t.roleIds.length === 0) errors.push(at(n, 'roleConditionEmpty'))
        for (const r of t.roleIds) {
          if (!roleById.has(r)) errors.push(at(n, 'roleConditionUnknown', { role: r }))
        }
      } else if (t.kind === 'files') {
        errors.push(at(n, 'filesUnsupported'))
      } else {
        errors.push(at(n, 'conditionUnknown'))
      }
    }
  }

  // 7. Хотя бы одна работа на пути от старта.
  if (start && ![...fromStart].some((id) => nodes.get(id)!.type === 'work')) {
    errors.push(issue('noWorkReachable', {}, { nodeId: start.id }))
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
  for (const n of nodes.values()) {
    if ((n.type !== 'gate' && n.type !== 'human') || !fromStart.has(n.id)) continue
    const accept = edges.find((e) => e.from === n.id && e.outcome === 'accept')
    if (!accept) continue
    const endWithoutMerge = [...reach([accept.to], succ, isMerge)].find((id) => nodes.get(id)!.type === 'end')
    if (endWithoutMerge) {
      warnings.push(at(n, 'acceptWithoutMerge', { end: title(nodes.get(endWithoutMerge)!) }, accept.id))
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

/** Позиция задачи в воркфлоу прогона. `visits` — сколько раз задача заходила в каждую ноду (для `attempts`). */
export interface WfStage {
  nodeId: string
  visits: Record<string, number>
}

/** Что сделать исполнителю (main), когда задача пришла в ноду. */
export type WfAction =
  | { type: 'start_worker'; nodeId: string; roleId?: string }
  | { type: 'create_gate'; nodeId: string; roleId: string }
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
  /** Роль рабочей задачи — для условия `role`. */
  roleId: string
  /** Роли проекта сейчас; есть — у гейта проверяется, что его роль не удалили. */
  roleIds?: readonly string[]
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
      // Тот же start_worker: исполнитель (main) различает работу и вопрос по типу ноды.
      return node.roleId ? { type: 'start_worker', nodeId: node.id, roleId: node.roleId } : { type: 'start_worker', nodeId: node.id }
    case 'gate':
      if (ctx.roleIds && !ctx.roleIds.includes(node.roleId)) {
        return { type: 'blocked', nodeId: node.id, reason: `нода «${wfNodeTitle(node)}»: нет роли «${node.roleId}» в проекте` }
      }
      return { type: 'create_gate', nodeId: node.id, roleId: node.roleId }
    case 'human':
      return { type: 'request_human', nodeId: node.id }
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
export function nextStage(wf: Workflow, stage: WfStage, outcome: WfOutcome, ctx: WfContext): WfStep {
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

/** Значение условия или текст причины, почему его не посчитать. */
function evalCondition(test: WfCondition, visits: Record<string, number>, ctx: WfContext): boolean | string {
  switch (test.kind) {
    case 'attempts':
      return (visits[test.node] ?? 0) >= test.atLeast
    case 'role':
      return test.roleIds.includes(ctx.roleId)
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
  /** Роль гейта, работы или вопроса (без роли — роль задачи). */
  roleId?: string
  instructions?: string
  /** Условие ноды `condition` человеческими словами. */
  condition?: string
  /** Что воркер «Работы» сдаёт на показ человеку. */
  showcase?: WfShowcase
  /** Операция и параметры ноды `git` (только заполненные; у `push` — с remote по умолчанию). */
  git?: Omit<Extract<WfAction, { type: 'git' }>, 'type' | 'nodeId'>
  /** Исход → «название (id)» ноды, куда он ведёт. */
  next: Partial<Record<WfOutcome, string>>
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
    const next: Partial<Record<WfOutcome, string>> = {}
    for (const e of wf.edges) if (e.from === id) next[e.outcome] = label(e.to)
    const info: WfStageInfo = { id, type: n.type, title: wfNodeTitle(n), next }
    if ((n.type === 'gate' || n.type === 'work' || n.type === 'ask') && n.roleId) info.roleId = n.roleId
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
