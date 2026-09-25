// Запуск: pnpm --filter @orca-board/desktop test. Что плашка и «Настройки → Обновления» показывают при каждом
// состоянии обновления, живые агенты для выбора «Сейчас / Когда закончат» и защита от старого preload.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { UpdateState } from '../../shared/ipc'
import { setLocale } from './i18n'
import { formatPercent } from './i18n/format'
import {
  bannerView, canCheck, isReleaseUrl, isStaleUpdatesError, liveAgentCount, needsAttention, pendingText, statusLine, unsupportedText,
  updatesApi, versionLabel
} from './updateState'

afterEach(() => setLocale('ru'))

const base: UpdateState = {
  status: 'idle', currentVersion: '0.4.1', availableVersion: null, releaseNotes: null, releaseUrl: null,
  percent: null, installPending: null, mode: 'auto', unsupportedReason: null, error: null
}
const found: Partial<UpdateState> = {
  availableVersion: '0.4.2', releaseNotes: '## Что нового\n- всё', releaseUrl: 'https://github.com/NANDIorg/BigOrcaCocks/releases/tag/v0.4.2'
}
const st = (patch: Partial<UpdateState>): UpdateState => ({ ...base, ...patch })

describe('bannerView', () => {
  it('нет состояния, idle, checking и dev — плашки нет', () => {
    assert.equal(bannerView(null), null)
    assert.equal(bannerView(base), null)
    assert.equal(bannerView(st({ status: 'checking' })), null)
    assert.equal(bannerView(st({ status: 'unsupported', unsupportedReason: 'dev' })), null)
  })

  it('available: «Доступна v…», «Что нового» и «Скачать»', () => {
    const v = bannerView(st({ ...found, status: 'available' }))
    assert.equal(v?.kind, 'available')
    assert.equal(v?.title, 'Доступна v0.4.2')
    assert.deepEqual(v?.actions, ['whatsNew', 'download'])
    assert.equal(v?.primary, 'download')
  })

  it('available без заметок: «Что нового» не предлагается', () => {
    const v = bannerView(st({ ...found, releaseNotes: null, status: 'available' }))
    assert.deepEqual(v?.actions, ['download'])
  })

  it('downloading: прогресс и никаких кнопок; размер неизвестен — percent null', () => {
    const v = bannerView(st({ ...found, status: 'downloading', percent: 42 }))
    assert.equal(v?.kind, 'downloading')
    assert.equal(v?.percent, 42)
    assert.deepEqual(v?.actions, [])
    assert.equal(bannerView(st({ ...found, status: 'downloading' }))?.percent, null)
  })

  it('ready: «Перезапустить и обновить» — главная кнопка', () => {
    const v = bannerView(st({ ...found, status: 'ready' }))
    assert.equal(v?.title, 'v0.4.2 готова')
    assert.deepEqual(v?.actions, ['install', 'whatsNew'])
    assert.equal(v?.primary, 'install')
    assert.equal(v?.detail, undefined)
  })

  it('ready с отложенной установкой: подпись и «Отменить»', () => {
    const quit = bannerView(st({ ...found, status: 'ready', installPending: 'quit' }))
    assert.equal(quit?.detail, 'Установится при выходе из приложения')
    assert.deepEqual(quit?.actions, ['install', 'cancelPending', 'whatsNew'])
    const idle = bannerView(st({ ...found, status: 'ready', installPending: 'idle' }))
    assert.equal(idle?.detail, 'Установится, когда агенты закончат')
  })

  it('installing: без кнопок', () => {
    const v = bannerView(st({ ...found, status: 'installing' }))
    assert.equal(v?.kind, 'installing')
    assert.deepEqual(v?.actions, [])
  })

  it('error: текст ошибки и «Повторить»', () => {
    const v = bannerView(st({ status: 'error', error: 'Не совпала контрольная сумма' }))
    assert.equal(v?.kind, 'error')
    assert.equal(v?.detail, 'Не совпала контрольная сумма')
    assert.deepEqual(v?.actions, ['retry'])
    assert.equal(v?.primary, 'retry')
    assert.equal(bannerView(st({ status: 'error' }))?.detail, undefined)
  })

  it('manual-download (portable): «Скачать» со страницы релиза и причина', () => {
    const v = bannerView(st({ ...found, status: 'unsupported', mode: 'manual-download', unsupportedReason: 'portable' }))
    assert.equal(v?.kind, 'manual')
    assert.match(v?.detail ?? '', /Portable/)
    assert.deepEqual(v?.actions, ['whatsNew', 'openRelease'])
    assert.equal(v?.primary, 'openRelease')
  })

  it('manual-download на macOS вне «Программ»: причина из unsupportedReason', () => {
    const v = bannerView(st({ ...found, status: 'unsupported', mode: 'manual-download', unsupportedReason: 'not-in-applications' }))
    assert.match(v?.detail ?? '', /«Программ»/)
  })

  it('unsupported без найденной версии или без ссылки на релиз — плашки нет', () => {
    assert.equal(bannerView(st({ status: 'unsupported', mode: 'manual-download', unsupportedReason: 'portable' })), null)
    assert.equal(bannerView(st({ ...found, releaseUrl: null, status: 'unsupported', mode: 'manual-download', unsupportedReason: 'portable' })), null)
    assert.equal(bannerView(st({ ...found, status: 'unsupported', mode: 'auto', unsupportedReason: 'no-write-access' })), null)
  })

  it('английский интерфейс: те же состояния, английские подписи', () => {
    setLocale('en')
    assert.equal(bannerView(st({ ...found, status: 'available' }))?.title, 'v0.4.2 is available')
    assert.equal(bannerView(st({ ...found, status: 'ready', installPending: 'quit' }))?.detail, 'Will be installed when you quit the app')
  })
})

