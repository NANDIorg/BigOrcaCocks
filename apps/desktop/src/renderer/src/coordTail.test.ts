import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendTail, COORD_TAIL_CHARS, mergeTail, stripAnsi, tailFromRegistry, tailLines } from './coordTail'

test('stripAnsi: цвета, курсор, OSC и выбор набора символов уходят, текст остаётся', () => {
  assert.equal(stripAnsi('\x1b[32mok\x1b[0m done'), 'ok done')
  assert.equal(stripAnsi('\x1b]0;заголовок\x07текст'), 'текст')
  assert.equal(stripAnsi('\x1b]8;;http://x\x1b\\ссылка\x1b]8;;\x1b\\'), 'ссылка')
  assert.equal(stripAnsi('\x1b[?25l\x1b[2K\x1b(Bпривет'), 'привет')
  assert.equal(stripAnsi('a\x1b[1Cb\x1b[3Cc'), 'a b c')
  assert.equal(stripAnsi('a\x07b\x00c'), 'abc')
})

test('tailLines: последние N строк, пустые края и перевод CRLF', () => {
  assert.deepEqual(tailLines('\n\n1\r\n2\r\n3\r\n\n'), ['1', '2', '3'])
  assert.deepEqual(tailLines('1\n2\n3\n4\n5', 2), ['4', '5'])
  assert.deepEqual(tailLines(''), [])
})

test('tailLines: возврат каретки затирает строку, повторы и пустые серии схлопываются', () => {
  assert.deepEqual(tailLines('10%\r50%\r100%\nготово'), ['100%', 'готово'])
  assert.deepEqual(tailLines('⠋ думаю\n⠋ думаю\n⠋ думаю\nответ'), ['⠋ думаю', 'ответ'])
  assert.deepEqual(tailLines('a\n\n\n\nb'), ['a', '', 'b'])
  assert.deepEqual(tailLines('строка   \x1b[0m'), ['строка'])
})

test('tailLines: позиционирование курсора TUI не склеивает слова и не сливает строки', () => {
  // Claude Code: «⏺», колонка 3, слово, колонка 10, слово; затем «вниз» и следующий кадр после `ESC[H`
  const frame = '\x1b[?2026h\x1b[H\r\x1b[2B⏺\x1b[3G\x1b[39mПривет\x1b[10Gмир\r\x1b[2C\x1b[15Bготово\x1b[50;1H\x1b[?25h'
  assert.deepEqual(tailLines(frame), ['⏺ Привет мир', 'готово'])
  assert.deepEqual(tailLines('a\x1b[5Gb'), ['a b'])
  // колонка 1 — возврат каретки: спиннер затирает себя
  assert.deepEqual(tailLines('⠋ думаю\x1b[1G⠙ думаю'), ['⠙ думаю'])
})

test('tailFromRegistry: хвост нужного PTY; нет терминала или списка — undefined', () => {
  const list = [{ ptyId: 'p1', tail: 'один' }, { ptyId: 'p2', tail: 'два' }]
  assert.equal(tailFromRegistry(list, 'p2'), 'два')
  assert.equal(tailFromRegistry(list, 'p3'), undefined)
  assert.equal(tailFromRegistry(undefined, 'p1'), undefined)
})

test('mergeTail: куски после хвоста дописываются, уже вошедший в хвост — нет', () => {
  assert.equal(mergeTail('a\nb', ['\nc']), 'a\nb\nc')
  assert.equal(mergeTail('a\nb', ['b']), 'a\nb')
  // хвост из main без \r, живой кусок с ним
  assert.equal(mergeTail('a\nb', ['b\r']), 'a\nb')
  assert.equal(mergeTail('a', ['\x1b[32mx\x1b[0m', 'y']), 'a\x1b[32mx\x1b[0my')
  assert.equal(mergeTail('a', []), 'a')
  // хвост из main без CSI и пробелов от позиционирования: живой кусок с ними всё равно распознаётся как уже вошедший
  assert.equal(mergeTail('⏺Привет', ['⏺\x1b[3GПривет']), '⏺Привет')
})

test('appendTail и mergeTail не растут бесконечно', () => {
  const big = 'x'.repeat(COORD_TAIL_CHARS)
  assert.equal(appendTail(big, 'yz').length, COORD_TAIL_CHARS)
  assert.ok(appendTail(big, 'yz').endsWith('yz'))
  assert.equal(mergeTail(big, ['q']).length, COORD_TAIL_CHARS)
})
