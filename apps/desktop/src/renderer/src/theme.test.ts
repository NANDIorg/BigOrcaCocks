import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appThemes, getAppTheme, type ThemeColors } from '../../shared/theme'

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

function saturation(hex: string): number {
  const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
  const max = Math.max(...channels), min = Math.min(...channels)
  return max === min ? 0 : (max - min) / (1 - Math.abs(max + min - 1))
}

for (const normal of Object.values(appThemes)) {
  test(`${normal.id}: насыщенность усиливает цветные элементы и сохраняет нейтральные поверхности`, () => {
    const vivid = getAppTheme(normal.id, true)
    const colored: (keyof ThemeColors)[] = ['accent', 'accent-2', 'accent-hover', 'col-ready', 'col-progress', 'col-input', 'col-review', 'col-done', 'danger', 'wf-accept', 's1', 's2', 's3', 's4', 's5']
    for (const token of colored) assert.ok(saturation(vivid.colors[token]) > saturation(normal.colors[token]), token)
    for (const token of Object.keys(normal.colors) as (keyof ThemeColors)[]) {
      if (!colored.includes(token)) assert.equal(vivid.colors[token], normal.colors[token], token)
    }
    assert.deepEqual(getAppTheme(normal.id).colors, normal.colors)
  })
}

for (const { theme, mode } of Object.values(appThemes).flatMap(theme => [{ theme, mode: 'обычный' }, { theme: getAppTheme(theme.id, true), mode: 'насыщенный' }])) {
  const appColors = theme.colors
  test(`${theme.id} (${mode}): синтаксис читается на фоне исходников и блоков Markdown`, () => {
    for (const token of ['syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-function', 'syntax-property', 'syntax-tag'] as const) {
      assert.equal(typeof appColors[token], 'string', token)
      assert.ok(contrast(appColors[token], appColors['code-bg']) >= 4.5, `${token} на ${appColors['code-bg']}`)
    }
  })

  test(`${theme.id} (${mode}): основной и вторичный текст читаются на всех рабочих поверхностях`, () => {
    for (const background of [appColors.page, appColors.frame, appColors.side, appColors['side-2'], appColors.card, appColors['card-hover'], appColors['code-bg'], appColors['tooltip-bg'], appColors['preview-bg']]) {
      for (const foreground of [appColors.text, appColors.muted, appColors.subtle]) {
        assert.ok(contrast(foreground, background) >= 4.5, `${foreground} на ${background}`)
      }
    }
  })

  test(`${theme.id} (${mode}): подписи залитых кнопок и семантических статусов имеют контраст AA`, () => {
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

  test(`${theme.id} (${mode}): высокий приоритет читается на тонированной карточке и при наведении`, () => {
    const foreground = mix(appColors['col-progress'], appColors.text, .6)
    for (const surface of [appColors.card, appColors['card-hover']]) {
      const background = mix(appColors['col-progress'], surface, .16)
      assert.ok(contrast(foreground, background) >= 4.5, `тонированный приоритет на ${surface}`)
    }
  })

  test(`${theme.id} (${mode}): текст терминала и курсор различимы независимо от светлой/тёмной темы`, () => {
    assert.ok(contrast(appColors['term-text'], appColors['term-bg']) >= 4.5)
    assert.ok(contrast(appColors['term-muted'], appColors['term-bg']) >= 4.5)
    assert.ok(contrast(appColors['term-cursor'], appColors['term-bg']) >= 3)
  })
}
