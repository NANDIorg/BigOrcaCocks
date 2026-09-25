import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  globalTaskTitle, isProtectedBranch, prBaseBranch, runBranchName, runBranchSettingsProblems,
  type PrErrorCode, type RunBranchSettings, type RunGit, type Task, type TaskStore
} from '@orca-board/core'
import type { GhStatus } from '../shared/ipc'
import { extraPathDirs } from './agents'
import { currentBranch } from './git'
import { OrcaError } from './i18n'

// Ветка глобальной задачи (docs/architecture.md → «Ветка глобальной задачи»). Раньше подзадачи ответвлялись от HEAD
// корня и сливались в его текущую ветку: открыли проект на master — вся работа Orca попала в master, а две фичи
// одного проекта смешались в одной ветке. Теперь у глобальной задачи своя ветка и свой worktree: подзадачи
// ответвляются от неё и сливаются в неё, корень не меняется, несколько глобальных задач идут параллельно.

// git только массивом аргументов без shell (CLAUDE.md). Сеть (fetch, push) — без интерактивного запроса пароля:
// приложение не может его показать, git завис бы.
const NET_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
const FETCH_TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 120_000
const GH_TIMEOUT_MS = 60_000
const PR_ERROR_LIMIT = 2000

function git(cwd: string, args: string[], opts: { timeout?: number } = {}): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: NET_ENV, ...opts }).trim()
}

function gitError(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string }
  return (err.stderr?.toString().trim() || err.message || String(e)).trim()
}

/** Worktree глобальной задачи — рядом с worktree подзадач: `<repo>/../.orca-worktrees/<runId>`. */
export function runWorktreePath(repoRoot: string, runId: string): string {
  return join(repoRoot, '..', '.orca-worktrees', runId)
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/** Текущая ветка корня; detached HEAD — коммит, иначе ветвиться было бы не от чего. */
function headRef(repoRoot: string): string {
  const branch = currentBranch(repoRoot)
  return branch === 'HEAD' ? git(repoRoot, ['rev-parse', 'HEAD']) : branch
}

/**
 * База вида `<remote>/<ветка>` — сначала `git fetch`, чтобы фича ответвилась от свежей базы, а не от того, что
 * лежит в клоне с прошлой недели. Нет сети или прав — ветвимся от того, что есть: запуск важнее свежести.
 */
function fetchBase(repoRoot: string, base: string, remote: string): void {
  if (!base.startsWith(`${remote}/`)) return
  try {
    if (!git(repoRoot, ['remote']).split('\n').includes(remote)) return
    git(repoRoot, ['fetch', '--quiet', remote, base.slice(remote.length + 1)], { timeout: FETCH_TIMEOUT_MS })
  } catch {
    /* офлайн или нет такой ветки на remote — git worktree add ниже скажет, если базы нет совсем */
  }
}

/**
 * Прогон уже работал без своей ветки: воркеры запускались и сливали результат в корень. Заводить ветку посреди
 * работы нельзя — половина фичи оказалась бы в корне, половина в новой ветке. Такой прогон доживает по-старому.
 */
function startedWithoutBranch(store: TaskStore, runId: string): boolean {
  const ids = new Set(store.listSubtasks(runId).map((t) => t.id))
  return store.snapshot().dispatches.some((d) => ids.has(d.taskId))
}

/**
 * Worktree ветки есть на диске; убран (после «Сделано») или удалён руками — вернуть на существующую ветку.
 * `worktree prune` снимает запись об удалённой руками папке, иначе `worktree add` откажет.
 */
function ensureWorktree(store: TaskStore, repoRoot: string, runId: string, g: RunGit): RunGit {
  if (g.worktree && existsSync(g.worktree)) return g
  if (!branchExists(repoRoot, g.branch)) throw new OrcaError('git.runBranchMissing', { branch: g.branch })
  const worktree = runWorktreePath(repoRoot, runId)
  try {
    git(repoRoot, ['worktree', 'prune'])
    git(repoRoot, ['worktree', 'add', worktree, g.branch])
  } catch (e) {
    throw new OrcaError('git.runBranchFailed', { branch: g.branch, base: g.branch, error: gitError(e) })
  }
  return store.setRunGit(runId, { worktree }).git!
}

/**
 * Ветка глобальной задачи с worktree на диске: есть — вернуть (восстановив worktree), нет — завести от базы
 * настроек (`git worktree add --no-track -b`: без upstream на базу, иначе голый `git push` ушёл бы в неё).
 * `undefined` — работать по-старому, в текущую ветку корня: «Входящие», настройка выключена, прогон начат без ветки.
 * Вызывают запуск координатора и воркера — до того, как кто-то начнёт работать.
 */
export function ensureRunBranch(store: TaskStore, repoRoot: string, runId: string | undefined, settings: RunBranchSettings): RunGit | undefined {
  const run = runId ? store.getRun(runId) : undefined
  if (!run || run.inbox) return undefined
  if (run.git) return ensureWorktree(store, repoRoot, run.id, run.git)
  if (!settings.enabled || startedWithoutBranch(store, run.id)) return undefined
  const problems = runBranchSettingsProblems(settings)
  if (problems.length > 0) throw new OrcaError('git.badSettings', { problems: problems.map((x) => x.text).join('; ') })
  const branch = runBranchName(settings.template, { id: run.id, title: globalTaskTitle(run) })
  const base = settings.base || headRef(repoRoot)
  fetchBase(repoRoot, base, settings.remote)
  const worktree = runWorktreePath(repoRoot, run.id)
  try {
    git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, worktree, base])
  } catch (e) {
    throw new OrcaError('git.runBranchFailed', { branch, base, error: gitError(e) })
  }
  return store.setRunGit(run.id, { branch, base, worktree }).git
}

