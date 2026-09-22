// Запуск: pnpm --filter @orca-board/desktop test (node --test --experimental-transform-types + test/ts-resolve.mjs:
// в projects.ts есть parameter properties, простого type stripping мало).
// Воспроизводит причины из docs/investigations/windows-open-project.md. Тесты зелёные на ТЕКУЩЕМ
// поведении: ассерты «как сейчас» помечены ДЕФЕКТ — после фикса их нужно перевернуть.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProjectManager } from './projects'

let tmp: string
let repo: string

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-win32-'))
  repo = path.join(tmp, 'репо с пробелом')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
})

after(() => rmSync(tmp, { recursive: true, force: true }))

function manager(): ProjectManager {
  return new ProjectManager(mkdtempSync(path.join(tmp, 'userData-')))
}

/** Выполнить fn с временно подменёнными переменными окружения (execFileSync берёт process.env). */
function withEnv<T>(patch: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]))
  Object.assign(process.env, patch)
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('ProjectManager.add — причина №1/№2: любая ошибка git выдаётся за «не git-репозиторий»', () => {
  it('контроль: обычный репозиторий (кириллица и пробел в пути) добавляется', () => {
    const p = manager().add(repo)
    assert.equal(p.name, 'репо с пробелом')
  })

  it('ДЕФЕКТ: «dubious ownership» (safe.directory, частый случай на Windows) → «не git-репозиторий»', () => {
    // GIT_TEST_ASSUME_DIFFERENT_OWNER — тестовый флаг git: ведёт себя так, будто владелец каталога — другой
    // пользователь. На Windows это репозиторий на FAT/exFAT/сетевом диске, в \\wsl$, склонированный от админа.
    const err = withEnv({ GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' }, () => {
      try {
        manager().add(repo)
        return null
      } catch (e) {
        return e as Error
      }
    })
    assert.ok(err, 'git отказался открывать репозиторий')
    assert.match(err.message, /не git-репозиторий/)
    // После фикса в сообщении должна быть причина от git и подсказка про safe.directory.
    assert.doesNotMatch(err.message, /dubious ownership|safe\.directory/)
  })

  it('ДЕФЕКТ: git не найден в PATH процесса (ENOENT) → «не git-репозиторий»', () => {
    const err = withEnv({ PATH: path.join(tmp, 'пустой-PATH') }, () => {
      try {
        manager().add(repo)
        return null
      } catch (e) {
        return e as Error
      }
    })
    assert.ok(err)
    assert.match(err.message, /не git-репозиторий/)
    // После фикса: «git не найден в PATH…».
    assert.doesNotMatch(err.message, /ENOENT|не найден/)
  })
})

describe('win32-пути (path.win32): что git возвращает на Windows и что из этого делает projects.ts', () => {
  it('git rev-parse --show-toplevel на Windows отдаёт прямые слэши; join нормализует их — worktree корректен', () => {
    const root = 'C:/Users/Иван Петров/My Repo' // формат вывода Git for Windows
    assert.equal(path.win32.join(root, '..', '.orca-worktrees', 'task_x'), 'C:\\Users\\Иван Петров\\.orca-worktrees\\task_x')
    assert.equal(path.win32.basename(root), 'My Repo')
  })

  it('ДЕФЕКТ (косметика): репозиторий в корне диска → пустое имя проекта (basename("D:/") === "")', () => {
    assert.equal(path.win32.basename('D:/'), '')
  })

  it('id проекта и имя файла доски — hex sha1, без «:» и «\\» даже для C:/… пути', () => {
    const m = manager()
    const p = m.add(repo)
    assert.match(p.id, /^[0-9a-f]{10}$/)
  })

  it('ДЕФЕКТ (косметика): сокращение домашней папки в сайдбаре (App.tsx) не срабатывает для C:/Users/…', () => {
    const shorten = (root: string): string => root.replace(/^\/Users\/[^/]+/, '~') // копия App.tsx:563
    assert.equal(shorten('C:/Users/ivan/repo'), 'C:/Users/ivan/repo')
  })
})