describe('needsAttention', () => {
  it('просит внимания: available, ready, error, manual; не просит: скачивание, установка, пусто', () => {
    assert.equal(needsAttention(st({ ...found, status: 'available' })), true)
    assert.equal(needsAttention(st({ ...found, status: 'ready' })), true)
    assert.equal(needsAttention(st({ status: 'error', error: 'x' })), true)
    assert.equal(needsAttention(st({ ...found, status: 'downloading', percent: 3 })), false)
    assert.equal(needsAttention(st({ ...found, status: 'installing' })), false)
    assert.equal(needsAttention(base), false)
    assert.equal(needsAttention(null), false)
  })
})

describe('canCheck', () => {
  it('проверять можно из idle, available и error; при проверке, скачивании, установке и unsupported — нет', () => {
    for (const status of ['idle', 'available', 'error'] as const) assert.equal(canCheck(st({ status })), true, status)
    for (const status of ['checking', 'downloading', 'ready', 'installing', 'unsupported'] as const) assert.equal(canCheck(st({ status })), false, status)
    assert.equal(canCheck(null), false)
  })
})

describe('statusLine', () => {
  it('строка статуса по состояниям', () => {
    assert.equal(statusLine(base), 'Обновлений не найдено.')
    assert.equal(statusLine(st({ status: 'checking' })), 'Проверяем наличие обновлений…')
    assert.equal(statusLine(st({ ...found, status: 'available' })), 'Доступна версия v0.4.2.')
    assert.equal(statusLine(st({ status: 'error', error: 'нет сети' })), 'Ошибка: нет сети')
    assert.equal(statusLine(st({ status: 'error' })), 'Не удалось проверить обновления.')
    assert.match(statusLine(st({ ...found, status: 'downloading', percent: 50 })), /v0\.4\.2: 50\s?%\./)
    assert.match(statusLine(st({ ...found, status: 'ready', installPending: 'idle' })), /готова к установке\. Установится, когда агенты закончат$/)
  })

  it('unsupported: причина, а найденная версия — впереди', () => {
    assert.equal(statusLine(st({ status: 'unsupported', unsupportedReason: 'dev' })), unsupportedText('dev'))
    assert.ok(statusLine(st({ ...found, status: 'unsupported', unsupportedReason: 'portable' })).startsWith('Доступна версия v0.4.2. '))
  })

  it('неизвестная причина (новый main) — общий текст, а не «undefined»', () => {
    assert.match(unsupportedText(null), /недоступно/)
  })
})

describe('liveAgentCount', () => {
  const list = [
    { ptyId: 'a', role: 'worker' as const },
    { ptyId: 'b', role: 'coordinator' as const },
    { ptyId: 'c', role: 'shell' as const },
    { ptyId: 'd', role: 'worker' as const }
  ]
  it('оболочки и завершённые не считаются', () => {
    assert.equal(liveAgentCount(list, new Set()), 3)
    assert.equal(liveAgentCount(list, new Set(['a', 'c'])), 2)
    assert.equal(liveAgentCount([], new Set()), 0)
  })
})

describe('вспомогательные', () => {
  it('versionLabel не дублирует «v»', () => {
    assert.equal(versionLabel('0.4.2'), 'v0.4.2')
    assert.equal(versionLabel('v0.4.2'), 'v0.4.2')
  })

  it('pendingText: quit, idle и ничего', () => {
    assert.equal(pendingText(null), undefined)
    assert.ok(pendingText('quit')?.includes('выходе'))
    assert.ok(pendingText('idle')?.includes('агенты'))
  })

  it('formatPercent: по языку, обрезает диапазон', () => {
    assert.match(formatPercent(42), /^42\s?%$/)
    assert.match(formatPercent(150), /^100\s?%$/)
    assert.match(formatPercent(-5), /^0\s?%$/)
    assert.match(formatPercent(NaN), /^0\s?%$/)
    setLocale('en')
    assert.equal(formatPercent(42), '42%')
  })

  it('isReleaseUrl: только http(s)', () => {
    assert.equal(isReleaseUrl('https://github.com/x'), true)
    assert.equal(isReleaseUrl('file:///etc/passwd'), false)
    assert.equal(isReleaseUrl('javascript:alert(1)'), false)
    assert.equal(isReleaseUrl(null), false)
  })

  it('updatesApi: старый preload без updates — null, а не падение', () => {
    assert.equal(updatesApi(undefined), null)
    assert.equal(updatesApi({}), null)
    const api = { getState: async () => base } as unknown as NonNullable<Parameters<typeof updatesApi>[0]>['updates']
    assert.equal(updatesApi({ updates: api }), api)
  })

  it('isStaleUpdatesError: preload новый, main старый', () => {
    assert.equal(isStaleUpdatesError("No handler registered for 'updates:getState'"), true)
    assert.equal(isStaleUpdatesError("No handler registered for 'docs:list'"), false)
  })
})
