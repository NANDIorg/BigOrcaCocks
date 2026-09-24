import type { ColumnKind } from '@orca-board/core'

/** Вкладки экрана глобальной задачи (`GlobalTaskView`), в порядке показа: номер вкладки = клавиша 1–4. */
export type GlobalTabId = 'board' | 'overview' | 'coordinator' | 'history'

export const GLOBAL_TAB_IDS: readonly GlobalTabId[] = ['board', 'overview', 'coordinator', 'history']

export function isGlobalTabId(value: unknown): value is GlobalTabId {
  return typeof value === 'string' && (GLOBAL_TAB_IDS as readonly string[]).includes(value)
}

/** «Проверка» и «Сделано»: работа закончена, человеку нужен итог, а не доска. */
function isFinished(kind: ColumnKind | undefined): boolean {
  return kind === 'review' || kind === 'done'
}

/**
 * Вкладка по умолчанию по состоянию. Черновик (бэклог, «Готово к запуску») — «Цель и детали»: доска пуста,
 * подсказывать надо, что делать. Работа и «Нужен ответ» — доска. «Проверка» и «Сделано» — «Итог и цель»: сводка
 * видна целиком и не пропадает после «Подтвердить». Колонка неизвестна (пользовательская, старый main) — доска.
 */
export function defaultTab(kind: ColumnKind | undefined): GlobalTabId {
  if (kind === 'backlog' || kind === 'ready' || isFinished(kind)) return 'overview'
  return 'board'
}

/** Заголовок вкладки: «Итог и цель» там, где есть итог, иначе «Цель и детали». */
export function tabTitle(id: GlobalTabId, kind: ColumnKind | undefined): string {
  switch (id) {
    case 'board': return 'Доска'
    case 'overview': return isFinished(kind) ? 'Итог и цель' : 'Цель и детали'
    case 'coordinator': return 'Координатор'
    case 'history': return 'История'
  }
}

/**
 * Какие вкладки показывать. «Входящие» — не задача, а корзина подзадач без глобальной: ни цели, ни координатора,
 * ни итога, — у них одна доска и вкладок нет.
 */
export function visibleTabs(g: { inbox?: boolean }): GlobalTabId[] {
  return g.inbox ? ['board'] : [...GLOBAL_TAB_IDS]
}

/** Выбор человека: вкладка и то, какой была вкладка по умолчанию в тот момент. */
export interface TabChoice {
  tab: GlobalTabId
  base: GlobalTabId
}

/**
 * Вкладка при открытии задачи. Выбор человека действует, пока вкладка по умолчанию та же, что была при выборе:
 * выбрал «Историю» в работе — она и останется на «Нужен ответ» (там тоже доска), но когда задача ушла на «Проверку»,
 * выбор устарел и показывается итог. Иначе «запомнили доску» навсегда прятало бы сводку. Вкладки нет среди
 * видимых (например, «Входящие») — по умолчанию.
 */
export function resolveTab(choice: TabChoice | undefined, kind: ColumnKind | undefined, visible: readonly GlobalTabId[]): GlobalTabId {
  const base = defaultTab(kind)
  const wanted = choice && choice.base === base ? choice.tab : base
  return visible.includes(wanted) ? wanted : (visible[0] ?? 'board')
}

/** Минимум от Storage — чтобы тестировать без окна. */
export interface TabStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const STORAGE_PREFIX = 'orca.gtab.'

/** Прочитать запомненный выбор; битое значение и недоступное хранилище — «не выбирал». */
export function readTabChoice(storage: TabStorage | undefined, globalId: string): TabChoice | undefined {
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + globalId)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { tab, base } = parsed as { tab?: unknown; base?: unknown }
    return isGlobalTabId(tab) && isGlobalTabId(base) ? { tab, base } : undefined
  } catch {
    return undefined
  }
}

/** Запомнить выбор человека по id задачи; хранилище недоступно — выбор просто не переживёт перезапуск. */
export function writeTabChoice(storage: TabStorage | undefined, globalId: string, choice: TabChoice): void {
  try {
    storage?.setItem(STORAGE_PREFIX + globalId, JSON.stringify(choice))
  } catch {
    // хранилище недоступно
  }
}

/** Пункт подсказки «Перед запуском» в черновике. `ok` — уже готово, иначе «ещё впереди/нужно». */
export interface LaunchCheck {
  ok: boolean
  text: string
}

/**
 * Что проверить перед запуском координатора. Подзадач в черновике обычно ещё нет — их создаёт координатор,
 * это не упрёк, а ожидание, поэтому пункт «не готово» нейтральный.
 */
export function launchChecklist(g: { description: string; title: string; progress: { total: number } }, typeTitle: string | undefined): LaunchCheck[] {
  const goal = g.description.trim()
  return [
    typeTitle
      ? { ok: true, text: `Тип «${typeTitle}» — роли и воркфлоу заданы` }
      : { ok: false, text: 'Тип не выбран — возьмётся тип проекта по умолчанию' },
    goal !== '' && goal !== g.title.trim()
      ? { ok: true, text: 'Цель описана' }
      : { ok: false, text: 'Цель — только название: опишите, что должно получиться («Изменить»)' },
    g.progress.total > 0
      ? { ok: true, text: `Подзадач уже ${g.progress.total} — координатор продолжит с них` }
      : { ok: false, text: 'Подзадачи — их создаст координатор' }
  ]
}

/**
 * Показывать ли на вкладке «Итог и цель» блок сводки: на «Проверке» и в «Сделано». Кнопки решения под ним —
 * только на «Проверке» (`GlobalTaskActions.accept`), в «Сделано» решать уже нечего.
 */
export function showsSummary(kind: ColumnKind | undefined, inbox?: boolean): boolean {
  return !inbox && isFinished(kind)
}

/** Показывать ли подсказку и кнопку запуска черновика. */
export function showsLaunchHint(kind: ColumnKind | undefined, inbox?: boolean): boolean {
  return !inbox && (kind === 'backlog' || kind === 'ready')
}

/** Индекс вкладки по нажатой цифре (0-based среди видимых) или `undefined`, если такой вкладки нет. */
export function tabAt(visible: readonly GlobalTabId[], index: number): GlobalTabId | undefined {
  return visible[index]
}

/** Соседняя вкладка стрелками ←/→ (по кругу), Home/End — крайние. */
export function stepTab(visible: readonly GlobalTabId[], current: GlobalTabId, key: string): GlobalTabId | undefined {
  const i = visible.indexOf(current)
  if (i < 0 || visible.length === 0) return undefined
  if (key === 'ArrowRight') return visible[(i + 1) % visible.length]
  if (key === 'ArrowLeft') return visible[(i - 1 + visible.length) % visible.length]
  if (key === 'Home') return visible[0]
  if (key === 'End') return visible[visible.length - 1]
  return undefined
}
