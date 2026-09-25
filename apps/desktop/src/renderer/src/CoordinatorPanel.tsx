import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AgentSession, ColumnKind, GlobalTask } from '@orca-board/core'
import { Icon } from './icons'
import { globalTaskActions } from './globalReview'
import { coordState, coordStateText, knownSessions, sessionRows } from './coordPanel'
import { appendTail, COORD_TAIL_LINES, mergeTail, tailFromRegistry, tailLines } from './coordTail'
import { useT } from './i18n'

export interface CoordinatorPanelProps {
  global: GlobalTask
  /** Вид колонки задачи: на «Проверке» запуск заменён возвратом с уточнением (`globalTaskActions`). */
  statusKind?: ColumnKind
  /** Живой координатор (ptyId) — есть, если он сейчас работает. */
  coordinatorPty?: string
  /**
   * `Run.coordinatorSessions` этой задачи. Необязательное поле снапшота: нет — запуски неизвестны
   * (старый main или прогон до учёта запусков), это не то же самое, что «запусков не было» (`[]`). Координатор
   * ни разу не запускался — запусков нет и без поля (`knownSessions`).
   */
  sessions?: AgentSession[]
  onStartCoordinator(): void
  /** Открыть терминал живого координатора во вкладке «Терминалы». */
  onShowCoordinator(ptyId: string): void
  /** «Остановить»: закрыть PTY координатора (`pty.kill`). Подтверждение — внутри панели. */
  onStopCoordinator(ptyId: string): void
  /** «Вернуть в работу…» на «Проверке». */
  onReturn(): void
}

/** Обновляем показанный хвост не чаще раза в это время: вывод агента идёт пачками. */
const TAIL_FLUSH_MS = 300

/**
 * Последние строки вывода PTY только для чтения. Хвост берём из `terminals.list()` и дописываем `pty.onData`;
 * `resize` не зовём — размер принадлежит настоящему терминалу. API нет (старый preload) — хвост просто пуст.
 */
function useCoordTail(ptyId: string | undefined): { lines: string[]; loading: boolean } {
  const [state, setState] = useState<{ ptyId?: string; lines: string[] }>({ lines: [] })
  useEffect(() => {
    if (!ptyId) return
    const api = window.orca
    let cancelled = false
    let raw = ''
    let ready = false
    let dirty = false
    const early: string[] = []
    const publish = (): void => {
      dirty = false
      setState({ ptyId, lines: tailLines(raw, COORD_TAIL_LINES) })
    }
    const timer = window.setInterval(() => {
      if (dirty && ready) publish()
    }, TAIL_FLUSH_MS)
    // Подписываемся до запроса реестра: вывод, пришедший, пока `list()` едет, не теряем.
    const off = api?.pty?.onData?.(ptyId, (data) => {
      if (!ready) early.push(data)
      else {
        raw = appendTail(raw, data)
        dirty = true
      }
    })
    void Promise.resolve(api?.terminals?.list?.())
      .catch(() => undefined)
      .then((list) => {
        // Поздний ответ для прежнего PTY не должен перезаписать состояние нового.
        if (cancelled) return
        raw = mergeTail(tailFromRegistry(list, ptyId) ?? '', early)
        early.length = 0
        ready = true
        publish()
      })
    return () => {
      cancelled = true
      window.clearInterval(timer)
      off?.()
    }
  }, [ptyId])
  return { lines: state.ptyId === ptyId ? state.lines : [], loading: ptyId !== undefined && state.ptyId !== ptyId }
}

/** Хвост вывода. Следует за концом, пока человек не прокрутил вверх, чтобы перечитать. */
function CoordTail({ ptyId }: { ptyId: string }): React.JSX.Element {
  const t = useT()
  const { lines, loading } = useCoordTail(ptyId)
  const ref = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <pre
      ref={ref}
      className="gt-coord-tail"
      tabIndex={0}
      role="log"
      aria-label={t('shell.coord.tailLabel')}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {lines.length > 0 ? lines.join('\n') : <span className="gt-coord-tail-empty">{loading ? t('shell.coord.tailLoading') : t('shell.coord.tailEmpty')}</span>}
    </pre>
  )
}

/**
 * Вкладка «Координатор»: состояние и действия (открыть терминал, остановить, запустить), запуски и последний
 * вывод только для чтения. Всё из снапшота необязательно: со старым main вкладка работает, но без списка запусков.
 */
