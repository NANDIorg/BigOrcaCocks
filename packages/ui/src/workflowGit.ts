import {
  WF_GIT_BRANCH_PLACEHOLDERS, WF_GIT_DEFAULT_REMOTE, WF_GIT_FIELD_USE, WF_GIT_MESSAGE_PLACEHOLDERS, WF_GIT_OPERATIONS,
  isValidGitBranchName, renderGitTemplate, wfGitVars,
  type WfGitField, type WfGitOperation, type WfGitParams, type WfNode
} from '@orca-board/core'
import { t, type TKey } from './i18n'

// Нода «Git» в редакторе воркфлоу: какие поля показывать у операции, превью подстановок, подпись на холсте.
// Контракт полей — `WF_GIT_FIELD_USE` из core (тот же источник у валидации и исполнителя), здесь только показ.

export type WfGitNode = Extract<WfNode, { type: 'git' }>

/** Значения полей ноды `git`, которые правит форма; пустая строка — «не задано». */
export type WfGitPatch = Partial<Omit<WfGitParams, 'operation'>> & { operation?: WfGitOperation }

/**
 * Операции в порядке показа в select. В воркфлоу глобальной задачи у неё одна ветка, её имя задаёт шаблон проекта, поэтому
 * `create_branch` и `checkout` не предлагаются (валидация графа их запрещает — `gitRunOperation`).
 */
export const GIT_OPERATIONS: readonly WfGitOperation[] = WF_GIT_OPERATIONS.filter((op) => op === 'commit' || op === 'push')

/** Операция известна, но в графе глобальной задачи недоступна (`create_branch`, `checkout`): остаётся в select отключённой. */
export function isUnavailableGitOperation(op: unknown): op is WfGitOperation {
  return isGitOperation(op) && !GIT_OPERATIONS.includes(op)
}

/** Операция из известного списка. Граф из импорта или более новой версии может нести любую строку или не нести операции вовсе. */
export function isGitOperation(op: unknown): op is WfGitOperation {
  return typeof op === 'string' && (WF_GIT_OPERATIONS as readonly string[]).includes(op)
}

/** Название операции на языке интерфейса; у неизвестной — сама строка (у отсутствующей — «?»), а не ключ i18n. */
export function gitOperationTitle(op: WfGitOperation | string | undefined): string {
  if (isGitOperation(op)) return t(`config.wf.git.op.${op}` as TKey)
  return typeof op === 'string' && op ? op : '?'
}

/** Поле формы: имя, обязательное ли; порядок — как в `FIELD_ORDER`. */
export interface GitFieldSpec {
  field: WfGitField
  required: boolean
}

const FIELD_ORDER: readonly WfGitField[] = ['branch', 'base', 'message', 'remote']

/** Только поля выбранной операции: сначала обязательные по порядку формы, затем необязательные. Чужих полей нет. */
export function gitFieldsFor(op: WfGitOperation | string | undefined): GitFieldSpec[] {
  if (!isGitOperation(op)) return []
  const use = WF_GIT_FIELD_USE[op]
  const pick = (list: readonly WfGitField[], required: boolean): GitFieldSpec[] =>
    FIELD_ORDER.filter((f) => list.includes(f)).map((field) => ({ field, required }))
  return [...pick(use.required, true), ...pick(use.optional, false)]
}

/** Подстановки шаблона поля: у имени ветки — без `{title}`, у сообщения — все; у `base` и `remote` подстановок нет. */
export function gitPlaceholdersFor(field: WfGitField): readonly string[] {
  if (field === 'branch') return WF_GIT_BRANCH_PLACEHOLDERS
  if (field === 'message') return WF_GIT_MESSAGE_PLACEHOLDERS
  return []
}

/** Подсказка «подстановки: {taskId}, {slug}» для поля; у поля без подстановок — пустая строка. */
export function gitPlaceholdersHint(field: WfGitField): string {
  const list = gitPlaceholdersFor(field)
  return list.length === 0 ? '' : t('config.wf.git.placeholders', { list: list.map((p) => `{${p}}`).join(', ') })
}

/** Образцовая задача для превью: настоящую в редакторе типа задачи взять неоткуда. */
export function gitSampleVars(): Record<string, string> {
  return wfGitVars({ id: 'task_a1b2c3d4', title: t('config.wf.git.sampleTitle') })
}

/** Результат превью шаблона: текст и допустимость (для ветки — по правилам git). */
export interface GitPreview {
  text: string
  valid: boolean
}

/**
 * Превью шаблона на образцовой задаче. Пустой шаблон — `null` (показывать нечего). Для `branch` `valid` — годится ли
 * результат как имя ветки, для остальных полей — всегда true: их проверяет не форма, а валидация графа.
 */
export function gitPreview(field: 'branch' | 'message', template: string | undefined): GitPreview | null {
  const src = template?.trim()
  if (!src) return null
  const text = renderGitTemplate(src, gitSampleVars())
  return { text, valid: field === 'branch' ? isValidGitBranchName(text) : true }
}

/** Что показывает вторая строка ноды на холсте: «операция: значение». Пустая настройка — только операция. */
export function gitNodeSubtitle(node: WfGitNode): string {
  const op = gitOperationTitle(node.operation)
  const value =
    !isGitOperation(node.operation) ? undefined
    : node.operation === 'commit' ? node.message
    : node.operation === 'push' ? node.remote?.trim() || WF_GIT_DEFAULT_REMOTE
    : node.branch
  return value?.trim() ? `${op}: ${value.trim()}` : op
}

/**
 * Меняет поля ноды `git`. Смена операции убирает поля, которые новой операции не нужны: форма их не показывает, и
 * невидимое значение висело бы предупреждением «поле игнорируется», которое нечем исправить. Пустое обязательное
 * поле остаётся пустой строкой (его подсветит валидация, как у `ask`), пустое необязательное — удаляется.
 */
export function patchGit(node: WfGitNode, patch: WfGitPatch): WfGitNode {
  const next: WfGitNode = { ...node }
  if (isGitOperation(patch.operation)) next.operation = patch.operation
  // Операция ноды неизвестна — полей у неё нет, и решать, какие лишние, нельзя: правим только значения из патча.
  // Починить ноду можно сменой операции на известную (следующий вызов уже пройдёт по полной ветке).
  if (!isGitOperation(next.operation)) {
    for (const field of FIELD_ORDER) if (patch[field] !== undefined) next[field] = patch[field]
    return next
  }
  const use = WF_GIT_FIELD_USE[next.operation]
  for (const field of FIELD_ORDER) {
    const value = patch[field]
    if (value !== undefined) next[field] = value
    if (!use.required.includes(field) && !use.optional.includes(field)) delete next[field]
    else if (!next[field]?.trim() && !use.required.includes(field)) delete next[field]
  }
  for (const field of use.required) next[field] ??= ''
  return next
}
