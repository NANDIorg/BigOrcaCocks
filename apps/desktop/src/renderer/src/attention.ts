import { isPendingRequest, type ColumnKind, type Dispatch, type HumanRequest, type Question, type RequestResolution, type Task } from '@orca-board/core'
import { t, type TKey } from './i18n'
import { requestShowcase } from './showcase'

// Лента «Ждут вас» на экране глобальной задачи (AttentionFeed.tsx): всё, что ждёт человека, одним списком.
// Здесь — только решения без React и IPC: что попадает в ленту, в каком порядке и без дублей.

/**
 * Что ждёт человека. `failure` — упавший, вышедший без `done` или молчащий воркер (и эскалация-запрос), `question` —
 * вопрос воркера, `approval` / `showcase` — этап воркфлоу «человек» (со сданным показом — `showcase`),
 * `answer` — готовый ответ задачи-ответа, `review` — задача ждёт ревью в колонке «Ревью».
 */
export type AttentionKind = 'failure' | 'question' | 'showcase' | 'approval' | 'answer' | 'review'

/** Почему воркер в сбое: `failed` — упал, `unknown` — вышел без `done`, `stuck` — молчит. */
export type AttentionFailure = 'failed' | 'unknown' | 'stuck'

/**
 * Откуда пункт: `request` — pending `HumanRequest` (решается через `requests.resolve`), `question` — открытый вопрос
 * без запроса (ждёт координатора; отвечает `questions.answer`), `task` — состояние самой задачи (сбой, ответ или
 * ревью без запроса: перезапуск, «Принять» / «Вернуть» через review-действия).
 */
export type AttentionSource = 'request' | 'question' | 'task'

export interface AttentionItem {
  /** Стабильный ключ пункта: не меняется, пока пункт жив (React key, подсветка, `data-attn-id`). */
  id: string
  kind: AttentionKind
  source: AttentionSource
  taskId: string
  /** Когда пункт возник (epoch ms): по нему порядок внутри вида и «N мин назад». */
  at: number
  /** Суть одной строкой: вопрос, сводка ответа, причина сбоя. */
  title: string
  request?: HumanRequest
  question?: Question
  /** Последний запуск задачи: сводка ответа, файлы ревью, исход сбоя. */
  dispatch?: Dispatch
  failure?: AttentionFailure
  /** Показ approval: подписи файлов на карточке ленты. */
  showcaseFiles?: string[]
}

export interface AttentionInput {
  /** Подзадачи этой глобальной задачи. */
  tasks: readonly Task[]
  /** Запросы проекта: берутся pending этой глобальной задачи (`runId`). */
  requests: readonly HumanRequest[]
  questions: readonly Question[]
  dispatches: readonly Dispatch[]
  /** Глобальная задача: чужие запросы проекта в ленту не попадают. */
  runId: string
  /** Вид колонки по статусу задачи (`BoardColumn.kind`). */
  kindOf(status: string): ColumnKind | undefined
  /** Задачи с открытым терминалом: у них сбой прошлого запуска уже не актуален. */
  running?: ReadonlySet<string>
}

/** Порядок видов: сначала сбои и вопросы, затем показ / решение, готовые ответы и ревью. */
const KIND_RANK: Record<AttentionKind, number> = { failure: 0, question: 1, showcase: 2, approval: 2, answer: 3, review: 4 }

/** Исход последнего запуска → вид сбоя (`undefined` — запуск в порядке или идёт). */
export function failureOf(d: Dispatch | undefined): AttentionFailure | undefined {
  if (!d) return undefined
  if (d.outcome === 'failed') return 'failed'
  if (d.outcome === 'unknown') return 'unknown'
  if (d.stuckNotified && !d.endedAt) return 'stuck'
  return undefined
}

const FAILURE_TITLE: Record<AttentionFailure, TKey> = {
  failed: 'shell.attention.failure.failed',
  unknown: 'shell.attention.failure.unknown',
  stuck: 'shell.attention.failure.stuck'
}

/**
 * Пункты ленты глобальной задачи. Дубли исключены: вопрос, по которому есть pending-запрос, — один пункт (запрос);
 * эскалация-запрос и сбой той же задачи — один пункт (запрос); готовый ответ / ревью не дублируют pending-запрос
 * задачи. Порядок — по виду (`KIND_RANK`), внутри вида — старые сверху (дольше всех ждут).
 */
