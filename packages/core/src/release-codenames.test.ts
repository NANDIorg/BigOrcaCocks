import { it } from 'node:test'
import assert from 'node:assert/strict'
import { releaseCodename, releaseTitle, releaseVersionLabel, validateReleaseCodenames } from './release-codenames.ts'

it('major/minor задаёт животное, patch и префикс v наследуют имя', () => {
  assert.equal(releaseCodename('1.0.1'), 'Orca')
  assert.equal(releaseCodename('1.1.0'), 'Sea Lion')
  assert.equal(releaseCodename('v1.1.7'), 'Sea Lion')
  assert.equal(releaseVersionLabel('v1.1.7'), 'v1.1.7 · Sea Lion')
  assert.equal(releaseTitle('1.1.0'), 'Orca 1.1.0 · Sea Lion')
})
it('неизвестная/некорректная версия не получает выдуманное животное', () => {
  for (const version of ['2.7.4', '01.1.0', '1.1', '1.1.0-beta.1', '<img src=x>']) assert.equal(releaseCodename(version), undefined)
  assert.equal(releaseVersionLabel('2.7.4'), '2.7.4')
  assert.throws(() => releaseTitle('2.0.0'), /имя/)
})
it('реестр запрещает повтор серий и имён с другим регистром/разделителем', () => {
  assert.throws(() => validateReleaseCodenames([{ series: '1.0', name: 'Orca' }, { series: '1.0', name: 'Sea Lion' }]), /серия/)
  assert.throws(() => validateReleaseCodenames([{ series: '1.0', name: 'Sea Lion' }, { series: '1.1', name: 'sea-lion' }]), /повтор/)
  for (const value of [null, {}, [{ series: '1.0.0', name: 'Orca' }], [{ series: '1.0', name: 'Orca\nBAD=value' }]]) assert.throws(() => validateReleaseCodenames(value))
})
it('закреплённые пары нельзя удалять или переименовывать, новые можно добавлять', () => {
  const previous = [{ series: '1.0', name: 'Orca' }]
  assert.throws(() => validateReleaseCodenames([], previous), /удал/)
  assert.throws(() => validateReleaseCodenames([{ series: '1.0', name: 'Dolphin' }], previous), /менять/)
  assert.equal(validateReleaseCodenames([...previous, { series: '1.1', name: 'Sea Lion' }], previous).length, 2)
})
