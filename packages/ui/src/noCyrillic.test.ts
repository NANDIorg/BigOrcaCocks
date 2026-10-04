// Страж перевода: в коде renderer не должно быть русского текста интерфейса мимо словарей. Сканируются строковые
// литералы, шаблонные строки и JSX-текст всех .ts/.tsx renderer, кроме словарей (`i18n/`), тестов и .d.ts;
// комментарии и регулярные выражения не смотрятся. Новая русская строка — ключ в `i18n/ru` и `i18n/en` и `t()`.
// Оправданные исключения — в ALLOWED с причиной.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = import.meta.dirname
const CYRILLIC = /[А-Яа-яЁё]/

/** `файл: текст` → почему можно. */
const ALLOWED: Record<string, string> = {
  // Горячие клавиши Инбокса в русской раскладке (j/k/a/c/r на тех же клавишах) — это не текст интерфейса.
  'InboxPanel.tsx: о': 'клавиша раскладки',
  'InboxPanel.tsx: л': 'клавиша раскладки',
  'InboxPanel.tsx: ф': 'клавиша раскладки',
  'InboxPanel.tsx: с': 'клавиша раскладки',
  'InboxPanel.tsx: к': 'клавиша раскладки'
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'i18n') sources(path, out)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

/** Русские строки исходника: номер строки и текст литерала. */
function cyrillicStrings(file: string, source: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: { line: number; text: string }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateLiteralToken(node)) {
      const text = node.text.trim()
      if (CYRILLIC.test(text)) found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

test('в renderer нет русского текста мимо словарей i18n', () => {
  const bad: string[] = []
  for (const file of sources(ROOT)) {
    const rel = relative(ROOT, file)
    for (const { line, text } of cyrillicStrings(file, readFileSync(file, 'utf8'))) {
      if (!ALLOWED[`${rel}: ${text}`]) bad.push(`${rel}:${line}: ${text.slice(0, 80)}`)
    }
  }
  assert.deepEqual(bad, [], `русские строки вне i18n/ — вынесите в словари:\n${bad.join('\n')}`)
})

test('сканер видит строки, шаблоны и JSX-текст, но не комментарии и регэкспы', () => {
  const src = [
    "const a = 'строка'",
    'const b = `шаблон ${a} хвост`',
    'const c = <b>текст</b>',
    '// комментарий',
    'const d = /регэксп/',
    "const e = 'latin'"
  ].join('\n')
  const texts = cyrillicStrings('x.tsx', src).map((f) => f.text)
  assert.deepEqual(texts, ['строка', 'шаблон', 'хвост', 'текст'])
})