export function buildAttention(input: AttentionInput): AttentionItem[] {
  const { tasks, requests, questions, dispatches, runId, kindOf, running } = input
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const lastDispatch = new Map<string, Dispatch>()
  dispatches.forEach((d) => lastDispatch.set(d.taskId, d))
  const dispatchById = new Map(dispatches.map((d) => [d.id, d]))

  const pending = requests.filter((r) => isPendingRequest(r) && r.runId === runId)
  const pendingByTask = new Map<string, HumanRequest[]>()
  pending.forEach((r) => {
    if (r.taskId !== undefined) pendingByTask.set(r.taskId, [...(pendingByTask.get(r.taskId) ?? []), r])
  })
  const hasPending = (taskId: string, kind?: HumanRequest['kind']): boolean =>
    (pendingByTask.get(taskId) ?? []).some((r) => kind === undefined || r.kind === kind)

  const items: AttentionItem[] = []

  for (const r of pending) {
    // Запрос уровня прогона (approval ноды `human`, выбор ветки `decision`) без задачи: лента строится по задачам и
    // пока его не показывает.
    if (r.taskId === undefined || r.kind === 'decision') continue
    const d = r.dispatchId ? dispatchById.get(r.dispatchId) : undefined
    const showcase = requestShowcase(r, dispatches)
    const kind: AttentionKind = r.kind === 'escalation' ? 'failure' : r.kind === 'approval' ? (showcase ? 'showcase' : 'approval') : r.kind
    items.push({
      id: `req:${r.id}`,
      kind,
      source: 'request',
      taskId: r.taskId,
      at: r.createdAt,
      title: r.title,
      request: r,
      ...(d ? { dispatch: d } : {}),
      ...(kind === 'failure' && failureOf(d) ? { failure: failureOf(d) } : {}),
      ...(showcase && showcase.files.length > 0 ? { showcaseFiles: showcase.files } : {})
    })
  }

  const withRequest = new Set(pending.map((r) => r.questionId).filter((id): id is string => id !== undefined))
  for (const q of questions) {
    const task = taskById.get(q.taskId)
    // Вопрос прошлого запуска уже никому не нужен (как `currentQuestion` в store).
    if (q.answeredAt || !task || withRequest.has(q.id) || (q.dispatchId !== undefined && task.dispatchId !== q.dispatchId)) continue
    const d = q.dispatchId ? dispatchById.get(q.dispatchId) : undefined
    items.push({ id: `q:${q.id}`, kind: 'question', source: 'question', taskId: q.taskId, at: q.createdAt, title: q.question, question: q, ...(d ? { dispatch: d } : {}) })
  }

  for (const task of tasks) {
    const kind = kindOf(task.status)
    if (kind === 'done') continue
    const d = lastDispatch.get(task.id)
    const failure = failureOf(d)
    if (d && failure && !running?.has(task.id) && !hasPending(task.id, 'escalation')) {
      items.push({ id: `fail:${task.id}`, kind: 'failure', source: 'task', taskId: task.id, at: d.endedAt ?? d.startedAt, title: t(FAILURE_TITLE[failure]), dispatch: d, failure })
    }
    if (task.answerFor === 'human' && (kind === 'needs_input' || kind === 'review') && d?.outcome === 'done' && d.answer !== undefined && !hasPending(task.id, 'answer')) {
      items.push({ id: `ans:${task.id}`, kind: 'answer', source: 'task', taskId: task.id, at: d.endedAt ?? task.updatedAt, title: d.summary || t('shell.attention.answerReady'), dispatch: d })
    }
    if (kind === 'review' && !task.answerFor && !task.gateFor && !hasPending(task.id)) {
      const files = d?.files?.length ?? 0
      items.push({ id: `rev:${task.id}`, kind: 'review', source: 'task', taskId: task.id, at: d?.endedAt ?? task.updatedAt, title: files > 0 ? t('shell.attention.reviewFiles', { count: files }) : t('shell.attention.review'), ...(d ? { dispatch: d } : {}) })
    }
  }

  return items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.at - b.at || a.id.localeCompare(b.id))
}

/**
 * Задачи, у которых есть пункт ленты. Единственный источник «ждёт человека» для доски: фильтр «Ждут вас», его
 * счётчик и ссылка «в ленте ↑» на карточке берут именно этот набор, а не пересчитывают состояние карточки сами.
 */
export function attentionTaskIds(items: readonly AttentionItem[]): Set<string> {
  return new Set(items.map((i) => i.taskId))
}

/** Пункт ленты, к которому ведёт «в ленте ↑» с карточки: первый по порядку ленты (самый срочный вид). */
export function feedItemOfTask(items: readonly AttentionItem[], taskId: string): AttentionItem | undefined {
  return items.find((i) => i.taskId === taskId)
}

/**
 * Подсказка к счётчику ленты, когда пунктов больше, чем задач: у одной задачи бывает несколько пунктов (два запроса),
 * а фильтр «Ждут вас» на доске считает задачи. Иначе (обычно) числа совпадают и пояснять нечего.
 */
