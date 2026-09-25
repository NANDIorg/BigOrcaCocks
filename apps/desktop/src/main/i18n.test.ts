// Тексты main на языке интерфейса: словари ru/en, ошибки с кодом для IPC, трей и уведомления.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { OrcaEvent } from '@orca-board/core'
import ru from './strings/ru'
import en from './strings/en'
import { OrcaError, ipcError, mt, mtIn, setMainLocale, mainLocale } from './i18n'
import { describeEvent } from './notify'
import { missingRoleMessage } from './agents'
import { columnTitle } from './defaultTitles'

afterEach(() => setMainLocale('ru'))

const names = (m: unknown): string[] =>
  [...new Set((typeof m === 'string' ? m : Object.values(m as object).join(' ')).match(/\{\w+\}/g) ?? [])].sort()

describe('словари main', () => {
  it('en — те же ключи, что ru, и те же параметры {name}', () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort())
    for (const [key, m] of Object.entries(ru)) assert.deepEqual(names(en[key as keyof typeof en]), names(m), key)
  })

  it('в en нет кириллицы', () => {
    for (const [key, m] of Object.entries(en)) {
      assert.doesNotMatch(typeof m === 'string' ? m : Object.values(m).join(' '), /[А-Яа-яЁё]/, key)
    }
  })

  it('язык по умолчанию и неизвестный — русский', () => {
    assert.equal(mainLocale(), 'ru')
    setMainLocale('en')
    assert.equal(mainLocale(), 'en')
    setMainLocale(undefined)
    assert.equal(mainLocale(), 'ru')
  })

  it('множественное число по языку', () => {
    assert.equal(mtIn('ru', 'dialog.quit.message', { count: 3 }), '3 задачи в работе, агенты будут остановлены. Выйти?')
    assert.equal(mtIn('ru', 'dialog.quit.message', { count: 5 }), '5 задач в работе, агенты будут остановлены. Выйти?')
    assert.match(mtIn('en', 'dialog.quit.message', { count: 1 }), /^1 task is in progress/)
    assert.match(mtIn('en', 'dialog.quit.message', { count: 2 }), /^2 tasks are in progress/)
  })

  it('вложенное сообщение-параметр переводится на тот же язык', () => {
    setMainLocale('en')
    assert.equal(mt('agent.disabled', { id: 'codex', enabled: { key: 'common.none' } }).endsWith('Enabled: none'), true)
  })
})

describe('OrcaError', () => {
  it('message — по-русски при любом языке: его читают сокет, CLI и агенты', () => {
    setMainLocale('en')
    const e = new OrcaError('docs.notFound', { path: 'a.md' })
    assert.equal(e.message, 'файл не найден: a.md')
    assert.equal(missingRoleMessage('qa', { title: 'Бэкенд', roles: [] }).startsWith('роли «qa» нет в типе задачи «Бэкенд». Роли типа: нет'), true)
  })

  it('ipcError: текст на языке интерфейса, стабильный код — в имени (renderer видит «имя: сообщение»)', () => {
    setMainLocale('en')
    const out = ipcError(new OrcaError('coordinator.finishing'))
    assert.ok(out instanceof Error)
    assert.equal(String(out), 'OrcaError[coordinator.finishing]: the coordinator of this global task is still finishing — try again in a few seconds')
    setMainLocale('ru')
    assert.equal(String(ipcError(new OrcaError('docs.notFound', { path: 'x.md' }))), 'OrcaError[docs.notFound]: файл не найден: x.md')
  })

  it('обычные ошибки ipcError не трогает', () => {
    const e = new Error('task not found: t1')
    assert.equal(ipcError(e), e)
  })
})

describe('трей, уведомления, колонки', () => {
  const event = (payload: Record<string, unknown>): OrcaEvent =>
    ({ id: 'e1', type: 'request_created', at: 1, taskId: 't1', payload }) as unknown as OrcaEvent

  it('текст уведомления — на языке интерфейса', () => {
    assert.equal(describeEvent(event({ kind: 'question', requestId: 'r1', title: 'Как?' }), undefined, 'p', true)?.body, 'Вопрос: Как?')
    setMainLocale('en')
    assert.equal(describeEvent(event({ kind: 'question', requestId: 'r1', title: 'How?' }), undefined, 'p', true)?.body, 'Question: How?')
  })

  it('встроенная колонка переводится, пока её не переименовали', () => {
    setMainLocale('en')
    assert.equal(columnTitle({ id: 'backlog', title: 'Бэклог' }), 'Backlog')
    assert.equal(columnTitle({ id: 'backlog', title: 'Идеи' }), 'Идеи')
    assert.equal(columnTitle({ id: 'custom_1', title: 'Бэклог' }), 'Бэклог')
  })
})
