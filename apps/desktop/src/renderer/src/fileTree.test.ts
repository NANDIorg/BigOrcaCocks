// Дерево вкладки «Файлы»: пути, применение ответов и гонки, видимые строки, клавиатура, восстановление раскрытых.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProjectFileEntry, ProjectFilesListing } from '../../shared/ipc'
import {
  LOAD_CONCURRENCY,
  OPEN_LIMIT,
  absolutePath,
  applyError,
  applyListing,
  depthOf,
  fileIconKind,
  focusRefreshDue,
  initialTree,
  isBusy,
  joinPath,
  markLoading,
  navigate,
  parentPath,
  pendingLoads,
  readOpen,
  refreshAll,
  restoreOrder,
  retryDir,
  toggleDir,
  visibleRows,
  writeOpen,
  type FileTreeState,
  type TreeRow
} from './fileTree'

const P = 'p1'
const dir = (name: string): ProjectFileEntry => ({ name, kind: 'dir' })
const file = (name: string): ProjectFileEntry => ({ name, kind: 'file' })
const listing = (d: string, entries: ProjectFileEntry[], truncated = false): ProjectFilesListing => ({ dir: d, entries, truncated })

let seq = 0
/** Отправить все ожидающие запросы и сразу ответить на них из «диска» `fs`. */
function settle(s: FileTreeState, fs: Record<string, ProjectFileEntry[]>): FileTreeState {
  for (let guard = 0; guard < 50; guard++) {
    const loads = pendingLoads(s).map((path) => ({ path, req: ++seq }))
    if (loads.length === 0) return s
    s = markLoading(s, loads)
    for (const { path, req } of loads) {
      s = fs[path] ? applyListing(s, P, path, req, listing(path, fs[path]!)) : applyError(s, P, path, req, { code: 'files.notFound', message: 'нет' })
    }
  }
  throw new Error('дерево не успокоилось')
}

/** Видимые строки как текст: «отступ + имя», раскрытая папка — «▾», свёрнутая — «▸». */
function show(rows: TreeRow[]): string[] {
  return rows.map((r) => {
    const pad = '  '.repeat(r.depth)
    if (r.type === 'entry') return `${pad}${r.kind === 'dir' ? (r.open ? '▾ ' : '▸ ') : ''}${r.name}`
    if (r.type === 'truncated') return `${pad}[truncated ${r.count}]`
    return `${pad}[${r.type}]`
  })
}

const FS: Record<string, ProjectFileEntry[]> = {
  '': [dir('apps'), dir('docs'), { name: 'current', kind: 'symlink' }, file('README.md')],
  apps: [dir('desktop'), file('x.ts')],
  'apps/desktop': [file('package.json')],
  docs: []
}

test('joinPath / parentPath / depthOf', () => {
  assert.equal(joinPath('', 'a'), 'a')
  assert.equal(joinPath('a/b', 'c'), 'a/b/c')
  assert.equal(parentPath('a'), '')
  assert.equal(parentPath('a/b/c'), 'a/b')
  assert.equal(depthOf(''), 0)
  assert.equal(depthOf('a'), 1)
  assert.equal(depthOf('a/b'), 2)
})

test('absolutePath — разделитель как у корня', () => {
  assert.equal(absolutePath('/repo', 'a/b'), '/repo/a/b')
  assert.equal(absolutePath('/repo/', 'a'), '/repo/a')
  assert.equal(absolutePath('C:\\repo', 'a/b'), 'C:\\repo\\a\\b')
  assert.equal(absolutePath('/repo', ''), '/repo')
})

test('первая загрузка: корень раскрыт, остальные папки свёрнуты', () => {
  let s = initialTree(P)
  assert.deepEqual(pendingLoads(s), [''])
  assert.deepEqual(show(visibleRows(s)), ['[loading]'])
  s = settle(s, FS)
  assert.deepEqual(show(visibleRows(s)), ['▸ apps', '▸ docs', 'current', 'README.md'])
})

