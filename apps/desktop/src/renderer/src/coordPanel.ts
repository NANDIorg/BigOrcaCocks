import { AGENT_TITLES, type AgentSession, type ColumnKind } from '@orca-board/core'
import { formatDuration } from './duration'
import { t } from './i18n'
import { formatDateTime } from './i18n/format'

/** Состояние координатора на вкладке: работает, ждёт человека или не запущен. */
export type CoordState = 'working' | 'waiting' | 'stopped'

/**
 * Живой координатор ждёт человека, если у прогона есть pending-запросы (`GlobalTask.waiting`) или карточка стоит
 * в «Нужен ответ»: пока запрос не решён, агент не двигается. Нет живого PTY — «не запущен», что бы ни было в запросах.
 */
export function coordState(live: boolean, waiting: number | undefined, kind: ColumnKind | undefined): CoordState {
  if (!live) return 'stopped'
  return (waiting ?? 0) > 0 || kind === 'needs_input' ? 'waiting' : 'working'
}

/** Подпись состояния координатора на текущем языке. */
export function coordStateText(state: CoordState): string {
  return t(`shell.coord.state.${state}`)
}

/** Строка списка запусков. */
export interface SessionRow {
  key: string
  /** «Запуск 2»: номер по порядку запусков, старые — меньше. */
  title: string
  /** «Claude Code · opus». */
  agent: string
  /** «24.09, 10:05 — 14:33» или «… — сейчас»; конец неизвестен, если PTY умер без `endedAt`. */
  period: string
  /** Длительность («1 ч 12 мин»); конец неизвестен — undefined. */
  duration?: string
  live: boolean
}

function stamp(ts: number): string {
  return formatDateTime(ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** Конец периода в тот же день, что и начало, — только время: «24.09, 10:05 — 14:33». */
function endStamp(start: number, end: number): string {
  const day = (ts: number): string => new Date(ts).toDateString()
  return day(start) === day(end) ? formatDateTime(end, { hour: '2-digit', minute: '2-digit' }) : stamp(end)
}

/**
 * Список запусков для показа. Поля `Run.coordinatorSessions` нет: если координатор ни разу не запускался
 * (нет `coordinatorPtyId` и живого PTY), запусков и правда не было; иначе они остались неизвестны — старый main
 * или прогон до учёта запусков.
 */
export function knownSessions(sessions: AgentSession[] | undefined, launched: boolean): AgentSession[] | undefined {
  return sessions ?? (launched ? undefined : [])
}

/**
 * Запуски координатора, новые сверху. `sessions` — `Run.coordinatorSessions`: undefined — поля нет (старый main или
 * прогон до учёта запусков), это «неизвестно», а не «не запускался». Живым считается запуск без `endedAt` с ptyId
 * из реестра; без `endedAt`, но с мёртвым PTY (приложение упало) — конец неизвестен.
 */
export function sessionRows(sessions: readonly AgentSession[] | undefined, livePty: string | undefined, now: number): SessionRow[] | undefined {
  if (!sessions) return undefined
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt)
  return ordered
    .map((s, i): SessionRow => {
      const live = s.endedAt === undefined && livePty !== undefined && s.ptyId === livePty
      const title = AGENT_TITLES[s.agent] ?? s.agent
      const end = s.endedAt ?? (live ? now : undefined)
      return {
        key: `${s.ptyId}:${s.startedAt}`,
        title: t('shell.coord.session', { n: i + 1 }),
        agent: s.model ? `${title} · ${s.model}` : title,
        period: `${stamp(s.startedAt)} — ${s.endedAt !== undefined ? endStamp(s.startedAt, s.endedAt) : live ? t('shell.coord.now') : t('shell.coord.endUnknown')}`,
        ...(end !== undefined ? { duration: formatDuration(Math.max(0, end - s.startedAt)) } : {}),
        live
      }
    })
    .reverse()
}
