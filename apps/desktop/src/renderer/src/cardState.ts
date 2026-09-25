import { wfNodeTitle, type ColumnKind, type Dispatch, type HumanRequest, type Question, type Task, type Workflow } from '@orca-board/core'
import { t } from './i18n'

/**
 * Состояние карточки локальной доски — что с задачей сейчас, а не в какой она колонке. От него зависят полоса
 * слева, пунктирная строка сути и фильтры тулбара («Ждут вас», «Проблемы»).
 */
export type CardState = 'live' | 'human' | 'review' | 'bad' | 'blocked' | 'idle'

/**
 * Текст состояния для `aria-label` и подсказок: цвет полосы не должен быть единственным сигналом.
 * Функция, а не таблица: текст — на текущем языке интерфейса.
 */
export function cardStateLabel(state: CardState): string {
  return state === 'idle' ? '' : t(`board.state.${state}`)
}

/** Всё, что нужно знать о карточке, чтобы определить состояние. Данные — из снимка доски, без побочных запросов. */
export interface CardStateInput {
  /** Вид колонки, где лежит задача; неизвестная колонка — undefined. */
  kind: ColumnKind | undefined
  task: Pick<Task, 'answerFor'>
  /** Последний dispatch задачи. */
  dispatch?: Pick<Dispatch, 'outcome' | 'stuckNotified' | 'endedAt' | 'answer' | 'summary' | 'files' | 'showcase'>
  /** Открытые (без ответа) вопросы воркера этой задачи. */
  questions: readonly Pick<Question, 'question'>[]
  /** У задачи сейчас открыт терминал воркера. */
  running: boolean
  /** Сколько зависимостей не закрыто, — только у задач в бэклоге (`pendingDeps`); иначе 0. */
  waitingDeps: number
}

/** Воркер упал, вышел без `done` или молчит: нужен перезапуск или разбор. В done сбой не показываем. */
function isBad(i: CardStateInput): boolean {
  if (i.kind === 'done') return false
  const d = i.dispatch
  return d?.outcome === 'unknown' || d?.outcome === 'failed' || (d?.stuckNotified === true && !d.endedAt)
}

/** Задача-ответ дописала ответ и лежит в «Нужен ответ» или «Ревью»: его читает человек. */
function isAnswerReady(i: CardStateInput): boolean {
  return !!i.task.answerFor && !!i.dispatch?.answer && (i.kind === 'needs_input' || i.kind === 'review')
}

/**
 * Состояние карточки. Порядок важен: сбой перекрывает всё (его надо чинить), затем «ждёт человека», ревью,
 * работа и, наконец, ожидание зависимостей. В колонке «Сделано» состояния нет.
 */
export function cardState(i: CardStateInput): CardState {
  if (i.kind === 'done') return 'idle'
  if (isBad(i)) return 'bad'
  if (i.questions.length > 0 || isAnswerReady(i) || i.kind === 'needs_input') return 'human'
  if (i.kind === 'review') return 'review'
  if (i.kind === 'in_progress' || i.running) return 'live'
  if (i.waitingDeps > 0) return 'blocked'
  return 'idle'
}

/** Сжать текст до одной строки не длиннее `max` символов (с «…»): для пунктирной строки сути. */
export function shortText(text: string, max = 48): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** «3 файла», «5 файлов», «21 файл» / «3 files». */
export function filesLabel(n: number): string {
  return t('board.card.files', { count: n })
}

/** Что написать в пунктирной строке карточки; `title` — полный текст для подсказки. */
export interface CardEssence {
  text: string
  title?: string
}

/**
 * Короткая суть того, чего ждёт карточка («? PDF: iframe или картинкой?», «✕ Упал»). Действие на карточке не
 * дублируется: ответить можно в ленте, а карточка только говорит, в чём дело. Символ в начале — вторичный
 * сигнал, слово после него — основной. Нет сути (работа, ожидание зависимостей, «Сделано») — null.
 */
export function cardEssence(i: CardStateInput, state: CardState = cardState(i)): CardEssence | null {
  const d = i.dispatch
  if (state === 'bad') {
    if (d?.outcome === 'failed') return { text: t('board.essence.failed') }
    if (d?.outcome === 'unknown') return { text: t('board.essence.noDone') }
    return { text: t('board.essence.stuck'), title: t('board.essence.stuckTitle') }
  }
  if (state === 'human') {
    const [first] = i.questions
    if (first) {
      const more = i.questions.length > 1 ? ` (+${i.questions.length - 1})` : ''
      return { text: `? ${shortText(first.question)}${more}`, title: i.questions.map((q) => q.question).join('\n\n') }
    }
    if (isAnswerReady(i)) return { text: t('board.essence.answerReady'), title: d?.summary }
    return { text: t('board.essence.needsAnswer') }
  }
  if (state === 'review') {
    if (i.task.answerFor && d?.answer) return { text: t('board.essence.answerReady'), title: d.summary }
    if (d?.showcase) {
      const n = d.showcase.files.length
      return { text: n > 0 ? t('board.essence.showcaseFiles', { files: filesLabel(n) }) : t('board.essence.showcase'), title: d.summary }
    }
    const files = d?.files?.length ?? 0
    return { text: files > 0 ? t('board.essence.reviewFiles', { files: filesLabel(files) }) : t('board.essence.review'), title: d?.summary }
  }
  return null
}

