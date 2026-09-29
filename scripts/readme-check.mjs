// Проверки README.md против репозитория: ссылки, картинки, якоря и версии инструментов.
// Только чистые функции: корень репозитория и имя файла передаёт вызывающий код
// (тест берёт настоящий README и временные фикстуры), поэтому модуль ничего не запускает сам.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'

/**
 * CRLF → LF. На Windows git выгружает файлы с CRLF: после `split('\n')` в конце строки остаётся `\r`, регулярка
 * заголовка его не пропускает — ни один заголовок не находился, и все якоря считались битыми (CI на windows-latest).
 */
function toLf(text) {
  return text.replace(/\r\n?/g, '\n')
}

/** Убирает то, что не является разметкой ссылок: HTML-комментарии, fenced-блоки и инлайн-код. */
export function stripCode(markdown) {
  return stripFences(toLf(markdown).replace(/<!--[\s\S]*?-->/g, '')).replace(/`[^`\n]*`/g, '')
}

/** Строки вне fenced-блоков (``` и ~~~): `# комментарий` в bash-примере — не заголовок, `[x](y)` в примере — не ссылка. */
function stripFences(text) {
  const kept = []
  let fence = null
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null
    } else if (marker) {
      fence = marker
    } else {
      kept.push(line)
    }
  }
  return kept.join('\n')
}

/**
 * Все адреса, на которые ссылается markdown: `[..](url)`, `![..](url)`, `[x]: url`,
 * а также `href`, `src`, `poster` и каждый кандидат `srcset` в HTML (`<a>`, `<img>`, `<source>`).
 * Порядок — по первому появлению, без повторов.
 */
export function collectReferences(markdown) {
  const text = stripCode(markdown)
  const found = []
  for (const [, target] of text.matchAll(/\]\(\s*(<[^>\n]+>|[^)\s]+)/g)) found.push(target.replace(/^<|>$/g, ''))
  for (const [, target] of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)) found.push(target.replace(/^<|>$/g, ''))
  for (const [tag] of text.matchAll(/<(?:a|img|source|video|audio|link)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi)) {
    for (const [, name, double, single] of tag.matchAll(/\b(src|href|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const value = double ?? single
      if (name.toLowerCase() === 'srcset') {
        // «url 1x, url2 2x»: у каждого кандидата адрес — первое слово.
        for (const candidate of value.split(',')) found.push(candidate.trim().split(/\s+/)[0])
      } else {
        found.push(value.trim())
      }
    }
  }
  return [...new Set(found.filter(Boolean))]
}

/** Якорь заголовка так, как его строит GitHub: нижний регистр, без пунктуации, каждый пробел — дефис (не схлопываются). */
export function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
}

/** Видимый текст заголовка без markdown-разметки: `код`, ссылки, картинки, выделение, HTML-теги. */
function headingText(source) {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|~~|\*/g, '')
}

/**
 * Якоря документа: ATX-заголовки (повтор получает суффикс `-1`, `-2` — как у GitHub) и явные `id`/`name` в HTML.
 * Заголовки в стиле setext (подчёркивание `===`) не учитываются: в документах проекта их нет,
 * а `---` после абзаца легко принять за заголовок.
 */
