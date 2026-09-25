import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BoardColumn, StatusChange } from '@orca-board/core'
import { dayLabel, globalTimeline, groupByDay, summaryExcerpt, SUMMARY_EXCERPT_LIMIT, TIMELINE_COLLAPSED, visibleTimeline, type TimelineEvent } from './globalTimeline'
import { setLocale } from './i18n'

/** Выполнить на английском и вернуть русский: остальные тесты файла ждут язык по умолчанию. */
function inEnglish(fn: () => void): void {
  setLocale('en')
  try {
    fn()
  } finally {
    setLocale('ru')
  }
}

const columns: BoardColumn[] = [
  { id: 'backlog', title: 'Бэклог', color: '#111', kind: 'backlog' },
  { id: 'in_progress', title: 'В работе', color: '#222', kind: 'in_progress' },
  { id: 'review', title: 'Проверка', color: '#333', kind: 'review' },
  { id: 'done', title: 'Сделано', color: '#444', kind: 'done' }
]

// Локальное время: границы дней в тестах не зависят от часового пояса машины.
const at = (day: number, h = 12, m = 0): number => new Date(2026, 8, day, h, m).getTime()
const NOW = at(24, 16)
const change = (status: string, time: number, by: StatusChange['by'] = 'human', extra: Partial<StatusChange> = {}): StatusChange => ({ status, at: time, by, ...extra })

test('globalTimeline: ни одного поля (старый main) — пустая лента', () => {
  assert.deepEqual(globalTimeline({}, columns, NOW), [])
  assert.deepEqual(globalTimeline({ statusHistory: [], returns: [], coordinatorSessions: [] }, [], NOW), [])
})

test('globalTimeline: только createdAt — «Создана»', () => {
  const [e, ...rest] = globalTimeline({ createdAt: at(23, 9, 30) }, columns, NOW)
  assert.equal(rest.length, 0)
  assert.equal(e.kind, 'created')
  assert.equal(e.title, 'Создана')
  assert.equal(e.detail, undefined)
})

test('globalTimeline: первый переход при создании сливается с «Создана», колонка — в детали и цвете', () => {
  const events = globalTimeline({ createdAt: 1000, statusHistory: [change('backlog', 1500), change('in_progress', 9000, 'cli')] }, columns, NOW)
  assert.deepEqual(events.map((e) => e.kind), ['status', 'created'])
  const created = events[1]
  assert.equal(created.detail, 'в «Бэклог»')
  assert.equal(created.color, '#111')
  assert.equal(events[0].title, 'Переход в «В работе»')
})

test('globalTimeline: стартовая запись миграции — отдельное приблизительное событие, а не создание', () => {
  const events = globalTimeline({ createdAt: 1000, statusHistory: [change('in_progress', 1000, 'app', { migrated: true })] }, columns, NOW)
  assert.deepEqual(events.map((e) => e.kind), ['status', 'created'])
  assert.equal(events[0].approx, true)
  assert.equal(events[0].title, 'Статус «В работе»')
  assert.equal(events[0].detail, 'на момент обновления приложения')
  assert.equal(events[1].detail, undefined)
})

test('globalTimeline: переход — источник и длительность в колонке, у текущего «сейчас»', () => {
  const events = globalTimeline(
    { statusHistory: [change('in_progress', at(24, 10), 'human'), change('review', at(24, 12), 'cli')] },
    columns,
    at(24, 14)
  )
  const [review, work] = events
  assert.equal(review.sub, 'координатор / CLI · сейчас · ⏱ 2 ч')
  assert.equal(work.sub, 'человек · 2 ч')
  assert.equal(review.color, '#333')
})

test('globalTimeline: колонку удалили или источник неизвестен — id и источник как есть, без цвета', () => {
  const [e] = globalTimeline({ statusHistory: [{ status: 'gone', at: 5, by: 'robot' as StatusChange['by'] }] }, columns, 5)
  assert.equal(e.title, 'Переход в «gone»')
  assert.equal(e.color, undefined)
  assert.ok(e.sub?.startsWith('robot'))
})

test('globalTimeline: уточнения выделены и сохраняют текст целиком', () => {
  const text = 'Кириллица в PDF — квадраты.\nПроверь шрифты.'
  const [e] = globalTimeline({ returns: [{ at: 5, text }] }, columns, NOW)
  assert.equal(e.kind, 'return')
  assert.equal(e.highlight, true)
  assert.equal(e.text, text)
  const others = globalTimeline({ createdAt: 1, closedAt: 2, summary: { at: 3, text: 'x' } }, columns, NOW)
  assert.ok(others.every((o) => !o.highlight))
})

test('globalTimeline: сводка — выдержка, запуски координатора — по одному событию с номером и длительностью', () => {
  const events = globalTimeline(
    {
      summary: { at: 30, text: '## Итог\n\n- **Сделан** экспорт' },
      coordinatorSessions: [
        { ptyId: 'p1', roleId: 'coordinator', agent: 'claude', model: 'opus', startedAt: at(24, 10), endedAt: at(24, 11, 12) },
        { ptyId: 'p2', roleId: 'coordinator', agent: 'claude', startedAt: at(24, 12) }
      ]
    },
    columns,
    NOW
  )
  const summary = events.find((e) => e.kind === 'summary')
  assert.equal(summary?.text, 'Сделан экспорт')
  const runs = events.filter((e) => e.kind === 'coordinator')
  assert.equal(runs.length, 2)
  assert.equal(runs[1].sub, '1-й запуск · работал 1 ч 12 мин')
  assert.ok(runs[1].detail?.endsWith('opus'))
  assert.equal(runs[0].sub, '2-й запуск')
})

