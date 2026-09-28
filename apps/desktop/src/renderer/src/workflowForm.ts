import {
  WF_DECISION_MAX_OPTIONS, WF_PORTS, WORKFLOW_VERSION, isTaskRole, migrateWorkflowReport, wfPorts, wfWorkRoleIds,
  type Role, type WfCondition, type WfDecisionOption, type WfMigrationNote, type WfNode, type WfNodeType, type WfPort, type Workflow
} from '@orca-board/core'
import { NODE_H, NODE_W, nodeHeight } from './workflowGeometry'
import { connect, makeNode, uniqueId, yesNoOptions } from './workflowEdit'
import { t, type TKey } from './i18n'
import { nodeTitle } from './defaultTitles'
import { patchGit, type WfGitPatch } from './workflowGit'

// Логика инспектора ноды и вкладки «Настройки → Типы задач → Воркфлоу»: правка полей ноды, переходы портов с клавиатуры,
// импорт/экспорт JSON, пресет лимита повторов. Как и workflowEdit.ts — чистые функции над графом.

/** Названия типов нод в инспекторе и подсказках холста. Геттеры — на текущем языке интерфейса. */
export const WF_TYPE_TITLES: Readonly<Record<WfNodeType, string>> = {
  get start() { return t('config.wf.type.start') },
  get work() { return t('config.wf.type.work') },
  get ask() { return t('config.wf.type.ask') },
  get gate() { return t('config.wf.type.gate') },
  get human() { return t('config.wf.type.human') },
  get decision() { return t('config.wf.type.decision') },
  get condition() { return t('config.wf.type.condition') },
  get merge() { return t('config.wf.type.merge') },
  get git() { return t('config.wf.type.git') },
  get end() { return t('config.wf.type.end') }
}

/** Порядок типов в select «Тип» инспектора. */
export const WF_TYPE_ORDER: readonly WfNodeType[] = ['start', 'work', 'ask', 'gate', 'decision', 'human', 'condition', 'merge', 'git', 'end']

/** Роли, которые можно поставить на этап: без служебных (coordinator, assistant) — они задачам не назначаются. */
export function stageRoles<R extends Pick<Role, 'id'>>(roles: readonly R[]): R[] {
  return roles.filter((r) => isTaskRole(r.id))
}

/**
 * Ноды, у которых есть поле «Колонка»: start и condition задача проходит насквозь, стоять в них она не может.
 * У ask колонку не задают: пока агент работает, задача в «В работе», а при вопросе store сам держит её в «Нужен ответ».
 * Git выполняется приложением синхронно и сразу передаёт ход дальше — задача на нём не стоит. У decision колонку
 * тоже не задают: пока агент решает, карточка в «В работе», а при передаче человеку её поднимает запрос в «Нужен ответ».
 */
export function hasColumn(type: WfNodeType): boolean {
  return type !== 'start' && type !== 'condition' && type !== 'ask' && type !== 'git' && type !== 'decision'
}

/** Поля ноды, которые правит инспектор. Пустая строка у необязательного поля — «не задано» (поле удаляется). */
export interface WfNodePatch {
  title?: string
  column?: string
  roleId?: string
  /** Вопрос ноды `decision`; пустой остаётся строкой — его подсветит валидация. */
  question?: string
  /** Роли этапа «Работа»; пустой список — роли не заданы (координатор выбирает сам). */
  roleIds?: string[]
  instructions?: string
  /** Показ человеку у «Работы»: меняются только переданные поля. Пустое «что» без «обязательно» — показа нет. */
  showcase?: { what?: string; required?: boolean }
  merged?: boolean
  test?: WfCondition
  /** Операция и параметры ноды `git`; см. `patchGit` (смена операции убирает лишние поля). */
  git?: WfGitPatch
}

