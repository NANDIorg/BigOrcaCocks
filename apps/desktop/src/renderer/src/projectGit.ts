import type { OrcaApi, ProjectBranchList, ProjectBranchUpstream, ProjectGitErrorCode, ProjectLocalBranch } from '../../shared/ipc'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'
import { t } from './i18n'

/** Git-методы корня проекта: в новом main/preload они есть все, в старом — ни одного. */
export interface ProjectGitApi {
  branches: NonNullable<OrcaApi['projects']['branches']>
  gitFetch: NonNullable<OrcaApi['projects']['gitFetch']>
  gitPull: NonNullable<OrcaApi['projects']['gitPull']>
  checkoutBranch: NonNullable<OrcaApi['projects']['checkoutBranch']>
}

/**
 * Git-методы `window.orca.projects` или null: renderer пришёл по HMR, а preload старый (`pnpm dev`,
 * docs/architecture.md → «Грабли разработки»). Вызывающий показывает `staleGitMessage()` вместо падения.
 */
export function projectGitApi(api: Partial<OrcaApi> | undefined): ProjectGitApi | null {
  const p = api?.projects
  if (!p) return null
  const { branches, gitFetch, gitPull, checkoutBranch } = p
  if (!branches || !gitFetch || !gitPull || !checkoutBranch) return null
  return { branches: branches.bind(p), gitFetch: gitFetch.bind(p), gitPull: gitPull.bind(p), checkoutBranch: checkoutBranch.bind(p) }
}

export function staleGitMessage(): string {
  return t('shell.branch.staleApp')
}

/** Preload новый, а main старый: invoke падает с «No handler registered for 'projects:…'». */
export function isStaleGitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /No handler registered for 'projects:/.test(msg)
}

/** Что известно о месте ошибки: подставляется в тексты кодов, у которых main присылает параметр `branch`. */
export interface GitErrorContext {
  branch?: string
}

const KNOWN_CODES: Record<Exclude<ProjectGitErrorCode, 'git.opFailed'>, (ctx: GitErrorContext) => string> = {
  'git.notRepo': () => t('shell.branch.err.notRepo'),
  'git.dirtyTree': () => t('shell.branch.err.dirtyTree'),
  'git.notFastForward': (ctx) => t('shell.branch.err.notFastForward', { branch: ctx.branch ?? 'HEAD' }),
  'git.noUpstream': (ctx) => t('shell.branch.err.noUpstream', { branch: ctx.branch ?? 'HEAD' }),
  'git.branchBusy': (ctx) => t('shell.branch.err.branchBusy', { branch: ctx.branch ?? '' }),
  'git.workersActive': () => t('shell.branch.err.workersActive'),
  'git.branchNotFound': (ctx) => t('shell.branch.err.branchNotFound', { branch: ctx.branch ?? '' })
}

/**
 * Текст ошибки git-операции по коду `OrcaError` (`ipcErrorCode`), а не по тексту main. Прочие отказы
 * (`git.opFailed`, неизвестный код, сообщение старого main) — сообщение main как есть: в нём stderr git.
 */
export function gitErrorMessage(e: unknown, ctx: GitErrorContext = {}): string {
  if (isStaleGitError(e)) return staleGitMessage()
  const code = ipcErrorCode(e)
  if (code && code in KNOWN_CODES) return KNOWN_CODES[code as keyof typeof KNOWN_CODES](ctx)
  return ipcErrorMessage(e).trim() || t('shell.branch.err.generic')
}

/** Список веток после фильтра: то, что рисует меню. */
export interface BranchView {
  local: ProjectLocalBranch[]
  /** Полные имена `origin/x` — без тех, у которых уже есть локальная ветка. */
  remote: string[]
}

/** Локальное имя для `origin/feature/x` → `feature/x` (первый сегмент — имя remote). */
export function remoteLocalName(remote: string): string {
  const i = remote.indexOf('/')
  return i < 0 ? remote : remote.slice(i + 1)
}

/**
 * Ветки для меню: текущая — первой, остальные локальные — по имени; удалённые без дублей локальных
 * (checkout `origin/x` при существующей `x` — просто переключение на `x`). Запрос — подстрока без учёта регистра.
 */
export function filterBranches(list: Pick<ProjectBranchList, 'local' | 'remote'>, query: string): BranchView {
  const q = query.trim().toLowerCase()
  const match = (name: string): boolean => !q || name.toLowerCase().includes(q)
  const localNames = new Set(list.local.map((b) => b.name))
  const local = list.local
    .filter((b) => match(b.name))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
  const remote = list.remote.filter((r) => !localNames.has(remoteLocalName(r)) && match(r))
  return { local, remote }
}

/** Куда переключит Enter в поиске: первая подходящая не текущая и не занятая ветка (локальные раньше удалённых). */
export function firstPickable(view: BranchView): string | null {
  const local = view.local.find((b) => !b.current && !b.busy)
  return local?.name ?? view.remote[0] ?? null
}

/** «↑2 ↓1» для ahead/behind; пусто, если ветка синхронна (или upstream пропал — считать нечего). */
export function aheadBehindLabel(u: Pick<ProjectBranchUpstream, 'ahead' | 'behind' | 'gone'> | undefined): string {
  if (!u || u.gone) return ''
  return [u.ahead > 0 ? `↑${u.ahead}` : '', u.behind > 0 ? `↓${u.behind}` : ''].filter(Boolean).join(' ')
}

/** Строка про upstream текущей ветки: имя и расхождение; нет upstream — пометка. */
export function upstreamLine(u: ProjectBranchUpstream | undefined): string {
  if (!u) return t('shell.branch.noUpstream')
  if (u.gone) return t('shell.branch.upstreamGone', { name: u.name })
  const diff = aheadBehindLabel(u)
  return diff ? `${u.name} · ${diff}` : `${u.name} · ${t('shell.branch.inSync')}`
}

/** Вывод git для показа: пустой — «Готово»; длинный — только хвост (итоговые строки git внизу). */
export function gitOutputText(output: string, maxLines = 12): string {
  const text = output.trimEnd()
  if (!text.trim()) return t('shell.branch.done')
  const lines = text.split('\n')
  return lines.length > maxLines ? ['…', ...lines.slice(-maxLines)].join('\n') : text
}