/** Куда сливать ветку подзадачи: каталог, где выполнить `git merge`, и ветка в нём. */
export interface MergeTarget {
  cwd: string
  branch: string
}

/**
 * Цель мержа подзадачи: ветка её глобальной задачи (worktree восстанавливается, если убран) или — прогон без
 * ветки — текущая ветка корня. Во вторую приложение не сливает, если она защищённая (`master`, `develop`…):
 * так Orca, открытый на общей ветке, больше не пишет в неё молча. Ошибка — исключение: это не конфликт мержа,
 * повтор без смены настройки или ветки корня не поможет.
 */
export function mergeTarget(store: TaskStore, repoRoot: string, task: Pick<Task, 'runId'>, settings: RunBranchSettings): MergeTarget {
  const run = task.runId ? store.getRun(task.runId) : undefined
  if (run?.git) {
    const g = ensureWorktree(store, repoRoot, run.id, run.git)
    return { cwd: g.worktree!, branch: g.branch }
  }
  const branch = currentBranch(repoRoot)
  if (isProtectedBranch(branch, settings.protected)) throw new OrcaError('git.protectedBranch', { branch })
  return { cwd: repoRoot, branch }
}

/** База для «что накопилось в ветке задачи» (ревью): ветка глобальной задачи или текущая ветка корня. */
export function reviewBase(store: TaskStore, repoRoot: string, task: Pick<Task, 'runId'>): string {
  const run = task.runId ? store.getRun(task.runId) : undefined
  return run?.git?.branch ?? currentBranch(repoRoot)
}

/**
 * Убрать worktree глобальной задачи, ветку оставить. Без `--force`: незакоммиченное в нём (кто-то правил руками)
 * не теряем — worktree остаётся, `false`.
 */
export function removeRunWorktree(repoRoot: string, worktree: string): boolean {
  if (!existsSync(worktree)) return true
  try {
    git(repoRoot, ['worktree', 'remove', worktree])
    return true
  } catch {
    return false
  }
}

/**
 * Окружение gh: без интерактивных запросов (логин, обновление) — приложение не может их показать. PATH — как у
 * агентов (`workerPath()` в worker.ts): у GUI на macOS он урезан, и gh из Homebrew не находится. Считается на
 * каждый вызов: `process.env.PATH` main подменяет при старте на PATH оболочки.
 */
function ghEnv(): NodeJS.ProcessEnv {
  const path = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraPathDirs()].join(delimiter)
  return { ...NET_ENV, PATH: path, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
}

/** Вызов `gh` без shell (CLAUDE.md); stdout при успехе, при ошибке — исключение `execFile` (`code`, `stderr`). */
export function runGh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env: ghEnv(), timeout: GH_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      reject(Object.assign(err, { stderr }))
    })
  })
}

/** Текст `prError` по ошибке gh: нет gh — понятная подсказка, иначе stderr (как `pushError`). */
function ghErrorText(e: unknown): string {
  const err = e as { code?: string; stderr?: string | Buffer; message?: string }
  if (err.code === 'ENOENT') return 'gh не установлен (https://cli.github.com)'
  return (err.stderr?.toString().trim() || err.message || String(e)).slice(0, PR_ERROR_LIMIT)
}