/** Меняет поля ноды; поля, которых у её типа нет, игнорируются. */
export function patchNode(wf: Workflow, nodeId: string, patch: WfNodePatch): Workflow {
  const cur = wf.nodes.find((n) => n.id === nodeId)
  if (!cur) return wf
  const n: WfNode = { ...cur }
  if (patch.title !== undefined) {
    if (patch.title.trim()) n.title = patch.title
    else delete n.title
  }
  if (patch.column !== undefined) {
    if (patch.column) n.column = patch.column
    else delete n.column
  }
  if (patch.roleId !== undefined) {
    // У гейта и решения роль обязательна (пустую подсветит валидация), у вопроса пустая — «роль задачи».
    if (n.type === 'gate' || n.type === 'decision') n.roleId = patch.roleId
    else if (n.type === 'ask') {
      if (patch.roleId) n.roleId = patch.roleId
      else delete n.roleId
    }
  }
  if (patch.roleIds !== undefined && n.type === 'work') {
    // Одиночный roleId старого формата уходит: список его заменяет.
    delete n.roleId
    if (patch.roleIds.length > 0) n.roleIds = [...patch.roleIds]
    else delete n.roleIds
  }
  if (patch.question !== undefined && n.type === 'decision') n.question = patch.question
  if (patch.instructions !== undefined && (n.type === 'gate' || n.type === 'human' || n.type === 'work' || n.type === 'decision')) {
    if (patch.instructions.trim()) n.instructions = patch.instructions
    else delete n.instructions
  }
  // У ask инструкция обязательна: пустая остаётся строкой — поле не пропадает, а валидация подсвечивает его.
  if (patch.instructions !== undefined && n.type === 'ask') n.instructions = patch.instructions
  if (patch.showcase !== undefined && n.type === 'work') {
    const what = patch.showcase.what ?? n.showcase?.what ?? ''
    const required = patch.showcase.required ?? n.showcase?.required ?? false
    // «Обязательно» с пустым «что» остаётся: валидация подсветит пустое поле, а не потеряет флажок молча.
    if (what.trim() || required) n.showcase = required ? { what, required } : { what }
    else delete n.showcase
  }
  if (patch.merged !== undefined && n.type === 'end') n.merged = patch.merged
  if (patch.test !== undefined && n.type === 'condition') n.test = patch.test
  const patched = patch.git !== undefined && n.type === 'git' ? patchGit(n, patch.git) : n
  return { ...wf, nodes: wf.nodes.map((x) => (x.id === nodeId ? patched : x)) }
}

/**
 * Меняет тип ноды, сохраняя id, позицию, название и колонку; роль и инструкция переносятся, если у нового
 * типа они есть. Рёбра портов, которых у нового типа нет, удаляются; в старт не может вести переход —
 * входящие рёбра тоже удаляются. Новая `decision` получает варианты «Да / Нет» (`yes`/`no`) — поэтому
 * `condition ↔ decision` сохраняет оба ребра.
 */
export function changeNodeType(wf: Workflow, nodeId: string, type: WfNodeType): Workflow {
  const cur = wf.nodes.find((n) => n.id === nodeId)
  if (!cur || cur.type === type) return wf
  const others = { ...wf, nodes: wf.nodes.filter((n) => n.id !== nodeId) }
  const fresh = makeNode(others, type, cur.x, cur.y)
  const node: WfNode = { ...fresh, id: cur.id }
  if (cur.title) node.title = cur.title
  if (cur.column && hasColumn(type)) node.column = cur.column
  const role =
    cur.type === 'work' ? wfWorkRoleIds(cur)[0] : cur.type === 'gate' || cur.type === 'ask' || cur.type === 'decision' ? cur.roleId : undefined
  const instructions =
    cur.type === 'gate' || cur.type === 'human' || cur.type === 'work' || cur.type === 'ask' || cur.type === 'decision'
      ? cur.instructions
      : undefined
  if (role && node.type === 'work') node.roleIds = [role]
  else if (role && (node.type === 'gate' || node.type === 'ask' || node.type === 'decision')) node.roleId = role
  if (
    instructions &&
    (node.type === 'gate' || node.type === 'human' || node.type === 'work' || node.type === 'ask' || node.type === 'decision')
  ) {
    node.instructions = instructions
  }
  const ports = wfPorts(node)
  return {
    ...wf,
    nodes: wf.nodes.map((n) => (n.id === nodeId ? node : n)),
    edges: wf.edges.filter((e) => (e.from !== nodeId || ports.includes(e.outcome)) && !(type === 'start' && e.to === nodeId))
  }
}

// ---------- варианты ноды «Решение ИИ» ----------

type DecisionNode = Extract<WfNode, { type: 'decision' }>