/**
 * Суть для задачи, которая есть в ленте «Ждут вас», но по состоянию карточки строки сути не получила (например,
 * воркфлоу держит задачу в «В работе» и ждёт решения по запросу): без неё у карточки не было бы ссылки «в ленте ↑»,
 * хотя фильтр «Ждут вас» и счётчик ленты её считают.
 */
function waitingEssence(): CardEssence {
  return { text: t('board.essence.waiting'), title: t('board.essence.waitingTitle') }
}

/** Суть карточки: по её состоянию, а если её нет, но задача в ленте «Ждут вас» (`waits`) — запасная. */
export function cardEssenceFor(i: CardStateInput, state: CardState, waits: boolean): CardEssence | null {
  return cardEssence(i, state) ?? (waits ? waitingEssence() : null)
}

/** Что показать в пилюле этапа: `gate` — задача-гейт (другая иконка и цвет). */
export interface StageLabel {
  kind: 'stage' | 'gate'
  text: string
  title: string
}

/** Названия нод воркфлоу по id — для подписи этапа на карточках; `Board` получает их из `App`. */
export function wfNodeTitles(wf: Workflow | undefined): Record<string, string> {
  const titles: Record<string, string> = {}
  for (const node of wf?.nodes ?? []) titles[node.id] = wfNodeTitle(node)
  return titles
}

/**
 * Метка этапа воркфлоу. Рабочая задача — название ноды (`Task.stage.nodeId`) и «N-й заход» со второго (`visits`);
 * гейт — «⛉ Гейт «нода» → задача» (`Task.gateFor`). Без названий нод (`titles` нет или нода неизвестна) этап не
 * подписываем — id ноды человеку ничего не говорит; гейту хватает и без нод. Старый main поля `stage` не знает —
 * пилюли просто нет.
 */
export function stageLabel(
  task: Pick<Task, 'stage' | 'gateFor'>,
  titles: Readonly<Record<string, string>> | undefined,
  taskTitle: (id: string) => string | undefined
): StageLabel | null {
  if (task.gateFor) {
    const node = titles?.[task.gateFor.nodeId]
    const target = taskTitle(task.gateFor.taskId)
    const text = `${node ? t('board.stage.gateNode', { node }) : t('board.stage.gate')}${target ? ` → ${target}` : ''}`
    return { kind: 'gate', text, title: t('board.stage.gateTitle') }
  }
  const stage = task.stage
  const name = stage ? titles?.[stage.nodeId] : undefined
  if (!stage || !name) return null
  const visits = stage.visits?.[stage.nodeId] ?? 1
  const text = visits > 1 ? t('board.stage.visit', { name, n: visits }) : name
  return { kind: 'stage', text, title: t('board.stage.title', { text }) }
}

/**
 * Метка «Этап «…»» у вопроса с этапа `ask` воркфлоу: по `HumanRequest.nodeId` и названию ноды из графа прогона.
 * Только у вопросов: у approval `nodeId` — нода «Человек», её название уже в заголовке запроса. Ноды нет в графе
 * (граф поменяли, нет снимка) — метки нет: id человеку ничего не говорит.
 */
export function requestStageLabel(
  request: Pick<HumanRequest, 'kind' | 'nodeId'>,
  titles: Readonly<Record<string, string>> | undefined
): string | undefined {
  if (request.kind !== 'question' || !request.nodeId) return undefined
  const name = titles?.[request.nodeId]
  return name ? t('board.stage.request', { name }) : undefined
}

/** Свёрнутые зависимости: одна пунктирная метка вместо чипа на каждую; полный список — в подсказке. */
export interface DepsLabel {
  text: string
  title: string
}

/**
 * «⧗ ждёт: X» (одна) или «⧗ ждёт 2 задачи» (несколько) — по незакрытым зависимостям. Неизвестная зависимость
 * считается незакрытой, как в `pendingDeps`. Все закрыты — метки нет.
 */
export function depsLabel(
  deps: readonly string[],
  isClosed: (id: string) => boolean,
  titleOf: (id: string) => string | undefined
): DepsLabel | null {
  const open = deps.filter((d) => !isClosed(d))
  if (open.length === 0) return null
  const names = open.map((d) => titleOf(d) ?? d)
  const title = t('board.deps.title', { names: names.join('; ') })
  if (names.length === 1) return { text: t('board.deps.one', { name: names[0] }), title }
  return { text: t('board.deps.many', { count: names.length }), title }
}