// Без логина gh выходит с кодом 4 («authentication required») и пишет «To get started with GitHub CLI, please run:
// gh auth login»; протухший токен — «HTTP 401: Bad credentials» с кодом 1, поэтому смотрим и на текст.
const GH_EXIT_AUTH = 4
const GH_AUTH_RE = /gh auth login|not logged in|authentication required|bad credentials|HTTP 401/i
// Remote не на GitHub (GitLab, свой сервер) или remote нет вовсе. В этом тексте gh тоже советует `gh auth login`
// («To tell gh about a new GitHub host…»), поэтому его проверяем раньше логина.
const GH_NOT_GITHUB_RE = /known GitHub host|no git remotes/i

function ghStderr(e: unknown): string {
  return (e as { stderr?: string | Buffer }).stderr?.toString() ?? ''
}

/** Вид ошибки gh для `RunGit.prErrorCode`: человеку «нет gh» и «нет логина» переводим, остальное — stderr как есть. */
export function ghErrorCode(e: unknown): PrErrorCode {
  const code = (e as { code?: string | number }).code
  if (code === 'ENOENT') return 'ghMissing'
  const stderr = ghStderr(e)
  if (GH_NOT_GITHUB_RE.test(stderr)) return 'other'
  return code === GH_EXIT_AUTH || GH_AUTH_RE.test(stderr) ? 'ghAuth' : 'other'
}

/**
 * Готов ли gh открывать PR из корня проекта (`projects:ghStatus`, раздел «Git» при выборе «Push + PR»): один
 * `gh repo view` проверяет сразу установку, логин и то, что remote — репозиторий GitHub. Ничего не меняет.
 */
export async function ghStatus(cwd: string, gh: (args: string[], cwd: string) => Promise<string> = runGh): Promise<GhStatus> {
  try {
    const out = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'], cwd)) as { nameWithOwner?: string }
    return { state: 'ok', repo: out.nameWithOwner ?? '' }
  } catch (e) {
    const code = ghErrorCode(e)
    if (code === 'ghMissing') return { state: 'missing' }
    if (code === 'ghAuth') return { state: 'noAuth' }
    return GH_NOT_GITHUB_RE.test(ghStderr(e)) ? { state: 'notGithub' } : { state: 'error', detail: ghErrorText(e) }
  }
}

export interface RunBranchSyncDeps {
  isAlive(ptyId: string): boolean
  /** Вызов `gh` в каталоге; по умолчанию настоящий gh, тесты подставляют свой. */
  gh?(args: string[], cwd: string): Promise<string>
  /**
   * PR не открылся (итог уже в `Run.git`): main показывает уведомление. Без него ошибка видна только в подсказке
   * чипа ветки, а на «Проверке» человек ждёт готовый PR.
   */
  onPrFailed?(repoRoot: string, runId: string): void
}

/**
 * Хвост жизни ветки глобальной задачи, по любому изменению доски (`projects.onChange`):
 * - прогон закрыт (карточка на «Проверке») и включён push — `git push -u <remote> <ветка>` в фоне, итог в `Run.git`;
 * - ветка отправлена и включён `pr` — `gh pr create` в базу (или подхват уже открытого PR), итог — `prUrl`/`prError`;
 * - карточка в «Сделано», координатора и воркеров нет — worktree убирается, ветка остаётся.
 * Состояние попыток — в памяти: неудачный push не повторяется на каждом изменении доски (только после нового
 * закрытия или перезапуска), неудачная попытка открыть PR — до нового push или перезапуска, неудачная уборка —
 * до перезапуска.
 */
export class RunBranchSync {
  private pushTried = new Map<string, number>()
  /** Для какого `pushedAt` PR уже пробовали открыть: повтор — только после нового push. */
  private prTried = new Map<string, number>()
  private prOpening = new Set<string>()
  private pushing = new Set<string>()
  private keepWorktree = new Set<string>()

  constructor(private deps: RunBranchSyncDeps) {}

  sync(store: TaskStore, repoRoot: string, settings: RunBranchSettings): void {
    for (const run of store.listRuns()) {
      const g = run.git
      if (!g) continue
      if (settings.push && run.closedAt !== undefined && (g.pushedAt ?? 0) < run.closedAt &&
          this.pushTried.get(run.id) !== run.closedAt && !this.pushing.has(run.id)) {
        this.pushTried.set(run.id, run.closedAt)
        this.push(store, repoRoot, run.id, g.branch, settings)
      }
      this.maybeOpenPr(store, repoRoot, run.id, settings)
      if (g.worktree && !this.keepWorktree.has(g.worktree) && this.idleDone(store, run.id)) {
        if (removeRunWorktree(repoRoot, g.worktree)) store.setRunGit(run.id, { worktree: undefined })
        else this.keepWorktree.add(g.worktree)
      }
    }
  }