test('раскрытие: загрузка под строкой, повторно берётся из состояния; пустая папка — строка «пусто»', () => {
  let s = settle(initialTree(P), FS)
  s = toggleDir(s, 'apps')
  assert.deepEqual(pendingLoads(s), ['apps'])
  assert.deepEqual(show(visibleRows(s)), ['▾ apps', '  [loading]', '▸ docs', 'current', 'README.md'])
  s = settle(s, FS)
  s = settle(toggleDir(s, 'docs'), FS)
  assert.deepEqual(show(visibleRows(s)), ['▾ apps', '  ▸ desktop', '  x.ts', '▾ docs', '  [empty]', 'current', 'README.md'])
  s = toggleDir(toggleDir(s, 'apps'), 'apps')
  assert.deepEqual(pendingLoads(s), [], 'свернули и раскрыли — без нового запроса')
})

test('applyListing — ответ другого проекта, другой папки или устаревшего запроса игнорируется', () => {
  let s = markLoading(initialTree(P), [{ path: '', req: 7 }])
  assert.equal(applyListing(s, 'p2', '', 7, listing('', [file('a')])), s, 'другой проект')
  assert.equal(applyListing(s, P, '', 7, listing('apps', [file('a')])), s, 'эхо другой папки')
  assert.equal(applyListing(s, P, '', 6, listing('', [file('a')])), s, 'устаревший номер запроса')
  assert.equal(applyError(s, P, '', 6, { message: 'x' }), s)
  s = applyListing(s, P, '', 7, listing('', [file('a')]))
  assert.deepEqual(show(visibleRows(s)), ['a'])
  assert.equal(applyListing(s, P, '', 7, listing('', [])), s, 'повторный ответ на тот же запрос')
})

test('applyListing — обрезанная папка показывает строку «показаны первые N»', () => {
  let s = markLoading(initialTree(P), [{ path: '', req: 1 }])
  s = applyListing(s, P, '', 1, listing('', [file('a'), file('b')], true))
  assert.deepEqual(show(visibleRows(s)), ['a', 'b', '[truncated 2]'])
})

test('applyError — строка ошибки; «Повторить» отправляет запрос заново', () => {
  let s = markLoading(initialTree(P), [{ path: '', req: 1 }])
  s = applyError(s, P, '', 1, { code: 'files.readFailed', message: 'нет доступа' })
  assert.deepEqual(show(visibleRows(s)), ['[error]'])
  assert.deepEqual(pendingLoads(s), [], 'после ошибки сами не повторяем')
  s = retryDir(s, '')
  assert.deepEqual(pendingLoads(s), [''])
})

test('files.notFound у вложенной папки — родитель перечитывается, пропавшая папка выпадает', () => {
  let s = settle(toggleDir(settle(initialTree(P), FS), 'apps'), FS)
  s = settle(toggleDir(s, 'apps/desktop'), FS)
  s = { ...s, selected: 'apps/desktop/package.json' }
  const gone: Record<string, ProjectFileEntry[]> = { ...FS, apps: [file('x.ts')] }
  delete gone['apps/desktop']
  s = refreshAll(s)
  // Сначала ответил только desktop: его уже нет.
  s = markLoading(s, [{ path: 'apps/desktop', req: 100 }])
  s = applyError(s, P, 'apps/desktop', 100, { code: 'files.notFound', message: 'нет' })
  assert.equal(s.dirs.apps!.stale, true)
  s = settle(s, gone)
  assert.deepEqual(show(visibleRows(s)), ['▾ apps', '  x.ts', '▸ docs', 'current', 'README.md'])
  assert.equal(s.open.has('apps/desktop'), false)
  assert.equal(s.selected, null, 'выделенный внутри пропавшей папки сброшен')
})

