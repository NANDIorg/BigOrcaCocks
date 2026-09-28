// Ветка глобальной задачи (docs/architecture.md → «Ветка глобальной задачи»): у каждой глобальной задачи —
// своя ветка и свой worktree, подзадачи ответвляются от неё и сливаются в неё, корень репозитория не меняется.
// Что делать с веткой дальше (push, PR, мерж в основную) — решает человек. Настроек нет: база — ветка, открытая
// в проекте при старте, имя — `feature/<runId>-<slug>`. Здесь только чистая часть (имя ветки); git выполняет main
// (`src/main/run-branch.ts`). Модуль импортирует renderer, поэтому без node-импортов.

/** Ветка глобальной задачи в прогоне (`Run.git`). */
export interface RunGit {
  /** Имя ветки фичи. */
  branch: string
  /** От чего ответвлена: ветка, открытая в проекте при старте (detached HEAD — коммит). */
  base: string
  /** Worktree ветки: `<repo>/../.orca-worktrees/<runId>`. Нет — убран после «Сделано» (ветка остаётся). */
  worktree?: string
}

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

/** Имя ветки глобальной задачи: `feature/<runId>-<slug>`; runId делает имя уникальным при одинаковых названиях. */
export function runBranchName(run: { id: string; title: string }): string {
  return `feature/${run.id}-${branchSlug(run.title)}`
}
