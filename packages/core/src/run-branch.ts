// Ветка глобальной задачи (docs/architecture.md → «Ветка глобальной задачи»): у каждой глобальной задачи —
// своя ветка и свой worktree, подзадачи ответвляются от неё и сливаются в неё, корень репозитория не меняется.
// Здесь только чистая часть — настройки, имя ветки, защищённые ветки; git выполняет main (`src/main/run-branch.ts`).
// Модуль импортирует renderer (раздел «Git» проекта), поэтому без node-импортов.

/** Настройки веток глобальных задач проекта (`Project.git`); незаданные поля — `DEFAULT_RUN_BRANCH_SETTINGS`. */
export interface RunBranchSettings {
  /** Заводить ли ветку на глобальную задачу. Выключено — подзадачи сливаются в текущую ветку корня (как раньше). */
  enabled: boolean
  /** От чего ответвлять ветку: ветка, remote-ветка (`origin/develop`) или коммит. Пусто — текущая ветка корня. */
  base: string
  /** Шаблон имени: `{runId}`, `{slug}` (из названия, латиницей). */
  template: string
  /** Отправлять ветку на remote, когда глобальная задача закрыта (ушла на «Проверку»). */
  push: boolean
  /** Открывать PR ветки в базу после успешного push через gh CLI; нужны enabled и push. */
  pr: boolean
  /** Remote для push и для `git fetch` перед ответвлением. */
  remote: string
  /**
   * В эти ветки корня приложение не сливает подзадачи (без ветки глобальной задачи: «Входящие», старые прогоны,
   * выключенная настройка). `*` — любая часть имени: `release/*`. Пустой список — защиты нет.
   */
  protected: string[]
}

export const DEFAULT_RUN_BRANCH_SETTINGS: Readonly<RunBranchSettings> = Object.freeze({
  enabled: true,
  base: '',
  template: 'feature/{runId}-{slug}',
  push: false,
  pr: false,
  remote: 'origin',
  protected: ['master', 'main', 'develop', 'release/*', 'hotfix/*']
})

/** Подстановки шаблона имени ветки. */
export const RUN_BRANCH_VARS = ['runId', 'slug'] as const

/** Ветка глобальной задачи в прогоне (`Run.git`). */
export interface RunGit {
  /** Имя ветки фичи. */
  branch: string
  /** От чего ответвлена (как в настройке после подстановки текущей ветки корня). */
  base: string
  /** Worktree ветки: `<repo>/../.orca-worktrees/<runId>`. Нет — убран после «Сделано» (ветка остаётся). */
  worktree?: string
  /** Последний успешный push. */
  pushedAt?: number
  /** Ошибка последнего push; снимается успешным. */
  pushError?: string
  /** Ссылка на открытый PR ветки. */
  prUrl?: string
  /** Ошибка последней попытки открыть PR; снимается успешной. Урезается, как `pushError`. */
  prError?: string
  /**
   * Вид ошибки PR для перевода в renderer: `prError` — текст для сокета и CLI (по-русски или stderr gh), а человеку
   * «gh не установлен» / «gh не авторизован» показываем на его языке. Нет — ошибки нет или она старше поля.
   */
  prErrorCode?: PrErrorCode
}

/** Почему приложение не открыло PR: нет gh, gh без логина, остальное (текст — в `RunGit.prError`). */
export type PrErrorCode = 'ghMissing' | 'ghAuth' | 'other'

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
}

const SLUG_MAX = 40

/**
 * Слаг названия для имени ветки: латиница (кириллица транслитерируется), цифры и дефисы, не длиннее 40 символов.
 * Пусто (название из одних символов) — `task`: имя ветки не должно кончаться на дефис.
 */
export function branchSlug(title: string): string {
  const latin = [...title.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('')
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '')
  return slug || 'task'
}

/** Имя ветки глобальной задачи по шаблону. Неизвестная подстановка остаётся как есть — её ловит `branchNameProblem`. */
export function runBranchName(template: string, run: { id: string; title: string }): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => {
    if (name === 'runId') return run.id
    if (name === 'slug') return branchSlug(run.title)
    return all
  })
}

