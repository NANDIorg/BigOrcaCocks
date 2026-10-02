import type { DocViewKind } from './files.ts'

// Как «Документы» показывают файл проекта: вид по пути и лимиты чтения. Чистый модуль без node и electron:
// renderer по нему рисует иконки дерева (без IPC), а main (`docs:view`) — выбирает, читать ли текст. Таблицы —
// только про показ; что можно открыть приложением системы, решает белый список `SHOWCASE_FILE_TYPES`.

/**
 * Итог классификации по пути. `unknown` — по пути не понять (нет расширения, незнакомое): main решает по
 * содержимому (`DOC_SNIFF_BYTES`), renderer рисует общую иконку файла.
 */
export interface DocKind {
  kind: DocViewKind | 'unknown'
  /** MIME для `image`, `html`, `pdf`, `markdown`. */
  mime?: string
  /** Название языка для строки статуса («TypeScript», «JSON»): имя собственное, не переводится. */
  language?: string
}

/** Текст больше — заглушка `tooBig`: показ без виртуализации, подсветка renderer имеет отдельный меньший лимит. */
export const DOC_TEXT_MAX_BYTES = 1024 * 1024
/** Картинка больше — заглушка `tooBig` (= `SHOWCASE_READ_MAX_BYTES`). */
export const DOC_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** Больше файлов группа `project` в `docs:list` не отдаёт — `DocGroup.truncated`. */
export const DOCS_LIST_LIMIT = 100_000
/** Сколько первых байт main смотрит на NUL, чтобы отличить бинарь от текста. */
export const DOC_SNIFF_BYTES = 8192

const MARKDOWN = { kind: 'markdown', mime: 'text/markdown', language: 'Markdown' } as const
const HTML = { kind: 'html', mime: 'text/html', language: 'HTML' } as const
const PDF = { kind: 'pdf', mime: 'application/pdf' } as const
const BINARY = { kind: 'binary' } as const

const image = (mime: string): DocKind => ({ kind: 'image', mime })
const text = (language?: string): DocKind => (language ? { kind: 'text', language } : { kind: 'text' })

/**
 * Виды по расширению (нижний регистр, с точкой). Картинки — только те, что Chromium показывает в `<img>`; TIFF и HEIC
 * в нём не открываются, поэтому они среди бинарных.
 */
const BY_EXT: Readonly<Record<string, DocKind>> = {
  '.md': MARKDOWN,
  '.markdown': MARKDOWN,
  '.html': HTML,
  '.htm': HTML,
  '.pdf': PDF,
  '.png': image('image/png'),
  '.jpg': image('image/jpeg'),
  '.jpeg': image('image/jpeg'),
  '.webp': image('image/webp'),
  '.gif': image('image/gif'),
  '.avif': image('image/avif'),
  '.svg': { kind: 'image', mime: 'image/svg+xml', language: 'SVG' },
  '.ico': image('image/x-icon'),
  '.bmp': image('image/bmp'),

  // `.ts` — TypeScript, а не MPEG-TS: в репозиториях первое встречается несравнимо чаще.
  '.ts': text('TypeScript'),
  '.tsx': text('TypeScript'),
  '.mts': text('TypeScript'),
  '.cts': text('TypeScript'),
  '.js': text('JavaScript'),
  '.jsx': text('JavaScript'),
  '.mjs': text('JavaScript'),
  '.cjs': text('JavaScript'),
  '.json': text('JSON'),
  '.jsonc': text('JSON'),
  '.json5': text('JSON'),
  '.map': text('JSON'),
  '.yml': text('YAML'),
  '.yaml': text('YAML'),
  '.toml': text('TOML'),
  '.ini': text('INI'),
  '.cfg': text('INI'),
  '.conf': text('Config'),
  '.properties': text('Properties'),
  '.xml': text('XML'),
  '.plist': text('XML'),
  '.css': text('CSS'),
  '.scss': text('SCSS'),
  '.sass': text('Sass'),
  '.less': text('Less'),
  '.vue': text('Vue'),
  '.svelte': text('Svelte'),
  '.astro': text('Astro'),
  '.mdx': text('MDX'),
  '.txt': text(),
  '.log': text(),
  '.csv': text('CSV'),
  '.tsv': text('TSV'),
  '.rst': text('reStructuredText'),
  '.adoc': text('AsciiDoc'),
  '.tex': text('TeX'),
  '.sh': text('Shell'),
  '.bash': text('Shell'),
  '.zsh': text('Shell'),
  '.fish': text('Shell'),
  '.command': text('Shell'),
  '.ps1': text('PowerShell'),
  '.bat': text('Batch'),
  '.cmd': text('Batch'),
  '.py': text('Python'),
  '.pyi': text('Python'),
  '.rb': text('Ruby'),
  '.php': text('PHP'),
  '.go': text('Go'),
  '.rs': text('Rust'),
  '.java': text('Java'),
  '.kt': text('Kotlin'),
  '.kts': text('Kotlin'),
  '.scala': text('Scala'),
  '.groovy': text('Groovy'),
  '.gradle': text('Gradle'),
  '.swift': text('Swift'),
  '.m': text('Objective-C'),
  '.mm': text('Objective-C'),
  '.c': text('C'),
  '.h': text('C'),
  '.cc': text('C++'),
  '.cpp': text('C++'),
  '.cxx': text('C++'),
  '.hpp': text('C++'),
  '.cs': text('C#'),
  '.fs': text('F#'),
  '.dart': text('Dart'),
  '.lua': text('Lua'),
  '.pl': text('Perl'),
  '.r': text('R'),
  '.jl': text('Julia'),
  '.ex': text('Elixir'),
  '.exs': text('Elixir'),
  '.erl': text('Erlang'),
  '.hs': text('Haskell'),
  '.clj': text('Clojure'),
  '.elm': text('Elm'),
  '.zig': text('Zig'),
  '.nim': text('Nim'),
  '.sql': text('SQL'),
  '.graphql': text('GraphQL'),
  '.gql': text('GraphQL'),
  '.proto': text('Protocol Buffers'),
  '.tf': text('Terraform'),
  '.hcl': text('HCL'),
  '.nix': text('Nix'),
  '.diff': text('Diff'),
  '.patch': text('Diff'),
  '.lock': text(),
  '.env': text('dotenv'),

  '.zip': BINARY,
  '.gz': BINARY,
  '.tgz': BINARY,
  '.bz2': BINARY,
  '.xz': BINARY,
  '.7z': BINARY,
  '.rar': BINARY,
  '.tar': BINARY,
  '.jar': BINARY,
  '.war': BINARY,
  '.exe': BINARY,
  '.dll': BINARY,
  '.so': BINARY,
  '.dylib': BINARY,
  '.a': BINARY,
  '.o': BINARY,
  '.obj': BINARY,
  '.class': BINARY,
  '.pyc': BINARY,
  '.wasm': BINARY,
  '.node': BINARY,
  '.bin': BINARY,
  '.dmg': BINARY,
  '.iso': BINARY,
  '.db': BINARY,
  '.sqlite': BINARY,
  '.lockb': BINARY,
  '.woff': BINARY,
  '.woff2': BINARY,
  '.ttf': BINARY,
  '.otf': BINARY,
  '.eot': BINARY,
  '.mp3': BINARY,
  '.wav': BINARY,
  '.ogg': BINARY,
  '.flac': BINARY,
  '.mp4': BINARY,
  '.webm': BINARY,
  '.mov': BINARY,
  '.avi': BINARY,
  '.mkv': BINARY,
  '.tif': BINARY,
  '.tiff': BINARY,
  '.heic': BINARY,
  '.icns': BINARY,
  '.psd': BINARY,
  '.sketch': BINARY,
  '.fig': BINARY,
  '.doc': BINARY,
  '.docx': BINARY,
  '.xls': BINARY,
  '.xlsx': BINARY,
  '.ppt': BINARY,
  '.pptx': BINARY,
  '.key': BINARY,
  '.pages': BINARY,
  '.numbers': BINARY
}