  /** Карточка в «Сделано», и в прогоне никто не работает: ни координатор, ни воркеры подзадач. */
  private idleDone(store: TaskStore, runId: string): boolean {
    const run = store.getRun(runId)
    if (!run?.status || store.columnKind(run.status) !== 'done') return false
    if (run.coordinatorPtyId && this.deps.isAlive(run.coordinatorPtyId)) return false
    const ids = new Set(store.listSubtasks(runId).map((t) => t.id))
    return !store.snapshot().dispatches.some((d) => ids.has(d.taskId) && this.deps.isAlive(d.ptyId))
  }

  /** Явный refspec: результат не зависит от `push.default` и upstream ветки у человека. */
  private push(store: TaskStore, repoRoot: string, runId: string, branch: string, settings: RunBranchSettings): void {
    this.pushing.add(runId)
    const ref = `refs/heads/${branch}`
    execFile('git', ['push', '--quiet', '-u', settings.remote, `${ref}:${ref}`], { cwd: repoRoot, env: NET_ENV, timeout: PUSH_TIMEOUT_MS }, (err, _out, stderr) => {
      this.pushing.delete(runId)
      // Глобальную задачу могли удалить, пока шёл push.
      if (!store.getRun(runId)?.git) return
      if (err) store.setRunGit(runId, { pushError: (stderr?.toString().trim() || err.message).slice(0, 2000) })
      else {
        store.setRunGit(runId, { pushedAt: Date.now(), pushError: undefined })
        this.maybeOpenPr(store, repoRoot, runId, settings)
      }
    })
  }

  /** PR открываем только для отправленной ветки без PR и один раз на каждый push (ошибка не повторяется сама). */
  private maybeOpenPr(store: TaskStore, repoRoot: string, runId: string, settings: RunBranchSettings): void {
    const g = store.getRun(runId)?.git
    if (!settings.enabled || !settings.pr || !g?.pushedAt || g.prUrl) return
    if (this.prTried.get(runId) === g.pushedAt || this.prOpening.has(runId)) return
    this.prTried.set(runId, g.pushedAt)
    this.prOpening.add(runId)
    void this.openPr(store, repoRoot, runId, settings)
      .finally(() => this.prOpening.delete(runId))
  }

  /**
   * Уже открытый PR ветки подхватываем (идемпотентность: приложение перезапустили, PR открыли руками), иначе
   * создаём обычный (не draft) PR в базу ветки. Текст — итоговая сводка координатора, без неё — описание задачи.
   */
  private async openPr(store: TaskStore, repoRoot: string, runId: string, settings: RunBranchSettings): Promise<void> {
    const gh = this.deps.gh ?? runGh
    const record = (patch: Partial<RunGit>): void => {
      // Глобальную задачу могли удалить, пока шёл gh.
      if (!store.getRun(runId)?.git) return
      store.setRunGit(runId, { prErrorCode: undefined, ...patch })
      if (patch.prError) this.deps.onPrFailed?.(repoRoot, runId)
    }
    const run = store.getRun(runId)
    const g = run?.git
    if (!run || !g) return
    const cwd = g.worktree && existsSync(g.worktree) ? g.worktree : repoRoot
    let bodyDir: string | undefined
    try {
      try {
        const view = JSON.parse(await gh(['pr', 'view', g.branch, '--json', 'url,state'], cwd)) as { url?: string; state?: string }
        if (view.url && view.state === 'OPEN') return record({ prUrl: view.url, prError: undefined })
      } catch (e) {
        // Нет PR — gh выходит с ошибкой; нет самого gh — дальше create не поможет.
        if ((e as { code?: string }).code === 'ENOENT') throw e
      }
      const base = prBaseBranch(g.base, settings.remote)
      if (!base) return record({ prError: 'не удалось определить базу PR: укажите «От чего ответвлять»', prErrorCode: 'other' })
      bodyDir = mkdtempSync(join(tmpdir(), 'orca-pr-'))
      const bodyFile = join(bodyDir, 'body.md')
      writeFileSync(bodyFile, run.summary?.text?.trim() || run.objective)
      const out = await gh(['pr', 'create', '--head', g.branch, '--base', base, '--title', globalTaskTitle(run), '--body-file', bodyFile], cwd)
      const url = out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop()
      if (!url) return record({ prError: `gh pr create не вернул ссылку: ${out.trim()}`.slice(0, PR_ERROR_LIMIT), prErrorCode: 'other' })
      record({ prUrl: url, prError: undefined })
    } catch (e) {
      record({ prError: ghErrorText(e), prErrorCode: ghErrorCode(e) })
    } finally {
      if (bodyDir) rmSync(bodyDir, { recursive: true, force: true })
    }
  }
}
