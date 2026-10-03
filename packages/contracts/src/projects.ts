import type { AgentKind, BoardColumn, TaskType } from '@orca-board/core'

/**
 * Группа проектов в левом меню. Необязательна: проект без группы (`Project.groupId` не задан) показывается в меню
 * как раньше. Порядок групп — порядок массива `projects.list().groups`; порядок проектов внутри группы — их порядок
 * в `projects`. Хранится в projects.json (`groups`), см. docs/architecture.md → «Проекты».
 */
export interface ProjectGroup {
  /** Стабильный идентификатор, его выдаёт main при `createGroup`. */
  id: string
  /** Название для показа; непустое, без пробелов по краям. Введено человеком — не переводится. */
  name: string
  /** Группа свёрнута в меню: проекты скрыты, заголовок виден. undefined — развёрнута. */
  collapsed?: boolean
}

/**
 * Текущая git-ветка корня проекта (`projects:branch`). Ровно одно из состояний:
 * `isGitRepo: false` — не репозиторий (или git недоступен), `branch`/`detached` пусты;
 * `detached: true` — detached HEAD, `branch: null`, `sha` — короткий хеш коммита;
 * иначе `branch` — имя ветки (у репозитория без коммитов — имя будущей ветки).
 */
export interface ProjectBranchInfo {
  isGitRepo: boolean
  branch: string | null
  detached: boolean
  /** Короткий sha HEAD; только при `detached`. */
  sha?: string
  /** HEAD без коммитов. */
  unborn?: true
}

/**
 * Режим `projects:createInitialCommit`: `empty` — пустой коммит через plumbing, индекс и рабочее дерево не трогаются;
 * `snapshot` — `git add -A` и коммит текущего состояния рабочего дерева.
 */
export type InitialCommitMode = 'empty' | 'snapshot'

/** Локальная ветка в `ProjectBranchList.local`. */
export interface ProjectLocalBranch {
  /** Короткое имя (`feature/x`). */
  name: string
  /** Ветка, на которой стоит корень проекта. */
  current: boolean
  /** Ветка уже checked out в другом worktree (в том числе воркера Orca): `checkoutBranch` откажет `git.branchBusy`. У текущей — false. */
  busy: boolean
}

/** Upstream текущей ветки корня и расхождение с ним (по уже полученным refs — без сети). */
export interface ProjectBranchUpstream {
  /** Полное имя upstream: `origin/main`. */
  name: string
  /** Коммитов в локальной ветке, которых нет в upstream. */
  ahead: number
  /** Коммитов в upstream, которых нет в локальной ветке. */
  behind: number
  /** Upstream настроен, но ветки на remote больше нет (после `fetch --prune`): ahead/behind — 0. */
  gone: boolean
}

/**
 * Ветки корня проекта (`projects:branches`). Не репозиторий (или git недоступен) — `isGitRepo: false`,
 * `current` — как у `projects.branch`, списки пусты, `dirty: false`; метод для этого случая не бросает.
 */
export interface ProjectBranchList {
  isGitRepo: boolean
  /** Текущее состояние HEAD корня — то же, что вернул бы `projects.branch(id)`. */
  current: ProjectBranchInfo
  /** Локальные ветки, отсортированные по имени. */
  local: ProjectLocalBranch[]
  /**
   * Удалённые ветки по последнему `fetch`, полные имена `origin/x`, отсортированные; без `<remote>/HEAD`.
   * Их же принимает `checkoutBranch` (создаст локальную `x` с tracking).
   */
  remote: string[]
  /** Upstream текущей ветки; нет — ветка без upstream, detached HEAD или репозиторий без коммитов. */
  upstream?: ProjectBranchUpstream
  /** Есть незакоммиченные изменения в корне (`git status --porcelain` не пуст, untracked тоже): checkout откажет `git.dirtyTree`. */
  dirty: boolean
}

/** Итог `projects:gitFetch` / `projects:gitPull`. */
export interface ProjectGitResult {
  /** Краткий вывод git (stdout + stderr, без ANSI, обрезан до ~4000 символов); пустой, если git ничего не написал. */
  output: string
  /** Состояние HEAD корня после операции (pull двигает ветку, но не переключает её). */
  branch: ProjectBranchInfo
}

/**
 * Коды `OrcaError` (`ipcErrorCode`) git-операций корня проекта: `projects:branches`, `gitFetch`, `gitPull`,
 * `checkoutBranch`. Тексты — `main/strings/{ru,en}.ts`, ключи те же. Ожидаемые отказы, не сбои: UI показывает
 * сообщение и не считает приложение сломанным. Любой другой отказ git — `git.opFailed`.
 */
export const PROJECT_GIT_ERROR_CODES = [
  /** Корень проекта — не git-репозиторий (или git недоступен); параметр — `path`. Кроме `branches`, который отдаёт `isGitRepo: false`. */
  'git.notRepo',
  /** Есть незакоммиченные изменения — `checkoutBranch` не выполняется, чтобы не унести правки на другую ветку. */
  'git.dirtyTree',
  /** `gitPull`: ветка разошлась с upstream, `--ff-only` не может её обновить. Мерж и rebase — вручную в терминале; параметры — `branch`, `upstream`. */
  'git.notFastForward',
  /** `gitPull`: у текущей ветки нет upstream (или она на detached HEAD — pull негде брать); параметр — `branch` (при detached — `HEAD`). */
  'git.noUpstream',
  /** `checkoutBranch`: ветка checked out в другом worktree; параметры сообщения — `branch`, `path`. */
  'git.branchBusy',
  /** `checkoutBranch`: в проекте есть живые воркеры или координаторы Orca — корень переключать нельзя; параметр — `count`. */
  'git.workersActive',
  /** `checkoutBranch`: такой ветки нет ни локально, ни среди remote-веток; параметр — `branch`. */
  'git.branchNotFound',
  /** Прочий отказ git (сеть, права, конфликт при pull, зависший remote): параметры — `command`, `error` (stderr git). */
  'git.opFailed'
] as const

export type ProjectGitErrorCode = (typeof PROJECT_GIT_ERROR_CODES)[number]

/**
 * Проект в renderer. Свои у проекта только колонки, агенты и типы задач; роли, воркфлоу, правила агентов
 * и разрешения — у типа задачи (`TaskType`, «Настройки → Типы задач»).
 */
export interface Project {
  id: string
  root: string
  name: string
  /** Группа в левом меню (`ProjectGroup.id`). undefined — проект без группы. Id несуществующей группы читать как «без группы». */
  groupId?: string
  /** Включённые агенты. undefined — все установленные. */
  enabledAgents?: AgentKind[]
  /** Колонки доски в порядке показа. undefined — DEFAULT_COLUMNS. */
  columns?: BoardColumn[]
  /** Типы задач, доступные в проекте. undefined — все типы библиотеки. */
  taskTypeIds?: string[]
  /**
   * Тип по умолчанию: глобальные задачи и координатор без выбранного типа, «Входящие». Нет или тип удалён —
   * тип библиотеки по умолчанию (`TaskTypesState.defaultTaskTypeId`).
   */
  defaultTaskTypeId?: string
  /** Тип, в который миграция перенесла настройки проекта; его получают старые прогоны доски. */
  legacyTypeId?: string
}