test('globalTimeline: единственный запуск без «1-й», сессия без endedAt — без длительности', () => {
  const [e] = globalTimeline({ coordinatorSessions: [{ ptyId: 'p', roleId: 'c', agent: 'claude', startedAt: 7 }] }, columns, NOW)
  assert.equal(e.sub, undefined)
})

test('globalTimeline: записи без корректного времени отбрасываются', () => {
  const events = globalTimeline(
    {
      createdAt: Number.NaN,
      closedAt: undefined,
      statusHistory: [{ status: 'review', at: Number.NaN, by: 'human' }],
      returns: [{ at: undefined as unknown as number, text: 'a' }],
      summary: { at: Number.POSITIVE_INFINITY, text: 'b' },
      coordinatorSessions: [{ ptyId: 'p', roleId: 'c', agent: 'claude', startedAt: undefined as unknown as number }]
    },
    columns,
    NOW
  )
  assert.deepEqual(events, [])
})

test('globalTimeline: сортировка — новые сверху, при равной метке следствие выше причины', () => {
  const t = 100
  const events = globalTimeline(
    {
      createdAt: 1,
      statusHistory: [change('backlog', 1), change('in_progress', t), change('review', 200)],
      returns: [{ at: t, text: 'доделай' }],
      coordinatorSessions: [{ ptyId: 'p', roleId: 'c', agent: 'claude', startedAt: t }],
      closedAt: 200,
      summary: { at: 200, text: 'итог' }
    },
    columns,
    NOW
  )
  assert.deepEqual(
    events.map((e) => e.kind),
    // 200: переход на проверку ← закрытие ← сводка; 100: запуск ← переход в работу ← уточнение; 1: создание.
    ['status', 'closed', 'summary', 'coordinator', 'status', 'return', 'created']
  )
})

test('globalTimeline: не мутирует вход', () => {
  const statusHistory = [change('backlog', 1), change('review', 2)]
  const returns = [{ at: 9, text: 'a' }, { at: 3, text: 'b' }]
  globalTimeline({ statusHistory, returns }, columns, NOW)
  assert.deepEqual(returns.map((r) => r.at), [9, 3])
  assert.deepEqual(statusHistory.map((h) => h.at), [1, 2])
})

test('groupByDay: группы по локальным дням, порядок событий сохраняется', () => {
  const ev = (key: string, time: number): TimelineEvent => ({ key, kind: 'status', at: time, title: key })
  const days = groupByDay([ev('a', at(24, 15)), ev('b', at(24, 9)), ev('c', at(23, 23, 59)), ev('d', at(23, 0, 1)), ev('e', at(20))], NOW)
  assert.deepEqual(days.map((d) => d.events.map((e) => e.key)), [['a', 'b'], ['c', 'd'], ['e']])
  assert.deepEqual(days.map((d) => d.label), ['Сегодня', 'Вчера', '20 сентября'])
  assert.deepEqual(groupByDay([], NOW), [])
})

test('dayLabel: сегодня, вчера, дата; другой год — с годом', () => {
  assert.equal(dayLabel(at(24, 1), NOW), 'Сегодня')
  assert.equal(dayLabel(at(23, 23), NOW), 'Вчера')
  assert.equal(dayLabel(at(22), NOW), '22 сентября')
  assert.equal(dayLabel(new Date(2025, 11, 31).getTime(), NOW), '31 декабря 2025 г.')
})

test('summaryExcerpt: первая содержательная строка без разметки, длинная обрезается', () => {
  assert.equal(summaryExcerpt('\n\n### Что сделано\nдетали'), 'детали')
  assert.equal(summaryExcerpt('### Только заголовок'), 'Только заголовок')
  assert.equal(summaryExcerpt('1. **Готово** `код`'), 'Готово код')
  assert.equal(summaryExcerpt('  \n '), undefined)
  assert.equal(summaryExcerpt(undefined), undefined)
  const long = summaryExcerpt('я'.repeat(SUMMARY_EXCERPT_LIMIT + 50))
  assert.equal(long?.length, SUMMARY_EXCERPT_LIMIT)
  assert.ok(long?.endsWith('…'))
})

test('visibleTimeline: свёрнутая лента — новейшие события, развёрнутая — все', () => {
  const events = Array.from({ length: TIMELINE_COLLAPSED + 5 }, (_, i): TimelineEvent => ({ key: `e${i}`, kind: 'status', at: 1000 - i, title: 't' }))
  assert.equal(visibleTimeline(events, false).length, TIMELINE_COLLAPSED)
  assert.equal(visibleTimeline(events, false)[0].key, 'e0')
  assert.equal(visibleTimeline(events, true).length, events.length)
  assert.equal(visibleTimeline(events.slice(0, 3), false).length, 3)
})

test('английский интерфейс: подписи дней и событий ленты', () => {
  inEnglish(() => {
    assert.equal(dayLabel(at(24, 1), NOW), 'Today')
    assert.equal(dayLabel(at(23, 23), NOW), 'Yesterday')
    assert.equal(dayLabel(at(22), NOW), 'September 22')
    assert.equal(dayLabel(new Date(2025, 11, 31).getTime(), NOW), 'December 31, 2025')
    const events = globalTimeline({
      createdAt: at(20),
      statusHistory: [change('backlog', at(20)), change('review', at(21))],
      returns: [{ at: at(22), text: 'fix it' }],
      closedAt: at(23)
    }, columns, NOW)
    assert.deepEqual(events.map((e) => [e.title, e.detail]), [
      ['Work closed', undefined],
      ['Returned from review', 'follow-up'],
      ['Moved to “Проверка”', undefined],
      ['Created', 'in “Бэклог”']
    ])
  })
})
