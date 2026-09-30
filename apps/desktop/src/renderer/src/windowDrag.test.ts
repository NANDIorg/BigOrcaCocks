// Drag-области интегрированного заголовка macOS: Chromium собирает их без учёта перекрытия по z-index, поэтому
// поверхность поверх шапки без собственного `app-region: no-drag` кликается «кусочками» (так сломались «Документы»
// и мастер после df85313). Проверяем styles.css и разметку как текст — поведение Chromium тест не доказывает.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = import.meta.dirname
const css = readFileSync(join(dir, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const MAC = "html[data-window-chrome='macos']"

/** Правила верхнего уровня и внутри @media: селектор → тело. */
function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(css); m; m = re.exec(css)) out.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] })
  return out
}

/** Классы из `:is(…)` селектора: запятые внутри скобок — не разделители правил, поэтому режем только тело `:is`. */
function isClasses(selector: string): string[] {
  const m = /:is\(([^()]*)\)/.exec(selector)
  return m ? m[1].split(',').map((s) => s.trim()) : []
}

const macRules = rules().filter((r) => r.selector.startsWith(MAC))
const noDrag = macRules.filter((r) => /app-region:\s*no-drag/.test(r.body))

/** Явный список поверхностей вне backdrop: `html[…] :is(.modal, …) { app-region: no-drag }`. */
const surfaceList = noDrag.find((r) => /^:is\([^()]*\)$/.test(r.selector.slice(MAC.length + 1)))
/** Контролы внутри шапок: `:is(.sidebar > .head, .main-head) :is(button, …)`. */
const headControls = noDrag.find((r) => /\.main-head\) :is\(/.test(r.selector))

test('прямые потомки backdrop на macOS — no-drag', () => {
  const rule = noDrag.find((r) => /> \*$/.test(r.selector))
  assert.ok(rule, 'нет правила :is(.modal-backdrop, .inbox-full-backdrop) > * с app-region: no-drag')
  assert.deepEqual(isClasses(rule.selector).sort(), ['.inbox-full-backdrop', '.modal-backdrop'])
})

test('меню «Переместить в…» — в явном списке no-drag', () => {
  assert.ok(surfaceList, 'нет явного списка поверхностей с app-region: no-drag')
  for (const cls of ['.modal', '.settings-modal', '.inbox', '.popup-menu', '.move-menu', '.lightbox']) {
    assert.ok(isClasses(surfaceList.selector).includes(cls), `${cls} нет в списке no-drag`)
  }
})

test('высота .docs-modal на macOS учитывает кромку окна', () => {
  const rule = macRules.find((r) => r.selector === `${MAC} .docs-modal`)
  assert.ok(rule, 'нет macOS-правила для .docs-modal')
  assert.match(rule.body, /height:\s*calc\(100dvh - var\(--window-overlay-top\) - var\(--window-overlay-gap\)\)/)
})

// Защита от следующего «забыли»: каждый role="dialog" лежит прямо в backdrop или покрыт явным no-drag.
test('каждый диалог renderer защищён от drag-областей шапок', () => {
  assert.ok(surfaceList && headControls, 'нет правил no-drag для поверхностей и контролов шапок')
  const covered = new Set([...isClasses(surfaceList.selector), ...isClasses(headControls.selector.slice(headControls.selector.lastIndexOf(':is(')))])
  const files = [...readdirSync(dir), ...readdirSync(join(dir, 'settings')).map((f) => `settings/${f}`), ...readdirSync(join(dir, 'about')).map((f) => `about/${f}`)]
    .filter((f) => f.endsWith('.tsx'))
  // Обёртки, которые рендерят children прямо в backdrop (ModalPortal в GroupDialogs.tsx).
  const wrappers = new Set<string>()
  const sources = files.map((file) => ({ file, src: readFileSync(join(dir, file), 'utf8') }))
  for (const { src } of sources) {
    const re = /function (\w+)\([^)]*\)[^{]*\{[\s\S]*?className="(?:modal-backdrop|inbox-full-backdrop)\b[^"]*"[^>]*>\s*\{children\}/g
    for (let m = re.exec(src); m; m = re.exec(src)) wrappers.add(m[1])
  }
  let dialogs = 0
  for (const { file, src } of sources) {
    // Открывающие JSX-теги по порядку; атрибуты могут переноситься и содержать `=>` и `{…}`.
    const tags = /<([A-Za-z]+)\b((?:[^<>]|=>|\{[^{}]*\})*?)>/g
    let prev: { name: string; attrs: string } | undefined
    for (let m = tags.exec(src); m; m = tags.exec(src)) {
      const tag = { name: m[1], attrs: m[2] }
      if (/role="dialog"/.test(tag.attrs)) {
        dialogs++
        const cls = /className=\{?[`"]([\w-]+)/.exec(tag.attrs)?.[1]
        assert.ok(cls, `${file}: у role="dialog" не найден класс`)
        // Диалог сразу после backdrop — его прямой потомок: так устроены все оверлеи renderer.
        const inBackdrop = prev !== undefined
          && (/className=\{?[`"](?:modal-backdrop|inbox-full-backdrop)\b/.test(prev.attrs) || wrappers.has(prev.name))
        assert.ok(inBackdrop || covered.has(`.${cls}`), `${file}: .${cls} не лежит прямо в backdrop и не входит в список no-drag`)
      }
      prev = tag
    }
  }
  assert.ok(dialogs >= 10, `найдено слишком мало диалогов (${dialogs}): разбор разметки сломался`)
})
