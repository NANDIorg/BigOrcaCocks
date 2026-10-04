import test from 'node:test'
import assert from 'node:assert/strict'
import { privilegedCommand } from '../src/server/privileges.ts'

test('root выполняет административную команду напрямую без установленного sudo', () => {
  assert.deepEqual(privilegedCommand('/usr/bin/systemctl', ['start', 'orca-web.service'], true, 0), ['/usr/bin/systemctl', ['start', 'orca-web.service']])
  assert.deepEqual(privilegedCommand('install', ['-m', '644', '/tmp/service', '/etc/systemd/system/orca-web.service'], false, 0), ['install', ['-m', '644', '/tmp/service', '/etc/systemd/system/orca-web.service']])
})
test('обычный пользователь сохраняет sudo и non-interactive режим обновлений', () => {
  assert.deepEqual(privilegedCommand('/usr/bin/systemctl', ['start', 'orca-web.service'], true, 1000), ['sudo', ['-n', '/usr/bin/systemctl', 'start', 'orca-web.service']])
  assert.deepEqual(privilegedCommand('install', ['-m', '644', 'source', 'destination'], false, 1000), ['sudo', ['install', '-m', '644', 'source', 'destination']])
})
