import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentChip, CHIP_NAME_MAX, isOpenableExt, truncateMiddle } from './attachmentChip'
import { formatBytes } from './i18n/format'
import { setLocale } from './i18n'

function inEnglish(fn: () => void): void {
  setLocale('en')
  try {
    fn()
  } finally {
    setLocale('ru')
  }
}

test('attachmentChip: файл — бейдж расширения, имя, размер', () => {
  const chip = attachmentChip({ kind: 'file', name: 'spec-v2.pdf', ext: 'pdf', bytes: 1.2 * 1024 * 1024 })
  assert.deepEqual(chip, { kind: 'file', extLabel: 'PDF', name: 'spec-v2.pdf', shortName: 'spec-v2.pdf', size: '1,2 МБ', openable: true })
})

test('attachmentChip: расширение без ext берётся из имени; без расширения — «файл»', () => {
  assert.equal(attachmentChip({ kind: 'file', name: 'Error.LOG', bytes: 10 }).extLabel, 'LOG')
  assert.equal(attachmentChip({ kind: 'file', name: 'Makefile', bytes: 10 }).extLabel, 'файл')
  assert.equal(attachmentChip({ kind: 'file', name: 'x.tar.gz', ext: '', bytes: 10 }).extLabel, 'файл') // ext из main важнее имени
})

test('attachmentChip: запись без kind — картинка; без имени — «без имени»; имя очищается', () => {
  const chip = attachmentChip({ ext: 'png', bytes: 2048 })
  assert.equal(chip.kind, 'image')
  assert.equal(chip.name, 'без имени')
  assert.equal(chip.size, '2 КБ')
  assert.equal(attachmentChip({ kind: 'file', name: 'C:\\tmp\\a\u202Etxt.exe', bytes: 1 }).name, 'atxt.exe')
})

test('attachmentChip: длинное имя обрезается посередине, полное — в name', () => {
  const long = 'очень-длинное-имя-отчёта-за-третий-квартал-v12.xlsx'
  const chip = attachmentChip({ kind: 'file', name: long, bytes: 1 })
  assert.equal(chip.name, long)
  assert.equal(Array.from(chip.shortName).length, CHIP_NAME_MAX)
  assert.ok(chip.shortName.endsWith('-v12.xlsx'), chip.shortName)
  assert.ok(chip.shortName.includes('…'))
})

test('truncateMiddle: по символам, короткое не трогает', () => {
  assert.equal(truncateMiddle('abc', 5), 'abc')
  assert.equal(truncateMiddle('abcdefghij', 5), 'ab…ij')
  assert.equal(truncateMiddle('😀😀😀😀😀😀', 4), '😀…😀😀')
  assert.equal(truncateMiddle('abcdef', 1), '…')
})

test('openable: только белый список показа без HTML и SVG — исполняемое и архивы не открываются', () => {
  for (const ext of ['pdf', 'md', 'png', 'JPG']) assert.equal(isOpenableExt(ext), true, ext)
  for (const ext of ['html', 'htm', 'svg', 'SVG', 'sh', 'app', 'exe', 'zip', 'docx', 'txt', 'log', '']) assert.equal(isOpenableExt(ext), false, ext)
  assert.equal(attachmentChip({ kind: 'file', name: 'run.sh', bytes: 1 }).openable, false)
  assert.equal(attachmentChip({ kind: 'file', name: 'page.html', bytes: 1 }).openable, false)
  assert.equal(attachmentChip({ kind: 'file', name: 'noext', bytes: 1 }).openable, false)
})

test('formatBytes: Б / КБ / МБ, дробь только у чисел меньше 10, язык интерфейса', () => {
  assert.equal(formatBytes(0), '0 Б')
  assert.equal(formatBytes(512), '512 Б')
  assert.equal(formatBytes(48 * 1024), '48 КБ')
  assert.equal(formatBytes(1536), '1,5 КБ')
  assert.equal(formatBytes(25 * 1024 * 1024), '25 МБ')
  assert.equal(formatBytes(Number.NaN), '0 Б')
  inEnglish(() => {
    assert.equal(formatBytes(1.2 * 1024 * 1024), '1.2 MB')
    assert.equal(attachmentChip({ kind: 'file', name: 'Makefile', bytes: 3 }).extLabel, 'file')
  })
})
