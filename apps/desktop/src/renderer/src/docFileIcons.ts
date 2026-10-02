import { docKindOf, type DocViewKind } from '../../shared/docs-view'
import { docIconOf, type DocIconName } from './docView'

export type FileLogoName =
  | 'swift' | 'typescript' | 'javascript' | 'react' | 'python' | 'rust' | 'go' | 'java' | 'kotlin' | 'dart'
  | 'c' | 'cplusplus' | 'csharp' | 'fsharp' | 'ruby' | 'php' | 'lua' | 'r' | 'elixir' | 'erlang'
  | 'haskell' | 'clojure' | 'scala' | 'graphql' | 'docker' | 'nixos' | 'terraform' | 'vuejs' | 'svelte' | 'astro'
  | 'html5' | 'css3' | 'sass' | 'less' | 'markdown' | 'git' | 'powershell' | 'json' | 'yaml'
  | 'nodejs' | 'npm' | 'pnpm' | 'yarn' | 'groovy' | 'gradle' | 'zig' | 'nim'

export type FileGlyphName = 'archive' | 'audio' | 'video' | 'font' | 'database' | 'table' | 'terminal' | 'diff'
export interface DocFileIconInfo { kind: DocIconName; logo?: FileLogoName; glyph?: FileGlyphName }

const LANGUAGE_LOGOS: Readonly<Record<string, FileLogoName>> = {
  Swift: 'swift', TypeScript: 'typescript', JavaScript: 'javascript', Python: 'python', Rust: 'rust', Go: 'go',
  Java: 'java', Kotlin: 'kotlin', Dart: 'dart', C: 'c', 'C++': 'cplusplus', 'C#': 'csharp', 'F#': 'fsharp',
  Ruby: 'ruby', PHP: 'php', Lua: 'lua', R: 'r', Elixir: 'elixir', Erlang: 'erlang', Haskell: 'haskell',
  Clojure: 'clojure', Scala: 'scala', GraphQL: 'graphql', Dockerfile: 'docker', Nix: 'nixos',
  Terraform: 'terraform', HCL: 'terraform', Vue: 'vuejs', Svelte: 'svelte', Astro: 'astro',
  HTML: 'html5', CSS: 'css3', SCSS: 'sass', Sass: 'sass', Less: 'less', Markdown: 'markdown', MDX: 'markdown',
  gitignore: 'git', gitattributes: 'git', PowerShell: 'powershell', JSON: 'json', YAML: 'yaml',
  Groovy: 'groovy', Gradle: 'gradle', Zig: 'zig', Nim: 'nim'
}

const NAME_LOGOS: Readonly<Record<string, FileLogoName>> = {
  'package.json': 'nodejs', 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm', 'pnpm-workspace.yaml': 'pnpm', 'yarn.lock': 'yarn',
  'cargo.toml': 'rust', 'cargo.lock': 'rust', '.gitmodules': 'git',
  'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker', 'compose.yml': 'docker', 'compose.yaml': 'docker'
}

const LANGUAGE_GLYPHS: Readonly<Record<string, FileGlyphName>> = {
  SQL: 'database', CSV: 'table', TSV: 'table', Shell: 'terminal', Batch: 'terminal', Makefile: 'terminal', Diff: 'diff'
}
const EXTENSION_GLYPHS: Readonly<Record<string, FileGlyphName>> = {
  zip: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', '7z': 'archive', rar: 'archive', tar: 'archive',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', avi: 'video', mkv: 'video',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', eot: 'font', db: 'database', sqlite: 'database'
}

/** Значки с одним тёмным цветом должны оставаться различимыми и в тёмных темах. */
export const MONO_FILE_LOGOS: ReadonlySet<FileLogoName> = new Set(['rust', 'markdown', 'json', 'gradle', 'less', 'astro'])

/** Имя служебного файла и JSX уточняют общую классификацию; уточнённый main вид всегда важнее расширения. */
export function docFileIconOf(path: string, kind?: DocViewKind): DocFileIconInfo {
  const info: DocFileIconInfo = { kind: docIconOf(path, kind) }
  const byPath = docKindOf(path)
  if (kind !== undefined && kind !== byPath.kind) return info
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  if (Object.hasOwn(NAME_LOGOS, name)) return { ...info, logo: NAME_LOGOS[name] }
  if (/\.(?:tsx|jsx)$/.test(name)) return { ...info, logo: 'react' }
  const language = byPath.language
  if (language && Object.hasOwn(LANGUAGE_LOGOS, language)) return { ...info, logo: LANGUAGE_LOGOS[language] }
  if (language && Object.hasOwn(LANGUAGE_GLYPHS, language)) return { ...info, glyph: LANGUAGE_GLYPHS[language] }
  if (byPath.kind === 'binary') {
    const extension = name.slice(name.lastIndexOf('.') + 1)
    if (Object.hasOwn(EXTENSION_GLYPHS, extension)) return { ...info, glyph: EXTENSION_GLYPHS[extension] }
  }
  return info
}