test('refreshAll — перечитывает раскрытые, сохраняет выделение; второй клик не даёт второй загрузки', () => {
  let s = settle(toggleDir(settle(initialTree(P), FS), 'apps'), FS)
  s = { ...s, selected: 'apps/x.ts' }
  s = refreshAll(s)
  const first = pendingLoads(s)
  assert.deepEqual(first, ['', 'apps'])
  s = markLoading(s, first.map((path, i) => ({ path, req: 200 + i })))
  assert.equal(refreshAll(s), s, 'всё в полёте — второй «Обновить» ничего не меняет')
  assert.deepEqual(pendingLoads(s), [])
  assert.ok(isBusy(s))
  assert.deepEqual(show(visibleRows(s)).slice(0, 3), ['▾ apps', '  ▸ desktop', '  x.ts'], 'пока идёт обновление, старое содержимое на месте')
  s = applyListing(s, P, '', 200, listing('', FS['']!))
  s = applyListing(s, P, 'apps', 201, listing('apps', FS.apps!))
  assert.equal(s.selected, 'apps/x.ts')
  assert.equal(isBusy(s), false)
})

test('refreshAll — выделенная пропавшая запись сбрасывается', () => {
  let s: FileTreeState = { ...settle(initialTree(P), FS), selected: 'README.md' }
  s = settle(refreshAll(s), { ...FS, '': [dir('apps')] })
  assert.equal(s.selected, null)
})

test('pendingLoads — не больше LOAD_CONCURRENCY одновременно', () => {
  const many: Record<string, ProjectFileEntry[]> = { '': Array.from({ length: 10 }, (_, i) => dir(`d${i}`)) }
  let s = settle(initialTree(P), many)
  for (let i = 0; i < 10; i++) s = toggleDir(s, `d${i}`)
  const first = pendingLoads(s)
  assert.equal(first.length, LOAD_CONCURRENCY)
  s = markLoading(s, first.map((path, i) => ({ path, req: 300 + i })))
  assert.deepEqual(pendingLoads(s), [])
  s = applyListing(s, P, first[0]!, 300, listing(first[0]!, []))
  assert.equal(pendingLoads(s).length, 1)
})

test('восстановление раскрытых: по глубине, родители раньше детей; пропавшие молча выпадают', () => {
  let s = initialTree(P, restoreOrder(['apps/desktop', 'gone/deep', 'apps', 'gone']))
  assert.deepEqual(pendingLoads(s), [''], 'дети ждут, пока прочитан родитель')
  s = markLoading(s, [{ path: '', req: 1 }])
  s = applyListing(s, P, '', 1, listing('', FS['']!))
  assert.deepEqual(pendingLoads(s), ['apps'])
  assert.deepEqual([...s.open].sort(), ['apps', 'apps/desktop'], 'gone и всё внутри выпали')
  s = settle(s, FS)
  assert.deepEqual(show(visibleRows(s)).slice(0, 4), ['▾ apps', '  ▾ desktop', '    package.json', '  x.ts'])
})

test('restoreOrder — по глубине, без дублей и мусора, лимит OPEN_LIMIT', () => {
  assert.deepEqual(restoreOrder(['a/b/c', 'b', 'a/b', 'a', 'a', '', 5, null, '/abs', 'x/']), ['a', 'b', 'a/b', 'a/b/c'])
  const many = Array.from({ length: OPEN_LIMIT + 50 }, (_, i) => `d${String(i).padStart(3, '0')}/sub`)
  const cut = restoreOrder([...many, 'top'])
  assert.equal(cut.length, OPEN_LIMIT)
  assert.equal(cut[0], 'top', 'мелкие папки сохраняются первыми')
})

