import { AGENT_TITLES, GLOBAL_REVIEW_TITLE, wfNodeTitle, type ColumnKind, type WfIssue, type WfNode } from '@orca-board/core'
import { RU } from './i18n/dict'
import { t, type TKey } from './i18n'

// Встроенные названия, которые core кладёт в данные по-русски (колонки по умолчанию, системные роли, заготовки типов
// задач с их ролями и нодами воркфлоу), показываются на языке интерфейса, пока человек их не переименовал. Узнаём их
// по точному тексту из словаря `builtin` (он совпадает с core — это сверяет тест). Сохранённые данные не меняются:
// перевод только при показе. Поля ввода в редакторах показывают данные как есть — иначе автосохранение записало
// бы перевод в проект. docs/architecture.md → «Язык интерфейса» → «Встроенные названия».

let reverse: Map<string, TKey> | undefined

/** Русский текст встроенного названия → ключ словаря `builtin`. */
function builtinKeys(): Map<string, TKey> {
  if (!reverse) {
    reverse = new Map()
    for (const [key, text] of Object.entries(RU.builtin)) {
      if (!reverse.has(text)) reverse.set(text, `builtin.${key}` as TKey)
    }
  }
  return reverse
}

/**
 * Встроенный русский текст из core — на языке интерфейса; любой другой (переименованный, введённый человеком) —
 * как есть. Название ноды-условия из заготовки — «<название этапа>?» — тоже узнаётся.
 */
export function builtinText(text: string): string {
  const key = builtinKeys().get(text)
  if (key) return t(key)
  if (text.endsWith('?')) {
    const base = builtinKeys().get(text.slice(0, -1))
    if (base) return `${t(base)}?`
  }
  return text
}

/** Название колонки доски (глобальной тоже) для показа. */
export function columnTitle(c: { title: string }): string {
  return builtinText(c.title)
}

/** Колонки для показа: те же id и виды, встроенные названия переведены. В редактор колонок — только исходные. */
export function displayColumns<C extends { title: string; kind: ColumnKind }>(columns: readonly C[]): C[] {
  return columns.map((c) => ({
    ...c,
    // «Проверка» глобальной доски совпадает по тексту с нодой «Проверка» — узнаём её по виду колонки.
    title: c.kind === 'review' && c.title === GLOBAL_REVIEW_TITLE ? t('builtin.global.review') : columnTitle(c)
  }))
}

/** Название роли для показа. */
export function roleTitle(r: { title: string }): string {
  return builtinText(r.title)
}

/** Роли для показа (карточки, модалки, терминалы): встроенные название и назначение переведены, id и агент — те же. */
export function displayRoles<R extends { title: string; description?: string }>(roles: readonly R[]): R[] {
  return roles.map((r) => ({ ...r, title: builtinText(r.title), ...(r.description ? { description: builtinText(r.description) } : {}) }))
}

/** Название и описание типа задачи для показа. */
export function typeTitle(type: { title: string }): string {
  return builtinText(type.title)
}

/** Название ноды воркфлоу: своё или название типа (`wfNodeTitle`); встроенные — на языке интерфейса. */
export function nodeTitle(n: WfNode): string {
  return builtinText(wfNodeTitle(n))
}

/** Подпись модели из реестра core или кэша Codex: «Opus (актуальный)», «gpt-5 (по умолчанию)» — на языке интерфейса. */
export function modelTitle(label: string): string
export function modelTitle(label: string | undefined): string | undefined
export function modelTitle(label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  // Суффикс core — русский: « (по умолчанию)» из того же шаблона словаря.
  const suffix = RU.builtin['model.default'].replace('{name}', '')
  if (label.endsWith(suffix)) return t('builtin.model.default', { name: label.slice(0, -suffix.length) })
  return builtinText(label)
}

/** Название агента: из реестра core («Оболочка» — переведённая), неизвестный — его id. */
export function agentTitle(id: string): string {
  const title = (AGENT_TITLES as Record<string, string | undefined>)[id]
  return title ? builtinText(title) : id
}

/**
 * Текст проблемы воркфлоу (`validateWorkflow`) на языке интерфейса: по коду и параметрам. Проблема без кода
 * (от старой версии core) — её русский `message`.
 */
export function wfIssueText(i: Pick<WfIssue, 'code' | 'params' | 'message' | 'subflowOf'>): string {
  if (!i.code) return i.message
  const key = `config.wf.issue.${i.code}` as TKey
  const text = t(key, i.params)
  if (text === key) return i.message
  // Проблема внутри пути подзадачи: core отдаёт префикс по-русски, renderer добавляет свой на языке интерфейса.
  return i.subflowOf ? `${t('config.wf.path.issuePrefix', { node: i.subflowOf.title })}${text}` : text
}
