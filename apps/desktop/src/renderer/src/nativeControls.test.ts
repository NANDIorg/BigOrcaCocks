// Нативные контролы в тёмной теме: попап select на Windows/Linux рисует Chromium по CSS (на macOS — меню ОС), поэтому
// без `color-scheme: dark` и явных цветов опций список белый и нечитаемый. Проверяем styles.css как текст.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Правила верхнего уровня и внутри @media: селектор → тело. */
function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(css); m; m = re.exec(css)) out.push({ selector: m[1].trim(), body: m[2] })
  return out
}

const selectors = (r: { selector: string }): string[] => r.selector.split(',').map((s) => s.trim())

test(':root задаёт color-scheme: dark', () => {
  const root = rules().find((r) => selectors(r).includes(':root'))
  assert.ok(root, 'нет правила :root')
  assert.match(root.body, /color-scheme:\s*dark\s*;/)
})

test('у опций выпадающего select заданы фон и цвет', () => {
  const opt = rules().find((r) => selectors(r).some((s) => /^select(:not\([^)]*\))* option$/.test(s)))
  assert.ok(opt, 'нет правила select option')
  assert.match(opt.body, /(^|[\s;])background-color:/)
  assert.match(opt.body, /(^|[\s;])color:/)
})

test('у select нет прозрачного фона — попап на Windows станет белым', () => {
  const bad = rules().filter(
    (r) => selectors(r).some((s) => /(^|[\s>+~])select(\.[\w-]+)*$/.test(s)) && /background:\s*transparent/.test(r.body)
  )
  assert.deepEqual(bad.map((r) => r.selector), [])
})
