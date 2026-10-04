import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  absolutePath, alsoIn, buildTree, isTreeKey, navigate, treeRows, chainLabel, dayTime, dirAncestors, excerpt, findAll, focusRefreshDue, highlight, longTime,
  markdownFiles, matchPath, OPEN_DIRS_LIMIT, openDirsOrder, readingMinutes, readOpenDirs, recentFiles, searchFiles, shortTime,
  writeOpenDirs, type TreeNode, type TreeRow
} from './docTree'
import { setLocale, translate } from './i18n'
import type { DocFile, DocGroup } from '../shared/ipc'

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

afterEach(() => setLocale('ru'))

test('shortTime / longTime / dayTime — по-английски', () => {
  setLocale('en')
  const now = new Date(2026, 8, 22, 15, 0).getTime()
  assert.equal(shortTime(new Date(2026, 8, 21, 23, 59).getTime(), now), 'yesterday')
  assert.equal(shortTime(new Date(2026, 8, 18, 9, 0).getTime(), now), '09/18')
  assert.equal(longTime(new Date(2026, 8, 22, 9, 5).getTime(), now), 'today at 09:05 AM')
  assert.equal(dayTime(new Date(2026, 8, 18, 10, 0).getTime(), now), '09/18 10:00 AM')
})

test('dayTime — без предлога', () => {
  const now = new Date(2026, 8, 22, 15, 0).getTime()
  assert.equal(dayTime(new Date(2026, 8, 21, 19, 5).getTime(), now), 'вчера 19:05')
})