/**
 * Почему строка не годится в имя ветки (подмножество правил `git check-ref-format --branch`), `undefined` — годится.
 * Проверяется до git, чтобы человек увидел ошибку в настройке, а не текст git при запуске координатора.
 */
export function branchNameProblem(name: string): string | undefined {
  if (!name.trim()) return 'пустое имя ветки'
  if (/\{\w+\}/.test(name)) return `неизвестная подстановка ${name.match(/\{\w+\}/)![0]} (есть: ${RUN_BRANCH_VARS.map((v) => `{${v}}`).join(', ')})`
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return `недопустимый символ в имени ветки «${name}»`
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) {
    return `имя ветки «${name}» не может начинаться с «-» или «/» и кончаться на «/», «.» или «.lock»`
  }
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name === '@' || name.split('/').some((p) => p.startsWith('.'))) {
    return `недопустимое имя ветки «${name}»`
  }
  return undefined
}

/** Имя совпадает с шаблоном защищённой ветки: `*` — любая последовательность символов. */
export function isProtectedBranch(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    return re.test(name)
  })
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v.trim() : fallback
}

/** Настройки из projects.json или IPC: чужие типы и лишние поля отбрасываются, недостающие — по умолчанию. */
export function normalizeRunBranchSettings(raw: unknown): RunBranchSettings {
  const d = DEFAULT_RUN_BRANCH_SETTINGS
  if (typeof raw !== 'object' || raw === null) return { ...d, protected: [...d.protected] }
  const r = raw as Record<string, unknown>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    base: str(r.base, d.base),
    template: str(r.template, d.template) || d.template,
    push: typeof r.push === 'boolean' ? r.push : d.push,
    pr: typeof r.pr === 'boolean' ? r.pr : d.pr,
    remote: str(r.remote, d.remote) || d.remote,
    protected: Array.isArray(r.protected)
      ? [...new Set(r.protected.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean))]
      : [...d.protected]
  }
}

/** Проблема настроек веток: `code` — для перевода в renderer, `text` — по-русски для main, сокета и CLI. */
export interface RunBranchIssue {
  code: 'templateName' | 'templateRunId' | 'base' | 'remote' | 'prNeedsPush'
  text: string
}

/**
 * Ошибки настроек (сохранение из «О проекте → Git», запуск координатора): шаблон должен давать допустимое имя ветки
 * и содержать `{runId}`, база и remote — без пробелов и управляющих символов. Пустой список — настройки годятся.
 */
export function runBranchSettingsProblems(s: RunBranchSettings): RunBranchIssue[] {
  const issues: RunBranchIssue[] = []
  const name = branchNameProblem(runBranchName(s.template, { id: 'run_example1', title: 'Пример задачи' }))
  if (name) issues.push({ code: 'templateName', text: `шаблон ветки: ${name}` })
  if (!s.template.includes('{runId}')) {
    issues.push({ code: 'templateRunId', text: 'шаблон ветки должен содержать {runId}: иначе у двух глобальных задач с одним названием совпадут ветки' })
  }
  const base = s.base ? branchNameProblem(s.base) : undefined
  if (base) issues.push({ code: 'base', text: `база: ${base}` })
  if (/[\s/]/.test(s.remote)) issues.push({ code: 'remote', text: `remote «${s.remote}»: имя без пробелов и «/»` })
  if (s.enabled && s.pr && !s.push) {
    issues.push({ code: 'prNeedsPush', text: 'PR создаётся после push: включите «Отправлять ветку на remote»' })
  }
  return issues
}

/**
 * База PR для `gh pr create --base`: gh ждёт имя ветки на remote без префикса `<remote>/` (`origin/develop` → `develop`).
 * Локальная ветка — как есть. Пустая база (текущая ветка корня) и коммит (7–40 hex) — `undefined`: у коммита нет
 * ветки, в которую можно открыть PR, тогда gh берёт ветку по умолчанию.
 */
export function prBaseBranch(base: string, remote: string): string | undefined {
  const b = base.trim()
  if (!b || /^[0-9a-f]{7,40}$/i.test(b)) return undefined
  const prefix = `${remote}/`
  if (b.startsWith(prefix)) return b.slice(prefix.length) || undefined
  return b
}
