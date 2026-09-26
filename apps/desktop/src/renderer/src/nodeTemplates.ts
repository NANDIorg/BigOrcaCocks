import {
  WF_PORTS, stableJson, validateNodeTemplate,
  type WfNode, type WfNodeTemplate, type WfTemplateNode, type Workflow
} from '@orca-board/core'
import type { NodeTemplateInput, OrcaApi } from '../../shared/ipc'
import { t } from './i18n'
import { formatDateTime } from './i18n/format'
import { nodeTitle, wfIssueText } from './defaultTitles'
import { uniqueId } from './workflowEdit'
import { subflowSummary, type WfScope } from './workflowNav'
import { WF_TYPE_TITLES } from './workflowForm'

// «Свои ноды» в редакторе воркфлоу — чистые функции. Библиотека шаблонов лежит в main (`nodeTemplates:*`), а вставка —
// копия ноды с `templateId`: граф остаётся самодостаточным, шаблон можно править и удалять без последствий для
// прогонов. Ссылка на шаблон нужна только редактору — «Шаблон изменился: обновить».

/**
 * Renderer приходит по HMR, а main и preload остаются старыми до перезапуска: у старого preload нет
 * `window.orca.nodeTemplates`, у старого main — хендлеров `nodeTemplates:*`.
 */
export function nodeTemplatesStaleMessage(): string {
  return t('config.nodeTpl.stale')
}

/** `window.orca.nodeTemplates` или понятная ошибка вместо «Cannot read properties of undefined». */
export function nodeTemplatesApi(api: Partial<OrcaApi> | undefined): OrcaApi['nodeTemplates'] {
  if (!api?.nodeTemplates) throw new Error(nodeTemplatesStaleMessage())
  return api.nodeTemplates
}

/** Текст ошибки IPC библиотеки: preload новый, а main старый — «перезапустите приложение». */
export function nodeTemplatesError(message: string): string {
  return /No handler registered for 'nodeTemplates:/.test(message) ? nodeTemplatesStaleMessage() : message
}

const clone = <T>(v: T): T => structuredClone(v)

/** Библиотека шаблонов для редактора воркфлоу и списка в «Настройках» (`useNodeTemplates`). */
export interface NodeTemplatesHook {
  /** Шаблоны в порядке хранения; `null` — ещё не загружены или недоступны (`error`). */
  templates: WfNodeTemplate[] | null
  /** Ошибка загрузки (в том числе старый main/preload). */
  error: string | null
  /** Нет `window.orca.nodeTemplates` — preload старый, библиотека работать не может. */
  stale: boolean
  /** Создать (без `id`) или заменить шаблон; ошибка — наружу, с текстом «перезапустите» для старого main. */
  save(input: NodeTemplateInput): Promise<WfNodeTemplate>
  remove(id: string): Promise<void>
}

/** Нода в виде шаблона: копия без id, позиции и ссылки на шаблон — это данные самой ноды, а не её место в графе. */
export function templateNodeOf(node: WfNode): WfTemplateNode {
  const { id: _id, x: _x, y: _y, templateId: _templateId, ...rest } = clone(node)
  return rest as WfTemplateNode
}

/** Тело для `nodeTemplates:save`: новый шаблон (без `id`) или замена существующего. */
export function templateInput(node: WfNode, title: string, description = '', id?: string): NodeTemplateInput {
  const text = description.trim()
  return { ...(id !== undefined ? { id } : {}), title: title.trim(), ...(text ? { description: text } : {}), node: templateNodeOf(node) }
}

/** Переименование: те же `id` и тело, новые название и описание (main заменяет шаблон целиком и ставит `updatedAt`). */
export function renamedTemplateInput(template: WfNodeTemplate, title: string, description = ''): NodeTemplateInput {
  const text = description.trim()
  return { id: template.id, title: title.trim(), ...(text ? { description: text } : {}), node: clone(template.node) }
}

/** Название по умолчанию для «Сохранить как свою ноду»: то, что видно на холсте. */
export function defaultTemplateTitle(node: WfNode): string {
  return nodeTitle(node)
}

/**
 * Почему шаблон нельзя вставить в граф этой области; `null` — можно. В граф типа (`'run'`) годится любой сохранённый
 * шаблон, в путь подзадачи — без «Вопроса человеку» и без вложенного пути: причину называет проверка core.
 */