/**
 * Виды по полному имени файла (нижний регистр): файлы без расширения и точечные конфиги. Проверяются раньше
 * расширения: у `.gitignore` «расширение» — всё имя.
 */
const BY_NAME: Readonly<Record<string, DocKind>> = {
  makefile: text('Makefile'),
  gnumakefile: text('Makefile'),
  dockerfile: text('Dockerfile'),
  containerfile: text('Dockerfile'),
  jenkinsfile: text('Groovy'),
  vagrantfile: text('Ruby'),
  gemfile: text('Ruby'),
  rakefile: text('Ruby'),
  podfile: text('Ruby'),
  brewfile: text('Ruby'),
  procfile: text(),
  license: text(),
  licence: text(),
  copying: text(),
  notice: text(),
  authors: text(),
  contributors: text(),
  changelog: text(),
  readme: text(),
  codeowners: text(),
  '.gitignore': text('gitignore'),
  '.gitattributes': text('gitattributes'),
  '.gitmodules': text('INI'),
  '.gitkeep': text(),
  '.dockerignore': text('gitignore'),
  '.npmignore': text('gitignore'),
  '.prettierignore': text('gitignore'),
  '.eslintignore': text('gitignore'),
  '.editorconfig': text('INI'),
  '.npmrc': text('INI'),
  '.yarnrc': text('YAML'),
  '.nvmrc': text(),
  '.node-version': text(),
  '.python-version': text(),
  '.ruby-version': text(),
  '.tool-versions': text(),
  '.browserslistrc': text(),
  '.prettierrc': text('JSON'),
  '.eslintrc': text('JSON'),
  '.babelrc': text('JSON'),
  '.swcrc': text('JSON'),
  '.env': text('dotenv'),
  '.bashrc': text('Shell'),
  '.zshrc': text('Shell'),
  '.profile': text('Shell')
}

/** Имена с вариантами-суффиксами: `.env.local`, `Dockerfile.dev`, `LICENSE-MIT`. */
const BY_PREFIX: ReadonlyArray<readonly [string, DocKind]> = [
  ['.env.', text('dotenv')],
  ['dockerfile.', text('Dockerfile')],
  ['license-', text()]
]

/**
 * Вид файла по пути (`/` или `\` — разделитель, регистр не важен). Порядок: полное имя → префикс имени →
 * последнее расширение (`a.test.ts`, `x.d.ts` — по `.ts`) → `unknown`. Точечный файл без своей записи (`.foo`) —
 * `unknown`: его «расширение» — всё имя.
 */
export function docKindOf(path: string): DocKind {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  // hasOwn: файл `constructor` или `__proto__` не должен находить свойства Object.prototype.
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name]
  for (const [prefix, kind] of BY_PREFIX) if (name.startsWith(prefix)) return kind
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot)
    if (Object.hasOwn(BY_EXT, ext)) return BY_EXT[ext]
  }
  return { kind: 'unknown' }
}
