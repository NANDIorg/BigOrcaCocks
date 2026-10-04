// Запуск: pnpm --filter @orca-board/desktop test. i18n интерфейса: ключи ru/en во всех областях, подстановка
// параметров, множественное число, форматирование чисел и длительностей по языку, выбор языка при старте.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { DICTS, RU } from './i18n/dict'
import { getLocale, interpolate, pluralCategory, setLocale, settingsLocale, t, translate, type Locale, type PluralMessage } from './i18n'
import { formatDateTime, formatDuration, formatFixed, formatInteger, intlLocale } from './i18n/format'
import { formatAgentTime, formatAxis, formatTokens, formatUsd } from './statsFormat'

afterEach(() => setLocale('ru'))

const isPlural = (m: unknown): m is PluralMessage => typeof m === 'object' && m !== null

describe('словари', () => {
  it('в каждой области en — те же ключи, что ru', () => {
    for (const area of Object.keys(RU) as (keyof typeof RU)[]) {
      assert.deepEqual(Object.keys(DICTS.en[area]).sort(), Object.keys(DICTS.ru[area]).sort(), `область ${area}`)
    }
  })

  it('plural-сообщения: ru — one/few/many, en — one/other; ключ plural в обоих языках или ни в одном', () => {
    for (const area of Object.keys(RU) as (keyof typeof RU)[]) {
      for (const [key, ru] of Object.entries(DICTS.ru[area])) {
        const en = DICTS.en[area][key]
        assert.equal(isPlural(en), isPlural(ru), `${area}.${key}`)
        if (isPlural(ru)) assert.ok(ru.few !== undefined && ru.many !== undefined, `${area}.${key}: в ru нужны few и many`)
        if (isPlural(en)) assert.ok(en.other !== undefined, `${area}.${key}: в en нужен other`)
      }
    }
  })

  it('параметры {name} совпадают в ru и en', () => {
    const names = (m: unknown): string[] =>
      [...new Set((isPlural(m) ? Object.values(m).join(' ') : String(m)).match(/\{\w+\}/g) ?? [])].sort()
    for (const area of Object.keys(RU) as (keyof typeof RU)[]) {
      for (const [key, ru] of Object.entries(DICTS.ru[area])) {
        assert.deepEqual(names(DICTS.en[area][key]), names(ru), `${area}.${key}`)
      }
    }
  })
})

describe('t', () => {
  it('русский по умолчанию, смена языка меняет t', () => {
    assert.equal(getLocale(), 'ru')
    assert.equal(t('settings.title'), 'Настройки')
    setLocale('en')
    assert.equal(t('settings.title'), 'Settings')
  })

  it('подставляет параметры, неизвестный оставляет видимым', () => {
    assert.equal(translate('ru', 'settings.nav.typeUsage', { count: 3 }), 'Тип по умолчанию в проектах: 3')
    assert.equal(translate('en', 'common.unit.min', { n: 5 }), '5 min')
    assert.equal(interpolate('{a} и {b}', { a: 1 }), '1 и {b}')
    assert.equal(interpolate('без параметров {x}', undefined), 'без параметров {x}')
  })

  it('неизвестный ключ — сам ключ, а не падение', () => {
    assert.equal(translate('en', 'nope.key' as 'settings.title'), 'nope.key')
  })
})

describe('множественное число', () => {
  it('ru: one / few / many', () => {
    const cat = (n: number): string => pluralCategory('ru', n)
    assert.deepEqual([1, 21, 101].map(cat), ['one', 'one', 'one'])
    assert.deepEqual([2, 4, 22, 34].map(cat), ['few', 'few', 'few', 'few'])
    assert.deepEqual([0, 5, 11, 12, 14, 25, 111].map(cat), ['many', 'many', 'many', 'many', 'many', 'many', 'many'])
  })

  it('en: one / other', () => {
    const cat = (n: number): string => pluralCategory('en', n)
    assert.deepEqual([1, 0, 2, 11, 21].map(cat), ['one', 'other', 'other', 'other', 'other'])
  })

  it('translate выбирает форму по count', () => {
    // Словари областей пока без plural-ключей: проверяем выбор формы на временном ключе.
    const saved = DICTS.ru.common
    const savedEn = DICTS.en.common
    const tasks = { tasks: { one: '{count} задача', few: '{count} задачи', many: '{count} задач' } }
    DICTS.ru.common = { ...saved, ...tasks }
    DICTS.en.common = { ...savedEn, tasks: { one: '{count} task', other: '{count} tasks' } }
    try {
      const key = 'common.tasks' as 'common.close'
      assert.deepEqual([1, 3, 5, 21].map((count) => translate('ru', key, { count })), ['1 задача', '3 задачи', '5 задач', '21 задача'])
      assert.deepEqual([1, 3, 0].map((count) => translate('en', key, { count })), ['1 task', '3 tasks', '0 tasks'])
    } finally {
      DICTS.ru.common = saved
      DICTS.en.common = savedEn
    }
  })
})

describe('выбор языка', () => {
  it('выбранный в настройках язык; не выбран, старый main или мусор — русский (язык системы не угадываем)', () => {
    assert.equal(settingsLocale({ language: 'en' }), 'en')
    assert.equal(settingsLocale({ language: 'ru' }), 'ru')
    assert.equal(settingsLocale({}), 'ru')
    assert.equal(settingsLocale(null), 'ru')
    assert.equal(settingsLocale({ language: 'de' as Locale }), 'ru')
  })
})

describe('форматирование по языку', () => {
  it('длительность', () => {
    assert.equal(formatDuration(30_000), '<1 мин')
    assert.equal(formatDuration(2 * 3600_000 + 15 * 60_000), '2 ч 15 мин')
    assert.equal(formatDuration(3 * 86400_000 + 4 * 3600_000), '3 д 4 ч')
    setLocale('en')
    assert.equal(formatDuration(30_000), '<1 min')
    assert.equal(formatDuration(2 * 3600_000 + 15 * 60_000), '2 h 15 min')
    assert.equal(formatDuration(3 * 86400_000), '3 d')
    assert.equal(formatAgentTime(125 * 3600_000), '125 h')
  })

  it('числа: разделители разрядов и дробной части', () => {
    assert.equal(intlLocale('ru'), 'ru-RU')
    assert.equal(formatFixed(12.4, 2), '12,40')
    assert.equal(formatInteger(1234), (1234).toLocaleString('ru-RU'))
    setLocale('en')
    assert.equal(intlLocale(), 'en-US')
    assert.equal(formatFixed(12.4, 2), '12.40')
    assert.equal(formatInteger(1234), '1,234')
  })

  it('статистика: деньги, токены и деления оси на английском', () => {
    setLocale('en')
    assert.equal(formatUsd(12.4), '$12.40')
    assert.equal(formatUsd(0.001), '<$0.01')
    assert.equal(formatUsd(1234), '$1,234')
    assert.equal(formatTokens(12_000), '12K')
    assert.equal(formatTokens(1_200_000), '1.2M')
    assert.equal(formatAxis(1.5 * 3600_000, 'time'), '1.5 h')
    assert.equal(formatAxis(30 * 60_000, 'time'), '30 min')
  })

  it('дата и время', () => {
    const d = new Date(2026, 8, 25, 14, 5)
    assert.equal(formatDateTime(d), '25.09.2026, 14:05')
    setLocale('en')
    assert.equal(formatDateTime(d, { dateStyle: 'medium' }), 'Sep 25, 2026')
  })
})