/** Меняет варианты ноды `decision`; рёбра портов, которых больше нет, уходят вместе с вариантом. Не decision — граф как есть. */
function withOptions(wf: Workflow, nodeId: string, change: (options: WfDecisionOption[], node: DecisionNode) => WfDecisionOption[] | undefined): Workflow {
  const cur = wf.nodes.find((n) => n.id === nodeId)
  if (cur?.type !== 'decision') return wf
  const options = change(Array.isArray(cur.options) ? cur.options : [], cur)
  if (!options) return wf
  const node: WfNode = { ...cur, options }
  const ports = wfPorts(node)
  return {
    ...wf,
    nodes: wf.nodes.map((n) => (n.id === nodeId ? node : n)),
    edges: wf.edges.filter((e) => e.from !== nodeId || ports.includes(e.outcome))
  }
}

/**
 * id нового варианта из его метки: строчная латиница и цифры, остальное — «_» (маска `WF_DECISION_OPTION_ID`). Метка
 * без латиницы (кириллица, пустая) — `opt`. Свободный суффикс — `uniqueId`. id выдаётся один раз и потом не меняется:
 * на нём держатся рёбра.
 */
export function decisionOptionId(label: string, taken: Iterable<string>): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).replace(/_+$/, '')
  return uniqueId(slug || 'opt', taken)
}

/** «Добавить вариант»: в конец списка, не больше `WF_DECISION_MAX_OPTIONS` (больше не поместится на порты ноды). */
export function addDecisionOption(wf: Workflow, nodeId: string, label = ''): { workflow: Workflow; optionId?: string } {
  let optionId: string | undefined
  const workflow = withOptions(wf, nodeId, (options) => {
    if (options.length >= WF_DECISION_MAX_OPTIONS) return undefined
    optionId = decisionOptionId(label, options.map((o) => o.id))
    return [...options, { id: optionId, label }]
  })
  return optionId ? { workflow, optionId } : { workflow }
}

/**
 * Правка метки или пояснения варианта. id не меняется — рёбра и выбор в истории остаются. Пустая метка остаётся строкой
 * (её подсветит валидация), пустое пояснение удаляется.
 */
export function patchDecisionOption(wf: Workflow, nodeId: string, optionId: string, patch: { label?: string; description?: string }): Workflow {
  return withOptions(wf, nodeId, (options) => {
    if (!options.some((o) => o.id === optionId)) return undefined
    return options.map((o) => {
      if (o.id !== optionId) return o
      const next: WfDecisionOption = { ...o }
      if (patch.label !== undefined) next.label = patch.label
      if (patch.description !== undefined) {
        if (patch.description.trim()) next.description = patch.description
        else delete next.description
      }
      return next
    })
  })
}

/** Удаляет вариант вместе с ребром его порта. Меньше двух вариантов не запрещено здесь — это подсветит валидация. */
export function removeDecisionOption(wf: Workflow, nodeId: string, optionId: string): Workflow {
  return withOptions(wf, nodeId, (options) => (options.some((o) => o.id === optionId) ? options.filter((o) => o.id !== optionId) : undefined))
}

/** Сдвиг варианта на `delta` позиций (вверх — отрицательный). Порядок вариантов — порядок портов на холсте. */
export function moveDecisionOption(wf: Workflow, nodeId: string, optionId: string, delta: number): Workflow {
  return withOptions(wf, nodeId, (options) => {
    const from = options.findIndex((o) => o.id === optionId)
    const to = Math.max(0, Math.min(options.length - 1, from + delta))
    if (from < 0 || to === from) return undefined
    const next = [...options]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  })
}

/** «Сбросить на Да / Нет»: варианты — `yes`/`no`; рёбра этих портов остаются, остальные уходят вместе с вариантами. */
export function resetDecisionOptions(wf: Workflow, nodeId: string): Workflow {
  return withOptions(wf, nodeId, () => yesNoOptions())
}

/** Куда ведёт порт: id целевой ноды или undefined, если перехода нет. */
export function portTarget(wf: Workflow, nodeId: string, outcome: WfPort): string | undefined {
  return wf.edges.find((e) => e.from === nodeId && e.outcome === outcome)?.to
}

/** Select «куда ведёт»: новая цель порта или null — убрать переход. */
export function setPortTarget(wf: Workflow, nodeId: string, outcome: WfPort, to: string | null): Workflow {
  if (to === null) {
    if (!wf.edges.some((e) => e.from === nodeId && e.outcome === outcome)) return wf
    return { ...wf, edges: wf.edges.filter((e) => !(e.from === nodeId && e.outcome === outcome)) }
  }
  return connect(wf, nodeId, outcome, to).workflow
}

