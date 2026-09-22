import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alsoIn, buildTree, chainLabel, dirAncestors, excerpt, findAll, highlight, longTime, matchPath, plural,
  readingMinutes, shortTime, type TreeNode
} from './docTree'
import type { DocFile, DocGroup } from '../../shared/ipc'

const file = (path: string, mtime = 0): DocFile => ({ path, size: 1, mtime, untracked: false })

/** Дерево в виде строк «отступ + имя (кол-во)» — удобно сравнивать целиком. */
function show(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) =>
    n.kind === 'dir'
      ? [`${'  '.repeat(depth)}${n.name}/ (${n.count}) [${n.path}]`, ...show(n.children, depth + 1)]
      : [`${'  '.repeat(depth)}${n.name}`]
  )
}

test('buildTree — папки сверху, файлы по имени, счётчики поддерева', () => {
  const tree = buildTree([
    file('README.md'),
    file('docs/b.md'),
    file('docs/a.md'),
    file('docs/inv/x.md'),
    file('CHANGELOG.md')
  ])
  assert.deepEqual(show(tree), [
    'docs/ (3) [docs]',
    '  inv/ (1) [docs/inv]',
    '    x.md',
    '  a.md',
    '  b.md',
    'CHANGELOG.md',
    'README.md'
  ])
})

test('buildTree — цепочка из одной папки схлопывается, пока в ней нет файлов', () => {
  const tree = buildTree([file('apps/desktop/src/renderer/logos/README.md'), file('apps/desktop/NOTES.md'), file('skills/w.md')])
  assert.deepEqual(show(tree), [
    'apps/desktop/ (2) [apps/desktop]',
    '  src/renderer/logos/ (1) [apps/desktop/src/renderer/logos]',
    '    README.md',
    '  NOTES.md',
    'skills/ (1) [skills]',
    '  w.md'
  ])
})

test('buildTree — числа в именах сортируются по-человечески', () => {
  const names = buildTree([file('10.md'), file('2.md'), file('1.md')]).map((n) => n.name)
  assert.deepEqual(names, ['1.md', '2.md', '10.md'])
})

test('dirAncestors и chainLabel', () => {
  assert.deepEqual(dirAncestors('a/b/c.md'), ['a', 'a/b'])
  assert.deepEqual(dirAncestors('c.md'), [])
  assert.equal(chainLabel('apps/desktop/src/renderer/logos'), 'apps/desktop/…/logos')
  assert.equal(chainLabel('a/b/c'), 'a/b/c')
})

test('matchPath — подстрока в имени файла важнее, чем в пути', () => {
  const inName = matchPath('docs/nested-kanban.md', 'kanban')
  const inPath = matchPath('kanban/notes.md', 'kanban')
  assert.deepEqual(inName?.ranges, [[12, 18]])
  assert.ok(inName && inPath && inName.score > inPath.score)
  assert.equal(matchPath('docs/a.md', 'kanban'), null)
})

test('matchPath — без учёта регистра, слова через пробел нужны все', () => {
  assert.deepEqual(matchPath('Docs/README.md', 'docs read')?.ranges, [[0, 4], [5, 9]])
  assert.equal(matchPath('docs/README.md', 'docs zzz'), null)
  assert.equal(matchPath('docs/README.md', '  '), null)
})

test('matchPath — буквы вразбивку (fuzzy), подстрока лучше', () => {
  const fuzzy = matchPath('docs/nested-kanban.md', 'nkb')
  assert.ok(fuzzy)
  assert.deepEqual(fuzzy.ranges, [[5, 6], [12, 13], [15, 16]])
  const exact = matchPath('docs/nkb.md', 'nkb')
  assert.ok(exact && exact.score > fuzzy.score)
  assert.equal(matchPath('docs/a.md', 'zq'), null)
})

test('matchPath — соседние совпадения склеиваются', () => {
  assert.deepEqual(matchPath('abc.md', 'ab bc')?.ranges, [[0, 3]])
})

