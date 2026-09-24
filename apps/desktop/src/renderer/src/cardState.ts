import { wfNodeTitle, type ColumnKind, type Dispatch, type Question, type Task, type Workflow } from '@orca-board/core'
import { plural } from './plural'

/**
 * Состояние карточки локальной доски — что с задачей сейчас, а не в какой она колонке. От него зависят полоса
 * слева, пунктирная строка сути и фильтры тулбара («Ждут вас», «Проблемы»).
 */
export type CardState = 'live' | 'human' | 'review' | 'bad' | 'blocked' | 'idle'

/** Текст состояния для `aria-label` и подсказок: цвет полосы не должен быть единственным сигналом. */
export const CARD_STATE_LABEL: Record<CardState, string> = {
  live: 'в работе',
  human: 'ждёт вас',
  review: 'на ревью',
  bad: 'сбой',
  blocked: 'ждёт зависимостей',
  idle: ''
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

/**
 * Ждёт ли карточка человека — то же, что покажет лента «Ждут вас»: вопрос, ответ, сбой, а на ревью — только когда
 * есть что смотреть (показ или ответ). Ревью, которое проверяет гейт-агент, человека не ждёт.
 */
export function waitsForYou(i: CardStateInput, state: CardState = cardState(i)): boolean {
  if (state === 'human' || state === 'bad') return true
  return state === 'review' && (!!i.dispatch?.showcase || (!!i.task.answerFor && !!i.dispatch?.answer))
}

/** Сжать текст до одной строки не длиннее `max` символов (с «…»): для пунктирной строки сути. */
export function shortText(text: string, max = 48): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** «3 файла», «5 файлов», «21 файл». */
export function filesLabel(n: number): string {
  return `${n} ${plural(n, 'файл', 'файла', 'файлов')}`
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
    if (d?.outcome === 'failed') return { text: '✕ Упал' }
    if (d?.outcome === 'unknown') return { text: '✕ Вышел без done' }
    return { text: '✕ Молчит', title: 'Воркер давно ничего не выводил' }
  }
  if (state === 'human') {
    const [first] = i.questions
    if (first) {
      const more = i.questions.length > 1 ? ` (+${i.questions.length - 1})` : ''
      return { text: `? ${shortText(first.question)}${more}`, title: i.questions.map((q) => q.question).join('\n\n') }
    }
    if (isAnswerReady(i)) return { text: '✎ Ответ готов', title: d?.summary }
    return { text: '? Нужен ответ' }
  }
  if (state === 'review') {
    if (i.task.answerFor && d?.answer) return { text: '✎ Ответ готов', title: d.summary }
    if (d?.showcase) {
      const n = d.showcase.files.length
      return { text: n > 0 ? `◉ Показ: ${filesLabel(n)}` : '◉ Показ', title: d.summary }
    }
    return { text: d?.files && d.files.length > 0 ? `Ждёт ревью: ${filesLabel(d.files.length)}` : 'Ждёт ревью', title: d?.summary }
  }
  return null
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
    const text = `⛉ Гейт${node ? ` «${node}»` : ''}${target ? ` → ${target}` : ''}`
    return { kind: 'gate', text, title: 'Задача-гейт: проверяет ветку рабочей задачи' }
  }
  const stage = task.stage
  const name = stage ? titles?.[stage.nodeId] : undefined
  if (!stage || !name) return null
  const visits = stage.visits?.[stage.nodeId] ?? 1
  const text = visits > 1 ? `${name} · ${visits}-й заход` : name
  return { kind: 'stage', text, title: `Этап воркфлоу: ${text}` }
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
  const title = `Ждёт: ${names.join('; ')}`
  if (names.length === 1) return { text: `⧗ ждёт: ${names[0]}`, title }
  return { text: `⧗ ждёт ${names.length} ${plural(names.length, 'задачу', 'задачи', 'задач')}`, title }
}