/** Варианты цели перехода: все ноды, кроме старта (в него переход вести нельзя). Возврат в себя допустим. */
export function targetOptions(wf: Workflow): { id: string; label: string }[] {
  return wf.nodes.filter((n) => n.type !== 'start').map((n) => ({ id: n.id, label: nodeOptionLabel(n) }))
}

/** Подпись ноды в select'ах: название, а если оно не совпадает с id — ещё и id (названия могут повторяться). */
export function nodeOptionLabel(n: WfNode): string {
  const title = nodeTitle(n)
  return title === n.id ? title : `${title} (${n.id})`
}

/** Новое условие при смене его вида в инспекторе: поля нового вида — по умолчанию. */
export function conditionOfKind(wf: Workflow, kind: 'attempts' | 'role'): WfCondition {
  if (kind === 'role') return { kind, roleIds: [] }
  return { kind, node: wf.nodes.find((n) => n.type === 'work')?.id ?? '', atLeast: 3 }
}

// ---------- импорт и экспорт ----------

/** JSON для кнопки «Экспорт»: читаемый, с переводом строки в конце. */
export function exportWorkflowJson(wf: Workflow): string {
  return `${JSON.stringify(wf, null, 2)}\n`
}

/** Имя файла экспорта по названию проекта: безопасные для любой ФС символы. */
export function workflowFileName(projectName: string): string {
  const slug = projectName.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return `workflow${slug ? `-${slug}` : ''}.json`
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Что показать человеку после импорта графа старой версии: версия файла и что миграция в нём изменила. */
export interface WorkflowMigrationInfo {
  fromVersion: number
  /** Тексты на языке интерфейса (по коду замечания `WfMigrationNote.code`, а не по русскому тексту core). */
  notes: string[]
}

/**
 * Замечания миграции v1 → v2 на языке интерфейса. Снятые ноды есть только в исходном графе (`before`), поэтому названия
 * берутся из него, а роль вопроса — из результата (`after`). `noHumanBeforeEnd` не дублируем: его показывает валидация графа.
 */
export function migrationNoteTexts(notes: readonly WfMigrationNote[], before: Workflow, after: Workflow): string[] {
  const nameOf = (id: string | undefined): string => {
    const node = before.nodes.find((n) => n.id === id) ?? after.nodes.find((n) => n.id === id)
    return node ? nodeTitle(node) : id ?? ''
  }
  return notes
    .filter((n) => n.code !== 'noHumanBeforeEnd')
    .map((n) => {
      const old = before.nodes.find((x) => x.id === n.nodeId)
      const current = after.nodes.find((x) => x.id === n.nodeId)
      const params: Record<string, string> = { node: nameOf(n.nodeId) }
      if (n.code === 'askRoleSet' && current?.type === 'ask') params.role = current.roleId ?? ''
      if (n.code === 'attemptsTargetRemoved' && old?.type === 'condition' && old.test.kind === 'attempts') params.target = nameOf(old.test.node)
      return t(`config.wf.migration.${n.code}` as TKey, params)
    })
}

/**
 * Разбор файла импорта. Проверяется только форма (граф ли это вообще): смысловые ошибки — нет роли, нет
 * перехода — покажет validateWorkflow в редакторе, и граф можно будет поправить перед сохранением.
 * Старая версия формата поднимается migrateWorkflow, будущая — ошибка.
 */
export function parseWorkflowJson(text: string): { workflow: Workflow; migration?: WorkflowMigrationInfo } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { error: t('config.wf.import.notJson', { message: e instanceof Error ? e.message : String(e) }) }
  }
  if (!isObj(data)) return { error: t('config.wf.import.notObject') }
  const { version, nodes, edges } = data
  if (typeof version !== 'number' || !Array.isArray(nodes) || !Array.isArray(edges)) {
    return { error: t('config.wf.import.noFields') }
  }
  if (version > WORKFLOW_VERSION) {
    return { error: t('config.wf.import.newerVersion', { version, known: WORKFLOW_VERSION }) }
  }
  for (const [i, n] of nodes.entries()) {
    if (!isObj(n) || typeof n.id !== 'string' || typeof n.type !== 'string' || typeof n.x !== 'number' || typeof n.y !== 'number') {
      return { error: t('config.wf.import.badNode', { n: i + 1 }) }
    }
    if (!(n.type in WF_PORTS)) return { error: t('config.wf.import.unknownType', { id: n.id, type: n.type }) }
  }
  for (const [i, e] of edges.entries()) {
    if (!isObj(e) || typeof e.id !== 'string' || typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.outcome !== 'string') {
      return { error: t('config.wf.import.badEdge', { n: i + 1 }) }
    }
  }
  // Форма проверена выше; остальное (порты, ссылки) — дело validateWorkflow.
  const raw = data as unknown as Workflow
  const { workflow, notes } = migrateWorkflowReport(raw)
  const texts = migrationNoteTexts(notes, raw, workflow)
  return raw.version < WORKFLOW_VERSION ? { workflow, migration: { fromVersion: raw.version, notes: texts } } : { workflow }
}