export function attentionCountTitle(items: readonly AttentionItem[]): string | undefined {
  const tasks = attentionTaskIds(items).size
  if (tasks === items.length) return undefined
  return t('shell.attention.countTitle', {
    items: t('shell.attention.countItems', { count: items.length }),
    tasks: t('shell.attention.countTasks', { count: tasks })
  })
}

/** Подпись вида пункта (текстовый сигнал рядом с цветной кромкой). */
export function attentionLabel(item: Pick<AttentionItem, 'kind' | 'failure' | 'question'>): string {
  switch (item.kind) {
    case 'failure':
      return t(item.failure ? `shell.attention.label.${item.failure}` : 'shell.attention.label.failure')
    case 'question': return t('shell.attention.label.question')
    case 'showcase': return t('shell.attention.label.showcase')
    case 'approval': return t('shell.attention.label.approval')
    case 'answer': return t('shell.attention.answerReady')
    case 'review': return t('shell.attention.review')
  }
}

/** Глиф вида пункта: только украшение (подпись всегда есть текстом). */
export const ATTENTION_GLYPH: Record<AttentionKind, string> = { failure: '✕', question: '?', showcase: '◉', approval: '✋', answer: '✎', review: '◎' }

/** Цвет кромки вида пункта: токены `styles.css`. */
export const ATTENTION_COLOR: Record<AttentionKind, string> = {
  failure: 'var(--danger)',
  question: 'var(--col-input)',
  showcase: 'var(--col-review)',
  approval: 'var(--col-review)',
  answer: 'var(--col-input)',
  review: 'var(--col-review)'
}

/** Порядок видов в сводке: сбои — первыми, как в ленте. */
const SUMMARY_KINDS: AttentionKind[] = ['failure', 'question', 'showcase', 'approval', 'answer', 'review']

/** Сводка свёрнутой ленты: «1 вопрос · 1 показ · 1 ответ · 1 сбой» (сбои — первыми, как в ленте). */
export function attentionSummary(items: readonly AttentionItem[]): string {
  return SUMMARY_KINDS
    .map((kind) => ({ kind, count: items.filter((i) => i.kind === kind).length }))
    .filter((p) => p.count > 0)
    .map((p) => t(`shell.attention.sum.${p.kind}`, { count: p.count }))
    .join(' · ')
}

/** Ключ localStorage: свёрнутость ленты одна на все глобальные задачи, как сортировка доски. */
export const ATTENTION_COLLAPSED_KEY = 'orca.attention.collapsed'

/** Сохранённая свёрнутость; `null` — выбора не было (или localStorage недоступен). */
export function readCollapsed(): boolean | null {
  try {
    const v = localStorage.getItem(ATTENTION_COLLAPSED_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

export function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(ATTENTION_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // localStorage недоступен — выбор просто не переживёт перезапуск
  }
}

/** Ширина окна, до которой лента без сохранённого выбора сворачивается при длинном списке. */
export const ATTENTION_NARROW_WIDTH = 900

/** Сколько пунктов ещё влезает в узкое окно развёрнутой лентой. */
export const ATTENTION_NARROW_LIMIT = 3

/** Свёрнута ли лента, если человек выбора не делал: в узком окне при 4+ пунктах — да, иначе развёрнута. */
export function defaultCollapsed(count: number, width: number): boolean {
  return width <= ATTENTION_NARROW_WIDTH && count > ATTENTION_NARROW_LIMIT
}

/**
 * Вопрос без запроса как запрос-«вопрос»: RequestCard рисует один и тот же ввод и для запроса, и для вопроса
 * координатору. Id с префиксом `q:` — чтобы не спутать с настоящим запросом.
 */
export function questionAsRequest(q: Question, runId: string): HumanRequest {
  return {
    id: `q:${q.id}`,
    runId,
    taskId: q.taskId,
    ...(q.dispatchId ? { dispatchId: q.dispatchId } : {}),
    kind: 'question',
    status: 'pending',
    title: q.question,
    ...(q.context ? { body: q.context } : {}),
    options: q.options,
    questionId: q.id,
    createdAt: q.createdAt
  }
}

/** Текст ответа на вопрос (`questions.answer`) из решения RequestCard: вариант — его метка, свой ответ — как есть. */
export function questionAnswerText(q: Question, resolution: RequestResolution): string {
  if (resolution.action !== 'answer') throw new Error(t('shell.attention.error.answerOnly'))
  if (resolution.optionId !== undefined) {
    const o = q.options.find((opt) => opt.id === resolution.optionId)
    if (!o) throw new Error(t('shell.attention.error.noOption', { question: q.question, option: resolution.optionId }))
    return o.label
  }
  const text = resolution.text?.trim()
  if (!text) throw new Error(t('shell.attention.error.empty'))
  return text
}
