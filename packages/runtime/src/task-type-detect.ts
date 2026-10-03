import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Подсказка типа задач по умолчанию для нового проекта по файлам репозитория: только предвыбор при добавлении
 * проекта, человек может выбрать другой.
 */
export interface TaskTypeHint {
  /** Id встроенного типа задачи; null — признаков нет, предвыбирается тип библиотеки по умолчанию. */
  typeId: string | null
  /** Почему: «package.json: react», «go.mod». Пусто, если признаков нет. */
  reason: string
}

const FRONTEND_DEPS = ['react', 'react-dom', 'vue', 'svelte', '@angular/core', 'next', 'nuxt', 'solid-js', 'preact']
const BACKEND_DEPS = ['express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi']
const MOBILE_DEPS = ['react-native', 'expo', '@capacitor/core', '@ionic/angular', '@ionic/react']
const AUTOTEST_DEPS = ['@playwright/test', 'playwright', 'cypress', 'webdriverio', '@wdio/cli', 'appium']
/** Файлы в корне, по которым видно серверный язык. */
const BACKEND_FILES = ['go.mod', 'pom.xml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'Gemfile', 'composer.json', 'mix.exs']
const DOCS_FILES = ['mkdocs.yml', 'book.toml', 'antora.yml']
/** Где искать AndroidManifest.xml и *.xcodeproj: корень, модуль app, папки платформ кроссплатформенных проектов. */
const ANDROID_MANIFESTS = ['AndroidManifest.xml', 'app/src/main/AndroidManifest.xml', 'android/app/src/main/AndroidManifest.xml']
const IOS_DIRS = ['.', 'ios']

function names(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Все зависимости package.json (включая dev); нет файла или битый JSON — пусто. */
function packageDeps(root: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    const deps = new Set<string>()
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const v = pkg[key]
      if (v && typeof v === 'object') for (const name of Object.keys(v)) deps.add(name)
    }
    return deps
  } catch {
    return new Set()
  }
}

/**
 * Угадать тип по корню репозитория. Порядок важен: мобильные проекты часто содержат package.json с react,
 * а фронт с серверным фреймворком (или рядом go.mod) — это fullstack.
 */
export function guessTaskType(root: string): TaskTypeHint {
  const top = names(root)
  const deps = packageDeps(root)
  const found = (list: string[]): string[] => list.filter((d) => deps.has(d))

  const android = ANDROID_MANIFESTS.find((f) => existsSync(join(root, f)))
  if (android) return { typeId: 'mobile', reason: android }
  for (const dir of IOS_DIRS) {
    const xcode = names(join(root, dir)).find((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'))
    if (xcode) return { typeId: 'mobile', reason: dir === '.' ? xcode : `${dir}/${xcode}` }
  }
  if (top.includes('pubspec.yaml')) return { typeId: 'mobile', reason: 'pubspec.yaml' }
  const mobile = found(MOBILE_DEPS)
  if (mobile.length) return { typeId: 'mobile', reason: `package.json: ${mobile.join(', ')}` }

  const frontend = found(FRONTEND_DEPS)
  const backend = [...found(BACKEND_DEPS).map((d) => `package.json: ${d}`), ...BACKEND_FILES.filter((f) => top.includes(f))]
  if (frontend.length && backend.length) {
    return { typeId: 'fullstack', reason: [`package.json: ${frontend.join(', ')}`, ...backend].join('; ') }
  }
  if (frontend.length) return { typeId: 'frontend', reason: `package.json: ${frontend.join(', ')}` }
  if (backend.length) return { typeId: 'backend', reason: backend.join('; ') }

  const autotests = found(AUTOTEST_DEPS)
  if (autotests.length) return { typeId: 'autotests', reason: `package.json: ${autotests.join(', ')}` }
  const docs = DOCS_FILES.find((f) => top.includes(f))
  if (docs) return { typeId: 'docs', reason: docs }
  return { typeId: null, reason: '' }
}