// ---------- пресет «3 отказа → человек» ----------

/** Место под новую ноду: не ближе ячейки к существующим; сдвигаемся вниз, пока занято. */
function freeSpot(wf: Workflow, x: number, y: number): { x: number; y: number } {
  const busy = (px: number, py: number): boolean =>
    wf.nodes.some((n) => Math.abs(n.x - px) < NODE_W + 20 && py < n.y + nodeHeight(n) + 20 && n.y < py + NODE_H + 20)
  let py = y
  while (busy(x, py)) py += NODE_H + 40
  return { x, y: py }
}

const isAttempts = (n: WfNode | undefined): boolean => n?.type === 'condition' && n.test.kind === 'attempts'

/**
 * Пресет «N отказов → человек»: каждый отказ проверки агентом, ведущий обратно в работу, идёт через условие
 * «заходов в работу ≥ N». Да — решает человек: принять (туда же, куда ведёт принятие проверки) или вернуть
 * в работу ещё раз. Работа при первом запуске уже засчитана, поэтому N-й отказ — ровно N заходов.
 * Отказы, уже идущие через условие, не трогаются — повторное применение ничего не меняет.
 */
export function addRetryLimit(wf: Workflow, limit = 3): { workflow: Workflow; added: number } | { error: string } {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]))
  const rejects = wf.edges.filter((e) => e.outcome === 'reject' && byId.get(e.from)?.type === 'gate' && byId.get(e.to)?.type === 'work')
  if (rejects.length === 0) {
    const limited = wf.edges.some((e) => e.outcome === 'reject' && byId.get(e.from)?.type === 'gate' && isAttempts(byId.get(e.to)))
    if (limited) return { error: t('config.wf.limit.already') }
    return { error: t('config.wf.limit.nowhere') }
  }
  let next = wf
  for (const reject of rejects) {
    const gate = byId.get(reject.from)!
    const ids = next.nodes.map((n) => n.id)
    const condId = uniqueId('limit', ids)
    const humanId = uniqueId('limit_human', [...ids, condId])
    const condPos = freeSpot(next, gate.x, gate.y + NODE_H + 60)
    const cond: WfNode = {
      id: condId, type: 'condition', title: t('config.wf.limit.condTitle', { limit }), ...condPos,
      test: { kind: 'attempts', node: reject.to, atLeast: limit }
    }
    const humanPos = freeSpot({ ...next, nodes: [...next.nodes, cond] }, condPos.x + NODE_W + 70, condPos.y)
    const human: WfNode = {
      id: humanId, type: 'human', title: t('config.wf.limit.humanTitle', { limit }), ...humanPos,
      instructions: t('config.wf.limit.humanInstructions', { limit })
    }
    const accept = portTarget(next, gate.id, 'accept')
    next = {
      ...next,
      nodes: [...next.nodes, cond, human],
      edges: [
        ...next.edges.map((e) => (e.id === reject.id ? { ...e, to: condId } : e)),
        { id: uniqueId(`e_${condId}_yes`, next.edges.map((e) => e.id)), from: condId, outcome: 'yes', to: humanId },
        { id: uniqueId(`e_${condId}_no`, next.edges.map((e) => e.id)), from: condId, outcome: 'no', to: reject.to },
        ...(accept ? [{ id: uniqueId(`e_${humanId}_accept`, next.edges.map((e) => e.id)), from: humanId, outcome: 'accept' as const, to: accept }] : []),
        { id: uniqueId(`e_${humanId}_reject`, next.edges.map((e) => e.id)), from: humanId, outcome: 'reject', to: reject.to }
      ]
    }
  }
  return { workflow: next, added: rejects.length }
}