export function documentAnchors(markdown) {
  const anchors = new Set()
  const counts = new Map()
  const visible = stripFences(toLf(markdown).replace(/<!--[\s\S]*?-->/g, ''))
  for (const line of visible.split('\n')) {
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (!heading) continue
    const base = slugify(headingText(heading[1]))
    let slug = base
    while (counts.has(slug)) {
      counts.set(base, counts.get(base) + 1)
      slug = `${base}-${counts.get(base)}`
    }
    counts.set(slug, 0)
    anchors.add(slug)
  }
  for (const [, id] of visible.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(id)
  return anchors
}

/** Что лежит по пути (от корня репозитория): `'file'`, `'dir'` или `null`. Регистр — точный, как на Linux в CI, а не как на macOS. */
function entryKind(root, relative) {
  let current = root
  let kind = 'dir'
  for (const segment of relative.split('/').filter((s) => s && s !== '.')) {
    if (kind !== 'dir') return null
    let names
    try {
      names = readdirSync(current)
    } catch {
      return null
    }
    if (!names.includes(segment)) return null
    current = join(current, segment)
    kind = statSync(current).isDirectory() ? 'dir' : 'file'
  }
  return kind
}

const decode = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Относительные ссылки и картинки файла: указывают на существующее (внешние `https:`, `mailto:` и т. п. не проверяются),
 * а якорь `#…` — на заголовок этого или целевого markdown-файла.
 * Возвращает `{ files, anchors }` — списки понятных сообщений об ошибках.
 */
export function checkReferences(root, file = 'README.md') {
  const files = []
  const anchors = []
  const markdown = readFileSync(join(root, file), 'utf8')
  const cache = new Map()
  const anchorsOf = (path) => {
    if (!cache.has(path)) cache.set(path, documentAnchors(readFileSync(join(root, path), 'utf8')))
    return cache.get(path)
  }
  for (const reference of collectReferences(markdown)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) continue
    const hash = reference.indexOf('#')
    const address = hash === -1 ? reference : reference.slice(0, hash)
    const fragment = hash === -1 ? '' : decode(reference.slice(hash + 1))
    const pathPart = decode(address.replace(/\?.*$/, ''))

    let target = file
    if (pathPart) {
      // Ссылка с «/» в начале на GitHub считается от корня репозитория.
      target = pathPart.startsWith('/') ? posix.normalize(pathPart.slice(1)) : posix.normalize(posix.join(dirname(file), pathPart))
      if (target === '..' || target.startsWith('../')) {
        files.push(`${file}: «${reference}» выходит за пределы репозитория`)
        continue
      }
      const kind = entryKind(root, target)
      if (!kind) {
        files.push(`${file}: «${reference}» — файла или папки «${target}» нет (регистр важен)`)
        continue
      }
      if (address.endsWith('/') && kind !== 'dir') {
        files.push(`${file}: «${reference}» оканчивается на «/», но «${target}» — файл`)
        continue
      }
    }
    if (fragment && target.endsWith('.md') && entryKind(root, target) === 'file' && !anchorsOf(target).has(fragment)) {
      anchors.push(`${file}: якоря «#${fragment}» нет среди заголовков ${target} («${reference}»)`)
    }
  }
  return { files, anchors }
}

/** Совместимы ли версии: сравниваются только общие части, `x` и `*` — любая («24» и «24.x» и «24.15.0» совместимы). */
function compatible(mentioned, actual) {
  const a = mentioned.split('.')
  const b = actual.split('.')
  return a.slice(0, b.length).every((part, i) => part === b[i] || part === 'x' || b[i] === 'x' || part === '*' || b[i] === '*')
}

const versionOf = (text) => /\d+(?:\.(?:\d+|x))*/.exec(text)?.[0]
const readOptional = (root, path) => {
  try {
    return readFileSync(join(root, path), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Версии Node и pnpm, упомянутые в README, не противоречат `.nvmrc`, `engines.node` и `packageManager` корневого package.json.
 * Не упомянуты — не проверяются. Возвращает список ошибок.
 */
export function checkVersions(root, file = 'README.md') {
  const problems = []
  const markdown = readFileSync(join(root, file), 'utf8')
  const manifest = JSON.parse(readOptional(root, 'package.json') ?? '{}')
  const nodeSources = [
    ['.nvmrc', versionOf(readOptional(root, '.nvmrc') ?? '')],
    ['engines.node в package.json', versionOf(manifest.engines?.node ?? '')]
  ].filter(([, version]) => version)
  const pnpmSources = [['packageManager в package.json', /^pnpm@(\d+(?:\.\d+)*)/.exec(manifest.packageManager ?? '')?.[1]]].filter(([, version]) => version)

  const mentions = [
    ['Node', /\bnode(?:\.js)?(?:@|\s+)(?:[v≥>=~^]+\s*)?(\d+(?:\.(?:\d+|x))*)/gi, nodeSources],
    ['pnpm', /\bpnpm(?:@|\s+)v?(\d+(?:\.\d+)*)/gi, pnpmSources]
  ]
  for (const [tool, pattern, sources] of mentions) {
    for (const [, version] of markdown.matchAll(pattern)) {
      if (sources.length === 0) problems.push(`${file}: указан ${tool} ${version}, но в репозитории нет версии ${tool}, с которой её сверить`)
      for (const [name, actual] of sources) {
        if (!compatible(version, actual)) problems.push(`${file}: ${tool} ${version} не совпадает с ${name} (${actual})`)
      }
    }
  }
  return problems
}