export function templateMisfit(template: WfNodeTemplate, scope: WfScope): string | null {
  if (scope === 'run') return null
  const { errors } = validateNodeTemplate(template, { scope, nodeTitle: (n) => nodeTitle(n) })
  return errors.length > 0 ? wfIssueText(errors[0]) : null
}

/** Вставка копии шаблона в граф: новый id по типу ноды, позиция `x`/`y`, `templateId` — на шаблон. */
export function insertTemplate(wf: Workflow, template: WfNodeTemplate, x: number, y: number): { workflow: Workflow; nodeId: string } {
  const copy = clone(template.node)
  const id = uniqueId(copy.type, wf.nodes.map((n) => n.id))
  const node = { ...copy, id, x, y, templateId: template.id } as WfNode
  return { workflow: { ...wf, nodes: [...wf.nodes, node] }, nodeId: id }
}

/** Как нода соотносится со своим шаблоном. */
export type TemplateSync =
  /** Вставлена не из шаблона. */
  | { kind: 'none' }
  /** Библиотека не загружена (старый main, ошибка) — судить нельзя. */
  | { kind: 'unknown'; templateId: string }
  /** Шаблон удалён: копия остаётся самостоятельной нодой. */
  | { kind: 'missing'; templateId: string }
  | { kind: 'same'; template: WfNodeTemplate }
  | { kind: 'differs'; template: WfNodeTemplate }

/**
 * Сверка ноды с шаблоном по содержимому: узел не хранит, когда его копировали, поэтому «шаблон изменился» узнаём
 * не по `updatedAt`, а по тому, что тело шаблона и ноды разошлось (`updatedAt` показываем как подсказку). Так
 * шаблон, пересохранённый без изменений, не тревожит, а правка самой ноды тоже видна — обновление вернёт её к шаблону.
 */
export function templateSync(node: WfNode, templates: readonly WfNodeTemplate[] | null): TemplateSync {
  if (node.templateId === undefined) return { kind: 'none' }
  if (!templates) return { kind: 'unknown', templateId: node.templateId }
  const template = templates.find((x) => x.id === node.templateId)
  if (!template) return { kind: 'missing', templateId: node.templateId }
  const same = stableJson(templateNodeOf(node)) === stableJson(template.node)
  return { kind: same ? 'same' : 'differs', template }
}

/**
 * «Обновить из шаблона»: тело ноды заменяется телом шаблона, id, позиция и переходы остаются. Если у шаблона другой
 * тип, а у ноды есть переходы по портам, которых у нового типа нет, — эти переходы убираются.
 */
export function applyTemplate(wf: Workflow, nodeId: string, template: WfNodeTemplate): Workflow {
  const node = wf.nodes.find((n) => n.id === nodeId)
  if (!node || node.type === 'start') return wf
  const next = { ...clone(template.node), id: node.id, x: node.x, y: node.y, templateId: template.id } as WfNode
  return {
    ...wf,
    nodes: wf.nodes.map((n) => (n.id === nodeId ? next : n)),
    edges: wf.edges.filter((e) => e.from !== nodeId || WF_PORTS[next.type].includes(e.outcome))
  }
}

/** Нода после «Сохранить как свою»: ссылка на только что созданный или переписанный шаблон. */
export function linkTemplate(wf: Workflow, nodeId: string, templateId: string): Workflow {
  if (!wf.nodes.some((n) => n.id === nodeId)) return wf
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === nodeId ? { ...n, templateId } : n)) }
}

/** Вторая строка шаблона: тип ноды и, у «Работы» со своим путём, что делает путь («ревью + мерж»). */
export function templateSummary(template: WfNodeTemplate): string {
  const node = template.node
  const path = node.type === 'work' && node.subflow !== undefined ? subflowSummary(node.subflow) : ''
  return path ? t('config.nodeTpl.summaryPath', { type: WF_TYPE_TITLES[node.type], steps: path }) : WF_TYPE_TITLES[node.type]
}

/** Подсказка шаблона: описание (если есть), тип и когда обновлён. */
export function templateHint(template: WfNodeTemplate): string {
  return [template.description, templateSummary(template), t('config.nodeTpl.updated', { date: formatDateTime(template.updatedAt) })]
    .filter(Boolean)
    .join('\n')
}

/** Список после записи шаблона: существующий заменён на месте, новый — в конце (как хранит main). */
export function withTemplate(list: readonly WfNodeTemplate[], saved: WfNodeTemplate): WfNodeTemplate[] {
  const i = list.findIndex((x) => x.id === saved.id)
  return i === -1 ? [...list, saved] : list.map((x, k) => (k === i ? saved : x))
}