export function CoordinatorPanel(props: CoordinatorPanelProps): React.JSX.Element {
  const { global, statusKind, coordinatorPty, sessions, onStartCoordinator, onShowCoordinator, onStopCoordinator, onReturn } = props
  const t = useT()
  const [confirmingStop, setConfirmingStop] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!coordinatorPty) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [coordinatorPty])

  if (global.inbox) {
    return (
      <section className="gt-box gt-coord-panel" aria-label={t('shell.coord.title')}>
        <h3>{t('shell.coord.title')}</h3>
        <p className="muted">{t('shell.coord.inboxNone')}</p>
      </section>
    )
  }

  const actions = globalTaskActions(global, statusKind, coordinatorPty !== undefined)
  const state = coordState(coordinatorPty !== undefined, global.waiting, statusKind)
  const rows = sessionRows(knownSessions(sessions, coordinatorPty !== undefined || global.coordinatorPtyId !== undefined), coordinatorPty, now)
  const stopping = coordinatorPty !== undefined && confirmingStop === coordinatorPty

  return (
    <div className="gt-grid gt-coord-panel">
      <div className="gt-stack">
        <section className="gt-box" aria-label={t('shell.coord.stateLabel')}>
          <h3 className={`gt-coord-state gt-coord-${state}`} role="status">
            <span className={state === 'stopped' ? 'gt-coord-dot' : 'g-live-dot'} aria-hidden />
            {coordStateText(state)}
          </h3>
          {state === 'waiting' && <p className="muted gt-coord-note">{t('shell.coord.waitingNote')}</p>}
          {coordinatorPty ? (
            stopping ? (
              <div className="gt-coord-confirm" role="alertdialog" aria-label={t('shell.coord.stopLabel')}>
                <p>{t('shell.coord.stopConfirm')}</p>
                <div className="gt-actions">
                  <button
                    type="button"
                    className="btn-sm danger"
                    autoFocus
                    onClick={() => {
                      setConfirmingStop(undefined)
                      onStopCoordinator(coordinatorPty)
                    }}
                  >
                    {t('shell.coord.stop')}
                  </button>
                  <button type="button" className="btn-sm" onClick={() => setConfirmingStop(undefined)}>{t('shell.cancel')}</button>
                </div>
              </div>
            ) : (
              <div className="gt-actions">
                <button type="button" className="btn-sm primary" onClick={() => onShowCoordinator(coordinatorPty)}>{t('shell.coord.openTerminal')}</button>
                <button type="button" className="btn-sm danger" onClick={() => setConfirmingStop(coordinatorPty)}>{t('shell.coord.stop')}</button>
              </div>
            )
          ) : (
            <div className="gt-actions">
              {actions.startCoordinator && (
                <button type="button" className="btn-sm primary" onClick={onStartCoordinator}><Icon.play /> {t('shell.coord.start')}</button>
              )}
              {actions.returnToWork && (
                <>
                  <button type="button" className="btn-sm" onClick={onReturn}>{t('shell.coord.return')}</button>
                  <span className="muted gt-coord-note">{t('shell.coord.returnNote')}</span>
                </>
              )}
              {!actions.startCoordinator && !actions.returnToWork && <span className="muted gt-coord-note">{t('shell.coord.unavailable')}</span>}
            </div>
          )}
        </section>
        <section className="gt-box" aria-label={t('shell.coord.sessionsLabel')}>
          <h3>{t('shell.coord.sessions')}{rows && rows.length > 0 && <span className="muted gt-sub">{rows.length}</span>}</h3>
          {rows === undefined ? (
            <p className="muted gt-coord-note">{t('shell.coord.sessionsUnknown')}</p>
          ) : rows.length === 0 ? (
            <p className="muted gt-coord-note">{t('shell.coord.sessionsNone')}</p>
          ) : (
            <ul className="gt-coord-runs">
              {rows.map((r) => (
                <li key={r.key} className={r.live ? 'live' : undefined}>
                  <span className="gt-coord-run-at">{r.period}</span>
                  <b>{r.title}</b>
                  <span className="muted">{[r.agent, r.duration].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="gt-box" aria-label={t('shell.coord.outputLabel')}>
        <h3>{t('shell.coord.outputLabel')} <span className="muted gt-sub">{t('shell.coord.outputSub')}</span></h3>
        {coordinatorPty ? <CoordTail ptyId={coordinatorPty} /> : <p className="muted gt-coord-note">{t('shell.coord.noOutput')}</p>}
      </section>
    </div>
  )
}