test('число файлов в проекте — формы по языку', () => {
  const files = (locale: 'ru' | 'en', count: number): string => translate(locale, 'config.docs.start.files', { count })
  assert.equal(files('ru', 1), '1 файл в проекте')
  assert.equal(files('ru', 3), '3 файла в проекте')
  assert.equal(files('ru', 11), '11 файлов в проекте')
  assert.equal(files('ru', 22), '22 файла в проекте')
  assert.equal(files('en', 1), '1 file in the project')
  assert.equal(files('en', 5), '5 files in the project')
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

test('recentFiles — свежие сверху, не больше лимита, исходный список не меняется', () => {
  const files = [file('a.ts', 1), file('b.md', 3), file('c.json', 2)]
  assert.deepEqual(recentFiles(files).map((f) => f.path), ['b.md', 'c.json', 'a.ts'])
  assert.deepEqual(recentFiles(files, 2).map((f) => f.path), ['b.md', 'c.json'])
  assert.deepEqual(files.map((f) => f.path), ['a.ts', 'b.md', 'c.json'])
})

test('searchFiles — лучшие совпадения сверху, лимит выдачи и общее число для «ещё N»', () => {
  const files = [file('src/app.ts', 1), file('docs/app-notes.md', 5), file('app.ts', 2), file('README.md', 9)]
  const all = searchFiles(files, 'app')
  assert.equal(all.total, 3)
  assert.deepEqual(all.hits.map((h) => h.file.path), ['docs/app-notes.md', 'app.ts', 'src/app.ts'])
  const cut = searchFiles(files, 'app', 2)
  assert.equal(cut.total, 3)
  assert.equal(cut.hits.length, 2)
  assert.deepEqual(searchFiles(files, '   '), { hits: [], total: 0 })
})

test('markdownFiles — только .md и .markdown для стартового экрана', () => {
  const files = [file('README.md'), file('a.ts'), file('docs/x.MARKDOWN'), file('.env'), file('page.html')]
  assert.deepEqual(markdownFiles(files).map((f) => f.path), ['README.md', 'docs/x.MARKDOWN'])
})

test('absolutePath — разделитель как у корня', () => {
  assert.equal(absolutePath('/repo', 'a/b'), '/repo/a/b')
  assert.equal(absolutePath('/repo/', 'a'), '/repo/a')
  assert.equal(absolutePath('C:\\repo', 'a/b'), 'C:\\repo\\a\\b')
  assert.equal(absolutePath('/repo', ''), '/repo')
})

test('focusRefreshDue — не чаще раза в 5 секунд', () => {
  assert.equal(focusRefreshDue(1000, 5999), false)
  assert.equal(focusRefreshDue(1000, 6000), true)
})

test('openDirsOrder — по глубине, без дублей и мусора, лимит OPEN_DIRS_LIMIT', () => {
  assert.deepEqual(openDirsOrder(['a/b/c', 'b', 'a/b', 'a', 'a', '', 5, null, '/abs', 'x/']), ['a', 'b', 'a/b', 'a/b/c'])
  const many = Array.from({ length: OPEN_DIRS_LIMIT + 50 }, (_, i) => `d${String(i).padStart(3, '0')}/sub`)
  const cut = openDirsOrder([...many, 'top'])
  assert.equal(cut.length, OPEN_DIRS_LIMIT)
  assert.equal(cut[0], 'top', 'мелкие папки сохраняются первыми')
})

test('readOpenDirs / writeOpenDirs — per-project, битые данные и недоступный localStorage не ломают окно', () => {
  const mem = new Map<string, string>()
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  assert.equal(readOpenDirs(storage, 'p1'), null, 'не сохраняли — null: окно раскроет верхний уровень')
  writeOpenDirs(storage, 'p1', new Set(['a/b', 'a']))
  assert.deepEqual(readOpenDirs(storage, 'p1'), ['a', 'a/b'])
  assert.equal(mem.get('orca.docs.open.p1'), '["a","a/b"]')
  assert.equal(readOpenDirs(storage, 'other'), null)
  writeOpenDirs(storage, 'p1', [])
  assert.deepEqual(readOpenDirs(storage, 'p1'), [], 'всё свернули — пустой список, а не «не сохраняли»')
  mem.set('orca.docs.open.p1', '{bad json')
  assert.deepEqual(readOpenDirs(storage, 'p1'), [])
  mem.set('orca.docs.open.p1', '{"a":1}')
  assert.deepEqual(readOpenDirs(storage, 'p1'), [])
  const broken = { getItem: (): string => { throw new Error('denied') }, setItem: (): void => { throw new Error('quota') } }
  assert.deepEqual(readOpenDirs(broken, 'p1'), [])
  assert.doesNotThrow(() => writeOpenDirs(broken, 'p1', ['a']))
  assert.equal(readOpenDirs(undefined, 'p1'), null)
})

const keyOf = (n: TreeNode): string => (n.kind === 'dir' ? `d:${n.path}` : `f:${n.file.path}`)

test('treeRows — дети только у раскрытых папок, у каждой строки родитель', () => {
  const tree = buildTree([file('a/x.md'), file('a/b/y.md'), file('a/b/z.md'), file('c/w.md'), file('top.md')])
  const rows = treeRows(tree, new Set(['d:a', 'd:a/b']), keyOf)
  assert.deepEqual(rows, [
    { key: 'd:a', dir: true, open: true, parent: null },
    { key: 'd:a/b', dir: true, open: true, parent: 'd:a' },
    { key: 'f:a/b/y.md', dir: false, parent: 'd:a/b' },
    { key: 'f:a/b/z.md', dir: false, parent: 'd:a/b' },
    { key: 'f:a/x.md', dir: false, parent: 'd:a' },
    { key: 'd:c', dir: true, open: false, parent: null },
    { key: 'f:top.md', dir: false, parent: null }
  ])
})

test('navigate — ↑/↓, Home/End и фокус по умолчанию', () => {
  const rows: TreeRow[] = [
    { key: 'a', dir: true, open: true, parent: null },
    { key: 'a1', dir: false, parent: 'a' },
    { key: 'b', dir: false, parent: null }
  ]
  assert.deepEqual(navigate(rows, null, 'ArrowDown'), { focus: 'a' })
  assert.deepEqual(navigate(rows, 'пропал', 'ArrowUp'), { focus: 'a' })
  assert.deepEqual(navigate(rows, 'a', 'ArrowDown'), { focus: 'a1' })
  assert.deepEqual(navigate(rows, 'b', 'ArrowDown'), { focus: 'b' })
  assert.deepEqual(navigate(rows, 'a', 'ArrowUp'), { focus: 'a' })
  assert.deepEqual(navigate(rows, 'b', 'ArrowUp'), { focus: 'a1' })
  assert.deepEqual(navigate(rows, 'a1', 'Home'), { focus: 'a' })
  assert.deepEqual(navigate(rows, 'a', 'End'), { focus: 'b' })
  assert.deepEqual(navigate([], null, 'ArrowDown'), {})
})

test('navigate — → раскрывает или ведёт к первому ребёнку, ← сворачивает или ведёт к родителю', () => {
  const rows: TreeRow[] = [
    { key: 'a', dir: true, open: true, parent: null },
    { key: 'a1', dir: false, parent: 'a' },
    { key: 'c', dir: true, open: false, parent: null },
    { key: 'e', dir: true, open: true, parent: null },
    { key: 'f', dir: false, parent: null }
  ]
  assert.deepEqual(navigate(rows, 'c', 'ArrowRight'), { toggle: 'c' })
  assert.deepEqual(navigate(rows, 'a', 'ArrowRight'), { focus: 'a1' })
  // раскрытая пустая папка: дальше идти некуда
  assert.deepEqual(navigate(rows, 'e', 'ArrowRight'), {})
  assert.deepEqual(navigate(rows, 'a1', 'ArrowRight'), {})
  assert.deepEqual(navigate(rows, 'a', 'ArrowLeft'), { toggle: 'a' })
  assert.deepEqual(navigate(rows, 'a1', 'ArrowLeft'), { focus: 'a' })
  assert.deepEqual(navigate(rows, 'c', 'ArrowLeft'), {})
  assert.deepEqual(navigate(rows, 'f', 'ArrowLeft'), {})
})

test('isTreeKey — только клавиши перемещения', () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.equal(isTreeKey(k), true)
  for (const k of ['Enter', ' ', 'Tab', 'a', 'PageDown']) assert.equal(isTreeKey(k), false)
})
