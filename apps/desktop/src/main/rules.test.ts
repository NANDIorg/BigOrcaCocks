// Запуск: pnpm --filter @orca-board/desktop test. Раздел «Правила»: чтение и запись CLAUDE.md / AGENTS.md.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listRules, readRule, ruleFileName, RULE_MAX_BYTES, withEol, writeRule } from './rules'

let tmp: string
let repo: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-rules-')))
  repo = path.join(tmp, 'repo')
  mkdirSync(repo)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('белый список имён', () => {
  it('пропускает только CLAUDE.md и AGENTS.md', () => {
    assert.equal(ruleFileName('CLAUDE.md'), 'CLAUDE.md')
    assert.equal(ruleFileName('AGENTS.md'), 'AGENTS.md')
  })

  it('отклоняет пути, другие файлы, другой регистр и не-строки', () => {
    for (const bad of ['../CLAUDE.md', './CLAUDE.md', 'docs/CLAUDE.md', '/etc/passwd', 'README.md', 'claude.md',
      'CLAUDE.md\0', ' CLAUDE.md', '..', '', null, undefined, 42, ['CLAUDE.md']]) {
      assert.throws(() => ruleFileName(bad), /можно править только CLAUDE\.md и AGENTS\.md/, String(bad))
    }
  })

  it('writeRule и readRule не трогают файл вне белого списка', () => {
    assert.throws(() => writeRule(repo, '../evil.md', 'x'))
    assert.throws(() => writeRule(repo, 'README.md', 'x'))
    assert.throws(() => readRule(repo, '../../etc/hosts'))
    assert.deepEqual(readdirSync(tmp), ['repo'])
    assert.deepEqual(readdirSync(repo), [])
  })
})

describe('listRules / readRule', () => {
  it('отсутствующие файлы — exists: false, в порядке белого списка', () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), '# a\n')
    assert.deepEqual(listRules(repo), [
      { name: 'CLAUDE.md', exists: false, text: '', eol: 'lf' },
      { name: 'AGENTS.md', exists: true, text: '# a\n', eol: 'lf' }
    ])
  })

  it('CRLF отдаётся как \\n с eol: crlf', () => {
    writeFileSync(path.join(repo, 'CLAUDE.md'), '# a\r\n\r\nb\r\n')
    assert.deepEqual(readRule(repo, 'CLAUDE.md'), { name: 'CLAUDE.md', exists: true, text: '# a\n\nb\n', eol: 'crlf' })
  })

  it('каталог с именем правил и слишком большой файл — ошибка', () => {
    mkdirSync(path.join(repo, 'CLAUDE.md'))
    assert.throws(() => readRule(repo, 'CLAUDE.md'), /не файл/)
    writeFileSync(path.join(repo, 'AGENTS.md'), 'x'.repeat(RULE_MAX_BYTES + 1))
    assert.throws(() => readRule(repo, 'AGENTS.md'), /больше/)
  })
})

describe('writeRule', () => {
  it('создаёт файл с LF и не оставляет временных файлов', () => {
    const r = writeRule(repo, 'AGENTS.md', 'a\r\nb\n')
    assert.deepEqual(r, { name: 'AGENTS.md', exists: true, text: 'a\nb\n', eol: 'lf' })
    assert.equal(readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), 'a\nb\n')
    assert.deepEqual(readdirSync(repo), ['AGENTS.md'])
  })

  it('сохраняет CRLF существующего файла', () => {
    writeFileSync(path.join(repo, 'CLAUDE.md'), 'old\r\n')
    const r = writeRule(repo, 'CLAUDE.md', 'new\nline\n')
    assert.equal(readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), 'new\r\nline\r\n')
    assert.equal(r.eol, 'crlf')
    assert.equal(r.text, 'new\nline\n')
  })

  it('симлинк внутри проекта: пишет в цель, ссылка остаётся', () => {
    writeFileSync(path.join(repo, 'AGENTS.md'), 'old\n')
    symlinkSync('AGENTS.md', path.join(repo, 'CLAUDE.md'))
    writeRule(repo, 'CLAUDE.md', 'new\n')
    assert.ok(lstatSync(path.join(repo, 'CLAUDE.md')).isSymbolicLink())
    assert.equal(readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), 'new\n')
  })

  it('симлинк за пределы проекта — ошибка, внешний файл не меняется', () => {
    const outside = path.join(tmp, 'outside.md')
    writeFileSync(outside, 'secret\n')
    symlinkSync(outside, path.join(repo, 'CLAUDE.md'))
    assert.throws(() => readRule(repo, 'CLAUDE.md'), /за пределы проекта/)
    assert.throws(() => writeRule(repo, 'CLAUDE.md', 'pwned\n'), /за пределы проекта/)
    assert.equal(readFileSync(outside, 'utf8'), 'secret\n')
  })

  it('текст не строка или слишком большой — ошибка', () => {
    assert.throws(() => writeRule(repo, 'CLAUDE.md', 42), /строкой/)
    assert.throws(() => writeRule(repo, 'CLAUDE.md', 'x'.repeat(RULE_MAX_BYTES + 1)), /больше/)
    assert.deepEqual(readdirSync(repo), [])
  })
})

describe('withEol', () => {
  it('нормализует любые переводы строк', () => {
    assert.equal(withEol('a\r\nb\rc\n', 'lf'), 'a\nb\nc\n')
    assert.equal(withEol('a\r\nb\n', 'crlf'), 'a\r\nb\r\n')
  })
})