test('readOpen / writeOpen — битые данные и недоступный localStorage не ломают вкладку', () => {
  const mem = new Map<string, string>()
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  writeOpen(storage, P, new Set(['a/b', 'a']))
  assert.deepEqual(readOpen(storage, P), ['a', 'a/b'])
  assert.deepEqual(readOpen(storage, 'other'), [])
  mem.set('orca.files.open.p1', '{bad json')
  assert.deepEqual(readOpen(storage, P), [])
  mem.set('orca.files.open.p1', '{"a":1}')
  assert.deepEqual(readOpen(storage, P), [])
  const broken = { getItem: (): string => { throw new Error('denied') }, setItem: (): void => { throw new Error('quota') } }
  assert.deepEqual(readOpen(broken, P), [])
  assert.doesNotThrow(() => writeOpen(broken, P, ['a']))
  assert.deepEqual(readOpen(undefined, P), [])
})

test('navigate — ↑↓, Home/End по видимым строкам', () => {
  let s = settle(toggleDir(settle(initialTree(P), FS), 'apps'), FS)
  s = navigate(s, 'ArrowDown')
  assert.equal(s.selected, 'apps', 'ничего не выделено — первая запись')
  s = navigate(s, 'ArrowDown')
  assert.equal(s.selected, 'apps/desktop')
  s = navigate(navigate(s, 'ArrowDown'), 'ArrowDown')
  assert.equal(s.selected, 'docs')
  s = navigate(s, 'End')
  assert.equal(s.selected, 'README.md')
  assert.equal(navigate(s, 'ArrowDown'), s, 'у нижнего края остаёмся на месте')
  s = navigate(s, 'Home')
  assert.equal(s.selected, 'apps')
  assert.equal(navigate(s, 'ArrowUp'), s)
})

test('navigate — → раскрывает или шагает внутрь, ← сворачивает или шагает к родителю', () => {
  let s: FileTreeState = { ...settle(initialTree(P), FS), selected: 'apps' }
  s = navigate(s, 'ArrowRight')
  assert.equal(s.open.has('apps'), true, 'свёрнутая папка раскрылась')
  assert.equal(s.selected, 'apps')
  assert.equal(navigate(s, 'ArrowRight'), s, 'содержимое ещё не прочитано — шагать некуда')
  s = settle(s, FS)
  s = navigate(s, 'ArrowRight')
  assert.equal(s.selected, 'apps/desktop', 'раскрытая — шаг к первой записи')
  s = navigate(s, 'ArrowLeft')
  assert.equal(s.selected, 'apps', 'свёрнутая — к родителю')
  s = navigate(s, 'ArrowLeft')
  assert.equal(s.open.has('apps'), false, 'раскрытая — свернулась')
  assert.equal(navigate(s, 'ArrowLeft'), s, 'запись корня: родителя в дереве нет')
  s = { ...s, selected: 'README.md' }
  assert.equal(navigate(s, 'ArrowRight'), s, 'файл не раскрывается')
})

test('navigate — пустое дерево не меняет состояние', () => {
  const s = initialTree(P)
  assert.equal(navigate(s, 'ArrowDown'), s)
})

test('toggleDir — корень не сворачивается', () => {
  const s = initialTree(P)
  assert.equal(toggleDir(s, ''), s)
})

test('focusRefreshDue — не чаще раза в 5 секунд', () => {
  assert.equal(focusRefreshDue(1000, 5999), false)
  assert.equal(focusRefreshDue(1000, 6000), true)
})

test('fileIconKind', () => {
  assert.equal(fileIconKind('src', 'dir'), 'folder')
  assert.equal(fileIconKind('current', 'symlink'), 'link')
  assert.equal(fileIconKind('README.md', 'file'), 'doc')
  assert.equal(fileIconKind('notes.TXT', 'file'), 'doc')
  assert.equal(fileIconKind('logo.PNG', 'file'), 'image')
  assert.equal(fileIconKind('a.svg', 'file'), 'image')
  assert.equal(fileIconKind('logo.png', 'symlink'), 'link', 'симлинк важнее расширения')
  assert.equal(fileIconKind('index.ts', 'file'), 'file')
  assert.equal(fileIconKind('Makefile', 'file'), 'file')
})
