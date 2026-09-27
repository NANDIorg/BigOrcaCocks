import { wfPorts, type WfEdge, type WfIssue, type WfIssueCode, type WfNode, type WfNodeType, type WfValidation } from '@orca-board/core'

// Раскладка редактора воркфлоу (макет A, docs/design/workflow-editor/variant-a.html): группы палитры и поиск по ней,
// к какой карточке инспектора относится проблема валидации, список «Проблемы» по нодам. Только вид: граф здесь не
// меняется — правки живут в workflowEdit.ts / workflowForm.ts.

export type WfPaletteGroupId = 'agent' | 'human' | 'app' | 'bound'

/** Группы палитры по тому, кто выполняет этап. Порядок групп и типов в них — порядок на экране. */
export const WF_PALETTE_GROUPS: readonly { id: WfPaletteGroupId; types: readonly WfNodeType[] }[] = [
  { id: 'agent', types: ['work', 'ask', 'gate', 'decision'] },
  { id: 'human', types: ['human'] },
  { id: 'app', types: ['condition', 'merge', 'git'] },
  { id: 'bound', types: ['start', 'end'] }
]

/** Поиск палитры: каждое слово запроса есть хотя бы в одном из текстов, без учёта регистра. Пустой запрос — всё подходит. */
export function matchesQuery(query: string, texts: readonly (string | undefined)[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = texts.filter(Boolean).join('\n').toLocaleLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * Группы палитры с типами, которые можно добавить на этом уровне (`addable`, см. `wfAddableTypes`) и которые подходят
 * под запрос. `describe` — тексты типа для поиска (название, пояснение). Пустые группы не возвращаются.
 */
export function paletteGroups(
  addable: readonly WfNodeType[],
  query: string,
  describe: (type: WfNodeType) => readonly string[]
): { id: WfPaletteGroupId; types: WfNodeType[] }[] {
  return WF_PALETTE_GROUPS
    .map((g) => ({ id: g.id, types: g.types.filter((type) => addable.includes(type) && matchesQuery(query, describe(type))) }))
    .filter((g) => g.types.length > 0)
}

/** Свои ноды под запрос: ищем по названию, описанию и тому, что вернёт `describe` (тип, путь подзадачи). */
export function filterTemplates<T extends { title: string; description?: string }>(
  list: readonly T[],
  query: string,
  describe: (item: T) => string = () => ''
): T[] {
  return list.filter((item) => matchesQuery(query, [item.title, item.description, describe(item)]))
}

// ---------- карточки инспектора ----------

/** Карточки инспектора ноды. Какие из них есть у ноды, решает инспектор по её типу. */
export type WfCardId = 'main' | 'who' | 'what' | 'path' | 'out' | 'tpl'

/**
 * Карточка, где правится то, на что жалуется проблема. Код, которого здесь нет, падает в «Основное» — проблема
 * всё равно видна, просто без точного места.
 */
const CARD_OF_CODE: Partial<Record<WfIssueCode, WfCardId>> = {
  roleMissing: 'who',
  roleService: 'who',
  roleAgentOff: 'who',
  gateNoRole: 'who',
  askNoRole: 'who',
  decisionNoRole: 'who',
  workRolesNotList: 'who',

  askNoInstructions: 'what',
  instructionsNotString: 'what',
  showcaseNoWhat: 'what',
  showcaseRequiredNotBool: 'what',
  showcaseUnseen: 'what',
  attemptsNoNode: 'what',
  attemptsBadCount: 'what',
  conditionRoleRun: 'what',
  filesUnsupported: 'what',
  conditionUnknown: 'what',
  decisionNoQuestion: 'what',
  decisionOptionsNotList: 'what',
  decisionTooFewOptions: 'what',
  decisionTooManyOptions: 'what',
  decisionOptionBadId: 'what',
  decisionOptionDuplicateId: 'what',
  decisionOptionNoLabel: 'what',
  decisionDuplicateLabel: 'what',
  gitBadOperation: 'what',
  gitFieldNotString: 'what',
  gitNoBranch: 'what',
  gitNoMessage: 'what',
  gitBranchInvalid: 'what',
  gitBaseInvalid: 'what',
  gitBaseSameAsBranch: 'what',
  gitRemoteInvalid: 'what',
  gitUnknownPlaceholder: 'what',
  gitParamIgnored: 'what',
  gitRunOperation: 'what',

  subflowInvalid: 'path',
  subflowOnNonWork: 'path',
  subflowInTaskScope: 'path',
  subflowNested: 'path',
  subflowNoWork: 'path',
  subflowNoMerge: 'path',
  subflowDoubleReview: 'path',

  edgeNoTarget: 'out',
  edgeIntoStart: 'out',
  extraOutcomeEnd: 'out',
  extraOutcome: 'out',
  missingOutcome: 'out',
  duplicateOutcome: 'out',
  noPathToEnd: 'out',
  conditionCycle: 'out',
  endlessLoop: 'out',
  noHumanBeforeEnd: 'out',
  mergeAgain: 'out',
  decisionSameTarget: 'out',

  templateIdNotString: 'tpl'
}

/** Карточка проблемы. Проблема внутри пути подзадачи (на графе типа она ложится на ноду «Работа») — «Путь подзадачи». */
export function issueCard(issue: Pick<WfIssue, 'code' | 'subflowOf'>): WfCardId {
  if (issue.subflowOf) return 'path'
  return (issue.code && CARD_OF_CODE[issue.code]) || 'main'
}

export interface WfCardIssues {
  /** Худший уровень проблем карточки: точка и рамка карточки его цвета. */
  level: 'error' | 'warning'
  messages: string[]
}

/**
 * Проблемы ноды `nodeId` по карточкам. `cards` — карточки, которые у ноды есть: проблема карточки, которой у ноды нет
 * (роль у «Условия», путь у ноды не-«Работы»), уходит в «Основное». `text` — текст проблемы на языке интерфейса.
 */
export function nodeCardIssues(
  issues: WfValidation | undefined,
  nodeId: string,
  cards: readonly WfCardId[],
  text: (issue: WfIssue) => string
): Map<WfCardId, WfCardIssues> {
  const res = new Map<WfCardId, WfCardIssues>()
  if (!issues) return res
  for (const [level, list] of [['error', issues.errors], ['warning', issues.warnings]] as const) {
    for (const issue of list) {
      if (issue.nodeId !== nodeId) continue
      const want = issueCard(issue)
      const card = cards.includes(want) ? want : 'main'
      const cur = res.get(card)
      if (cur) cur.messages.push(text(issue))
      else res.set(card, { level, messages: [text(issue)] })
    }
  }
  return res
}

/** «нода «X»: », «node “X”: », «нода «X» → путь подзадачи: » — одно название в кавычках и короткие слова вокруг. */
const ISSUE_PREFIX = /^[^:«“"]{0,30}[«“"][^»”"]*[»”"][^:«“"]{0,30}: /

/**
 * Текст проблемы без префикса «нода «X»: » (и «→ путь подзадачи: »): в инспекторе и на холсте нода и так видна.
 * Префикс — начало до «: » с одним названием в кавычках (`ISSUE_PREFIX`); остальной текст не трогаем. Первая буква —
 * заглавная: текст стоит отдельной строкой, а не после названия ноды.
 */
export function shortIssueText(text: string): string {
  let rest = text
  for (let i = 0; i < 3; i++) {
    const m = ISSUE_PREFIX.exec(rest)
    if (!m) break
    rest = rest.slice(m[0].length)
  }
  if (!rest) return text
  return rest.charAt(0).toLocaleUpperCase() + rest.slice(1)
}

// ---------- панель «Проблемы» ----------

export interface WfProblemGroup {
  /** Нода, к которой ведёт клик; `undefined` — проблема всего графа или только перехода. */
  nodeId?: string
  /** Переход, если у проблем группы нет ноды. */
  edgeId?: string
  level: 'error' | 'warning'
  items: { level: 'error' | 'warning'; issue: WfIssue }[]
}

/**
 * Проблемы, сгруппированные по нодам: одна строка на ноду, даже если у неё несколько проблем. Группы с ошибками —
 * первыми, дальше в порядке валидатора; в группе ошибки — перед предупреждениями.
 */
export function groupProblems(issues: WfValidation): WfProblemGroup[] {
  const groups = new Map<string, WfProblemGroup>()
  for (const [level, list] of [['error', issues.errors], ['warning', issues.warnings]] as const) {
    for (const issue of list) {
      const key = issue.nodeId ? `n:${issue.nodeId}` : issue.edgeId ? `e:${issue.edgeId}` : ''
      const cur = groups.get(key)
      if (cur) cur.items.push({ level, issue })
      else {
        groups.set(key, {
          ...(issue.nodeId ? { nodeId: issue.nodeId } : issue.edgeId ? { edgeId: issue.edgeId } : {}),
          level,
          items: [{ level, issue }]
        })
      }
    }
  }
  const all = [...groups.values()]
  return [...all.filter((g) => g.level === 'error'), ...all.filter((g) => g.level === 'warning')]
}

// ---------- миниатюра пути подзадачи ----------

/**
 * Основной путь графа от старта: по первому исходу каждой ноды («дальше», «принять», «успех», первый вариант).
 * Для подписи под миниатюрой «Старт › Работа › Мерж › Конец»; на цикле обрывается.
 */
export function mainPath(wf: { nodes: readonly WfNode[]; edges: readonly WfEdge[] }): WfNode[] {
  const byId = new Map<string, WfNode>(wf.nodes.map((n) => [n.id, n]))
  const res: WfNode[] = []
  const seen = new Set<string>()
  let cur: WfNode | undefined = wf.nodes.find((n) => n.type === 'start')
  while (cur !== undefined && !seen.has(cur.id)) {
    const node: WfNode = cur
    seen.add(node.id)
    res.push(node)
    const port: string | undefined = wfPorts(node)[0]
    const edge: WfEdge | undefined = port === undefined ? undefined : wf.edges.find((e) => e.from === node.id && e.outcome === port)
    cur = edge === undefined ? undefined : byId.get(edge.to)
  }
  return res
}
