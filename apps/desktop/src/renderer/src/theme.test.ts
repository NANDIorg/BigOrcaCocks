import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appThemes } from '../../shared/theme'

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(start => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + .05) / (values[1] + .05)
}

function mix(first: string, second: string, weight: number): string {
  const channels = [1, 3, 5].map(start => {
    const value = parseInt(first.slice(start, start + 2), 16) * weight + parseInt(second.slice(start, start + 2), 16) * (1 - weight)
    return Math.round(value).toString(16).padStart(2, '0')
  })
  return `#${channels.join('')}`
}

for (const theme of Object.values(appThemes)) {
  const appColors = theme.colors
  test(`${theme.id}: основной и вторичный текст читаются на всех рабочих поверхностях`, () => {
    for (const background of [appColors.page, appColors.frame, appColors.side, appColors['side-2'], appColors.card, appColors['card-hover'], appColors['code-bg'], appColors['tooltip-bg'], appColors['preview-bg']]) {
      for (const foreground of [appColors.text, appColors.muted, appColors.subtle]) {
        assert.ok(contrast(foreground, background) >= 4.5, `${foreground} на ${background}`)
      }
    }
  })

  test(`${theme.id}: подписи залитых кнопок и семантических статусов имеют контраст AA`, () => {
    for (const background of [appColors.accent, appColors['accent-2'], appColors['accent-hover'], appColors.danger, appColors['col-progress'], appColors['col-input'], appColors['col-review'], appColors['col-done']]) {
      assert.ok(contrast(appColors['on-accent'], background) >= 4.5, `кнопка или статус ${background}`)
    }
    for (const background of [appColors.page, appColors.side, appColors.card]) {
      assert.ok(contrast(appColors.accent, background) >= 3, `фокус на ${background}`)
    }
    for (const background of [appColors.page, appColors.side, appColors.card, appColors['card-hover']]) {
      for (const foreground of [appColors.danger, appColors['col-progress'], appColors['col-input'], appColors['col-review'], appColors['col-done']]) {
        assert.ok(contrast(foreground, background) >= 4.5, `текст статуса ${foreground} на ${background}`)
      }
    }
  })

  test(`${theme.id}: высокий приоритет читается на тонированной карточке и при наведении`, () => {
    const foreground = mix(appColors['col-progress'], appColors.text, .6)
    for (const surface of [appColors.card, appColors['card-hover']]) {
      const background = mix(appColors['col-progress'], surface, .16)
      assert.ok(contrast(foreground, background) >= 4.5, `тонированный приоритет на ${surface}`)
    }
  })

  test(`${theme.id}: текст терминала и курсор различимы независимо от светлой/тёмной темы`, () => {
    assert.ok(contrast(appColors['term-text'], appColors['term-bg']) >= 4.5)
    assert.ok(contrast(appColors['term-muted'], appColors['term-bg']) >= 4.5)
    assert.ok(contrast(appColors['term-cursor'], appColors['term-bg']) >= 3)
  })
}
