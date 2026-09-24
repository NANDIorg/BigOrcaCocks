import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AgentSession, ColumnKind, GlobalTask } from '@orca-board/core'
import { Icon } from './icons'
import { globalTaskActions } from './globalReview'
import { COORD_STATE_TEXT, coordState, knownSessions, sessionRows } from './coordPanel'
import { appendTail, COORD_TAIL_LINES, mergeTail, tailFromRegistry, tailLines } from './coordTail'

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
      aria-label="Последний вывод координатора"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {lines.length > 0 ? lines.join('\n') : <span className="gt-coord-tail-empty">{loading ? 'Загружаю вывод…' : 'Вывода пока нет.'}</span>}
    </pre>
  )
}

/**
 * Вкладка «Координатор»: состояние и действия (открыть терминал, остановить, запустить), запуски и последний
 * вывод только для чтения. Всё из снапшота необязательно: со старым main вкладка работает, но без списка запусков.
 */
export function CoordinatorPanel(props: CoordinatorPanelProps): React.JSX.Element {
  const { global, statusKind, coordinatorPty, sessions, onStartCoordinator, onShowCoordinator, onStopCoordinator, onReturn } = props
  const [confirmingStop, setConfirmingStop] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!coordinatorPty) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [coordinatorPty])

  if (global.inbox) {
    return (
      <section className="gt-box gt-coord-panel" aria-label="Координатор">
        <h3>Координатор</h3>
        <p className="muted">У «Входящих» нет координатора.</p>
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
        <section className="gt-box" aria-label="Состояние координатора">
          <h3 className={`gt-coord-state gt-coord-${state}`} role="status">
            <span className={state === 'stopped' ? 'gt-coord-dot' : 'g-live-dot'} aria-hidden />
            {COORD_STATE_TEXT[state]}
          </h3>
          {state === 'waiting' && <p className="muted gt-coord-note">Ждёт вашего решения — ответьте в ленте «Ждут вас».</p>}
          {coordinatorPty ? (
            stopping ? (
              <div className="gt-coord-confirm" role="alertdialog" aria-label="Остановить координатора">
                <p>Остановить координатора? Его терминал закроется, работа прервётся. Подзадачи и их воркеры останутся как есть; продолжить можно, запустив координатора снова.</p>
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
                    ■ Остановить
                  </button>
                  <button type="button" className="btn-sm" onClick={() => setConfirmingStop(undefined)}>Отмена</button>
                </div>
              </div>
            ) : (
              <div className="gt-actions">
                <button type="button" className="btn-sm primary" onClick={() => onShowCoordinator(coordinatorPty)}>Открыть терминал</button>
                <button type="button" className="btn-sm danger" onClick={() => setConfirmingStop(coordinatorPty)}>■ Остановить</button>
              </div>
            )
          ) : (
            <div className="gt-actions">
              {actions.startCoordinator && (
                <button type="button" className="btn-sm primary" onClick={onStartCoordinator}><Icon.play /> Запустить координатора</button>
              )}
              {actions.returnToWork && (
                <>
                  <button type="button" className="btn-sm" onClick={onReturn}>Вернуть в работу…</button>
                  <span className="muted gt-coord-note">перезапустит координатора с уточнением</span>
                </>
              )}
              {!actions.startCoordinator && !actions.returnToWork && <span className="muted gt-coord-note">Запуск недоступен в этом состоянии.</span>}
            </div>
          )}
        </section>
        <section className="gt-box" aria-label="Запуски координатора">
          <h3>Запуски{rows && rows.length > 0 && <span className="muted gt-sub">{rows.length}</span>}</h3>
          {rows === undefined ? (
            <p className="muted gt-coord-note">Запуски неизвестны: у этого прогона нет списка запусков (старая версия приложения или прогон создан до их учёта).</p>
          ) : rows.length === 0 ? (
            <p className="muted gt-coord-note">Запусков не было.</p>
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
      <section className="gt-box" aria-label="Последний вывод">
        <h3>Последний вывод <span className="muted gt-sub">только чтение · полный — во вкладке «Терминалы»</span></h3>
        {coordinatorPty ? <CoordTail ptyId={coordinatorPty} /> : <p className="muted gt-coord-note">Координатор не запущен — вывода нет.</p>}
      </section>
    </div>
  )
}