test('highlight — отрезки с подсветкой, со смещением для имени файла', () => {
  assert.deepEqual(highlight('nested-kanban.md', [[12, 18]], 5), [
    { text: 'nested-', hit: false },
    { text: 'kanban', hit: true },
    { text: '.md', hit: false }
  ])
  assert.deepEqual(highlight('docs/', [[12, 18]]), [{ text: 'docs/', hit: false }])
  assert.deepEqual(highlight('abc', [[0, 3]]), [{ text: 'abc', hit: true }])
})

test('findAll — все вхождения без учёта регистра', () => {
  assert.deepEqual(findAll('Kanban и kanban-колонки', 'KANBAN'), [0, 9])
  assert.deepEqual(findAll('aaaa', 'aa'), [0, 2])
  assert.deepEqual(findAll('abc', ''), [])
})

test('shortTime / longTime — сегодня, вчера, дата', () => {
  const now = new Date(2026, 8, 22, 15, 0).getTime()
  assert.equal(shortTime(new Date(2026, 8, 22, 14, 32).getTime(), now), '14:32')
  assert.equal(shortTime(new Date(2026, 8, 21, 23, 59).getTime(), now), 'вчера')
  assert.equal(shortTime(new Date(2026, 8, 18, 9, 0).getTime(), now), '18.09')
  assert.equal(shortTime(new Date(2025, 11, 31, 9, 0).getTime(), now), '31.12.25')
  assert.equal(longTime(new Date(2026, 8, 22, 9, 5).getTime(), now), 'сегодня в 09:05')
  assert.equal(longTime(new Date(2026, 8, 21, 19, 5).getTime(), now), 'вчера в 19:05')
  assert.equal(longTime(new Date(2026, 8, 18, 10, 0).getTime(), now), '18.09 в 10:00')
})

test('plural', () => {
  assert.equal(plural(1, ['файл', 'файла', 'файлов']), '1 файл')
  assert.equal(plural(3, ['файл', 'файла', 'файлов']), '3 файла')
  assert.equal(plural(11, ['файл', 'файла', 'файлов']), '11 файлов')
  assert.equal(plural(22, ['файл', 'файла', 'файлов']), '22 файла')
  assert.equal(plural(0, ['файл', 'файла', 'файлов']), '0 файлов')
})

test('readingMinutes — ≈200 слов в минуту, минимум 1', () => {
  assert.equal(readingMinutes(''), 1)
  assert.equal(readingMinutes('слово '.repeat(1000)), 5)
  assert.equal(readingMinutes('# --- ' + 'x '.repeat(400)), 2)
})

test('excerpt — первый абзац без разметки', () => {
  const md = '---\ntitle: x\n---\n# Архитектура\n\n```\ncode\n```\n\nВсе агенты — **дочерние** процессы.\nСм. [схему](a.md) и `cli`.\n\nВторой абзац.'
  assert.equal(excerpt(md), 'Все агенты — дочерние процессы. См. схему и cli.')
  assert.equal(excerpt('# Только заголовок'), '')
  assert.equal(excerpt('x'.repeat(200), 10), 'xxxxxxxxx…')
  assert.equal(excerpt('- пункт один\n- пункт два'), 'пункт один пункт два')
})

test('alsoIn — тот же путь в других группах', () => {
  const groups: DocGroup[] = [
    { source: 'project', title: 'Проект', files: [file('docs/a.md'), file('b.md')] },
    { source: 't1', title: 'Задача 1', files: [file('docs/a.md')] },
    { source: 't2', title: 'Задача 2', files: [file('c.md')] }
  ]
  assert.deepEqual(alsoIn(groups, 'project', 'docs/a.md').map((g) => g.source), ['t1'])
  assert.deepEqual(alsoIn(groups, 't1', 'docs/a.md').map((g) => g.source), ['project'])
  assert.deepEqual(alsoIn(groups, 'project', 'b.md'), [])
})
