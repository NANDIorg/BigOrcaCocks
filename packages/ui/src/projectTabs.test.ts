import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTab, tabKey, TABS } from './projectTabs'

test('parseTab — сохранённая вкладка восстанавливается', () => {
  for (const tab of TABS) assert.equal(parseTab(tab), tab)
})

test('parseTab — бывшая вкладка «Файлы» и мусор открывают «Канбан»', () => {
  assert.equal(parseTab('files'), 'board')
  assert.equal(parseTab(null), 'board')
  assert.equal(parseTab(undefined), 'board')
  assert.equal(parseTab(''), 'board')
  assert.equal(parseTab('constructor'), 'board')
  assert.equal(TABS.includes('files' as never), false)
})

test('tabKey — ключ per-project', () => {
  assert.equal(tabKey('p1'), 'orca.tab.p1')
})
