import type { InitialCommitMode, OrcaApi } from '../../shared/ipc'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'
import { t } from './i18n'

/**
 * Запуск координатора или воркера упал: в репозитории проекта нет ни одного коммита (unborn HEAD). Worktree
 * ответвляется от коммита, поэтому main отказывает `OrcaError('git.noCommits')`, а renderer предлагает создать
 * начальный коммит (`InitialCommitDialog`). Узнаём по коду, не по тексту: текст переведён.
 */
export function isNoCommitsError(e: unknown): boolean {
  return ipcErrorCode(e) === 'git.noCommits'
}

/** Методы, нужные диалогу: `createInitialCommit` обязателен, остальное — только для подсказок. */
export interface InitialCommitApi {
  createInitialCommit: NonNullable<OrcaApi['projects']['createInitialCommit']>
  /** Есть ли файлы в корне (`dirty`) и имя ветки. Нет в старом preload — режим по умолчанию `snapshot`. */
  branches?: NonNullable<OrcaApi['projects']['branches']>
  /** Есть ли `.gitignore` в корне. Нет в старом preload — предупреждение не показываем. */
  listFiles?: OrcaApi['files']['list']
}

/**
 * Методы для начального коммита или null: renderer пришёл по HMR, а preload старый (`pnpm dev`, docs/architecture.md →
 * «Грабли разработки»). Вызывающий показывает `staleInitialCommitMessage()` вместо падения.
 */
export function initialCommitApi(api: Partial<OrcaApi> | undefined): InitialCommitApi | null {
  const p = api?.projects
  if (!p?.createInitialCommit) return null
  const files = api?.files
  return {
    createInitialCommit: p.createInitialCommit.bind(p),
    branches: p.branches?.bind(p),
    listFiles: files?.list ? files.list.bind(files) : undefined
  }
}

export function staleInitialCommitMessage(): string {
  return t('shell.initialCommit.staleApp')
}

/**
 * Текст отказа `createInitialCommit`: preload новый, а main старый («No handler registered») — «перезапустите
 * приложение»; иначе сообщение main как есть (`git.opFailed` несёт stderr git, `git.notRepo` уже переведён).
 */
export function initialCommitErrorMessage(e: unknown): string {
  const msg = ipcErrorMessage(e)
  if (/No handler registered for 'projects:/.test(msg)) return staleInitialCommitMessage()
  return msg.trim() || t('shell.initialCommit.failed')
}

/** Что диалог знает о корне. null — узнать не удалось (старый preload, ошибка): показываем без этой подсказки. */
export interface InitialCommitInfo {
  /** Имя будущей ветки (`symbolic-ref` у unborn HEAD). */
  branch: string | null
  /** В корне есть неигнорируемые файлы (`git status --porcelain` не пуст). */
  dirty: boolean | null
  /** В корне есть `.gitignore`. */
  gitignore: boolean | null
}

/**
 * Собрать подсказки для диалога из существующих каналов: `projects:branches` (ветка, `dirty`) и `files:list` корня
 * (`.gitignore`). Отказ любого — просто неизвестность, а не ошибка диалога: коммит всё равно можно создать.
 */
export async function loadInitialCommitInfo(api: InitialCommitApi, projectId: string): Promise<InitialCommitInfo> {
  const [list, files] = await Promise.all([
    api.branches ? api.branches(projectId).catch(() => null) : null,
    api.listFiles ? api.listFiles(projectId, '').catch(() => null) : null
  ])
  let gitignore: boolean | null = null
  if (files) {
    const found = files.entries.some((e) => e.name === '.gitignore' && e.kind !== 'dir')
    // Папка обрезана до лимита — «не нашли» ничего не значит.
    gitignore = found || !files.truncated ? found : null
  }
  return {
    branch: list?.current.branch ?? null,
    dirty: list ? list.dirty : null,
    gitignore
  }
}

/** Режим по умолчанию: есть файлы (или неизвестно) — коммит текущих файлов, иначе агентам нечего видеть — пустой. */
export function defaultInitialCommitMode(info: Pick<InitialCommitInfo, 'dirty'>): InitialCommitMode {
  return info.dirty === false ? 'empty' : 'snapshot'
}

/** Предупредить, что без `.gitignore` в коммит попадёт всё: только когда точно знаем, что его нет, а файлы есть. */
export function warnNoGitignore(info: Pick<InitialCommitInfo, 'dirty' | 'gitignore'>): boolean {
  return info.gitignore === false && info.dirty !== false
}
