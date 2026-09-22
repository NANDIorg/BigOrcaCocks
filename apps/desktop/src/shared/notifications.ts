// Настройки системных уведомлений и фильтр по ним. Чистый модуль: нужен и main (фильтр, нормализация
// файла настроек), и renderer (подписи, дефолты) — без electron и node.

/** Вид уведомления: то, что человек включает/выключает в «Настройки → Уведомления». */
export type NotifyKind = 'workerDone' | 'answerReady' | 'question' | 'escalation' | 'runDone'

export const NOTIFY_KINDS: NotifyKind[] = ['question', 'answerReady', 'workerDone', 'escalation', 'runDone']

export const NOTIFY_KIND_TITLES: Record<NotifyKind, { title: string; hint: string }> = {
  question: { title: 'Вопрос от воркера', hint: 'Воркер спросил через orca-board ask и ждёт ответа.' },
  answerReady: { title: 'Ответ готов', hint: 'Задача-ответ для человека сдана — ждёт «Принять» или «Уточнить».' },
  workerDone: { title: 'Воркер завершил задачу', hint: 'orca-board done: задача ушла на ревью.' },
  escalation: { title: 'Эскалация', hint: 'Воркер упал без done или долго молчит.' },
  runDone: { title: 'Прогон завершён', hint: 'Все задачи прогона в «Готово».' }
}

export interface QuietHours {
  enabled: boolean
  /** Начало, "HH:MM" по локальному времени. */
  from: string
  /** Конец (не включительно), "HH:MM"; from > to — интервал через полночь. */
  to: string
}

export interface NotificationSettings {
  /** Глобальный выключатель. */
  enabled: boolean
  /** Роли по id; нет ключа — роль включена (новые роли уведомляют). */
  roles: Record<string, boolean>
  /** Виды уведомлений; нет ключа — дефолт из DEFAULT_NOTIFICATION_SETTINGS. */
  events: Record<NotifyKind, boolean>
  /** Только когда окно не в фокусе (свёрнуто, скрыто, закрыто в трей). */
  onlyWhenUnfocused: boolean
  /** Со звуком (иначе Notification silent). */
  sound: boolean
  quietHours: QuietHours
  /** Показывать текст события (вопрос, итог, причина) и название задачи; иначе — общий текст. */
  showPreview: boolean
}

/** Патч из UI: любые поля, вложенные объекты мержатся. */
export interface NotificationSettingsPatch {
  enabled?: boolean
  roles?: Record<string, boolean>
  events?: Partial<Record<NotifyKind, boolean>>
  onlyWhenUnfocused?: boolean
  sound?: boolean
  quietHours?: Partial<QuietHours>
  showPreview?: boolean
}

/** Дефолты повторяют поведение до появления настроек: runDone раньше не уведомлял. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  roles: {},
  events: { workerDone: true, answerReady: true, question: true, escalation: true, runDone: false },
  onlyWhenUnfocused: false,
  sound: true,
  quietHours: { enabled: false, from: '22:00', to: '08:00' },
  showPreview: true
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function isTime(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v)
}

function minutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)

/** Настройки из файла (любой формы, в т.ч. старого без поля): некорректные и отсутствующие поля — дефолты. */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  const d = DEFAULT_NOTIFICATION_SETTINGS
  const s = isRecord(raw) ? raw : {}
  const roles: Record<string, boolean> = {}
  if (isRecord(s.roles)) for (const [id, on] of Object.entries(s.roles)) if (typeof on === 'boolean') roles[id] = on
  const ev = isRecord(s.events) ? s.events : {}
  const events = Object.fromEntries(NOTIFY_KINDS.map((k) => [k, bool(ev[k], d.events[k])])) as Record<NotifyKind, boolean>
  const q = isRecord(s.quietHours) ? s.quietHours : {}
  return {
    enabled: bool(s.enabled, d.enabled),
    roles,
    events,
    onlyWhenUnfocused: bool(s.onlyWhenUnfocused, d.onlyWhenUnfocused),
    sound: bool(s.sound, d.sound),
    quietHours: {
      enabled: bool(q.enabled, d.quietHours.enabled),
      from: isTime(q.from) ? q.from : d.quietHours.from,
      to: isTime(q.to) ? q.to : d.quietHours.to
    },
    showPreview: bool(s.showPreview, d.showPreview)
  }
}

/**
 * Проверка патча из IPC перед мержем: бросает на неверный тип/формат, чтобы UI показал ошибку,
 * а не молча сохранил мусор. Возвращает настройки после мержа (вложенные roles/events/quietHours — тоже мерж).
 */
export function mergeNotificationSettings(current: NotificationSettings, patch: unknown): NotificationSettings {
  if (!isRecord(patch)) throw new Error('notifications: ожидается объект')
  const flag = (key: string): boolean | undefined => {
    const v = patch[key]
    if (v === undefined) return undefined
    if (typeof v !== 'boolean') throw new Error(`notifications.${key} должен быть boolean`)
    return v
  }
  const next: NotificationSettings = { ...current, roles: { ...current.roles }, events: { ...current.events }, quietHours: { ...current.quietHours } }
  for (const key of ['enabled', 'onlyWhenUnfocused', 'sound', 'showPreview'] as const) {
    const v = flag(key)
    if (v !== undefined) next[key] = v
  }
  if (patch.roles !== undefined) {
    if (!isRecord(patch.roles)) throw new Error('notifications.roles: ожидается объект')
    for (const [id, on] of Object.entries(patch.roles)) {
      if (typeof on !== 'boolean') throw new Error(`notifications.roles.${id} должен быть boolean`)
      next.roles[id] = on
    }
  }
  if (patch.events !== undefined) {
    if (!isRecord(patch.events)) throw new Error('notifications.events: ожидается объект')
    for (const [k, on] of Object.entries(patch.events)) {
      if (!(NOTIFY_KINDS as string[]).includes(k)) throw new Error(`notifications.events: неизвестный вид «${k}»`)
      if (typeof on !== 'boolean') throw new Error(`notifications.events.${k} должен быть boolean`)
      next.events[k as NotifyKind] = on
    }
  }
  if (patch.quietHours !== undefined) {
    const q = patch.quietHours
    if (!isRecord(q)) throw new Error('notifications.quietHours: ожидается объект')
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== 'boolean') throw new Error('notifications.quietHours.enabled должен быть boolean')
      next.quietHours.enabled = q.enabled
    }
    for (const key of ['from', 'to'] as const) {
      if (q[key] === undefined) continue
      if (!isTime(q[key])) throw new Error(`тихие часы: время в формате ЧЧ:ММ (${String(q[key])})`)
      next.quietHours[key] = q[key]
    }
  }
  return next
}

/** Момент `now` попадает в тихие часы [from, to). from > to — через полночь; from = to — пустой интервал. */
export function inQuietHours(q: QuietHours, now: Date): boolean {
  if (!q.enabled) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const from = minutes(q.from)
  const to = minutes(q.to)
  if (from === to) return false
  return from < to ? m >= from && m < to : m >= from || m < to
}

/** Что уведомляет: вид и роль задачи-источника (у run_done — координатор). */
export interface NotifyEvent {
  kind: NotifyKind
  roleId: string
}

/** Показывать ли уведомление. `focused` — окно приложения в фокусе. */
export function shouldNotify(event: NotifyEvent, s: NotificationSettings, now: Date, focused: boolean): boolean {
  if (!s.enabled) return false
  if (!s.events[event.kind]) return false
  if (s.roles[event.roleId] === false) return false
  if (s.onlyWhenUnfocused && focused) return false
  if (inQuietHours(s.quietHours, now)) return false
  return true
}
