import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builderRequire, readYaml, run, validateCredentials, validateReleaseConfig, selectIdentity, validateSignature, notarizeDmg, verifyUpdateMetadata } from './macos-release.mjs'
import { beforePack, artifactBuildCompleted } from '../apps/desktop/build/macos-release-hooks.mjs'
import { beforePack as localBeforePack } from '../apps/desktop/build/macos-local-hooks.mjs'
import { validateEntitlements, verifyApp, verifyDmg } from './verify-macos-release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const desktop = join(root, 'apps/desktop')
const team = 'ABCDE12345'
// Синтетические значения; закрытых ключей и реальных Apple credentials здесь нет.
const credentials = { CSC_LINK: 'MAA=', CSC_KEY_PASSWORD: 'fixture', APPLE_ID: 'test@example.invalid',
  APPLE_APP_SPECIFIC_PASSWORD: 'aaaa-bbbb-cccc-dddd', APPLE_TEAM_ID: team }
const identity = `Developer ID Application: Fixture (${team})`
const signature = `CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1\nAuthority=${identity}\nTeamIdentifier=${team}\nTimestamp=Sep 25, 2026\n`
const success = (stdout = '', stderr = '') => ({ status: 0, stdout, stderr })
const config = () => readYaml(join(desktop, 'electron-builder.yml'))

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-signing-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function context(overrides = {}) {
  return { electronPlatformName: 'darwin', packager: { config: config(), info: { options: { publish: 'never' } },
    codeSigningInfo: { value: Promise.resolve({ keychainFile: '/fixture/temporary.keychain' }) }, appInfo: { version: '1.0.0' } }, ...overrides }
}

test('каждый обязательный credential проверяется; значения не попадают в ошибки', () => {
  assert.equal(validateCredentials(credentials), team)
  for (const name of Object.keys(credentials)) {
    for (const missing of [undefined, '', '   ']) {
      assert.throws(() => validateCredentials({ ...credentials, [name]: missing }), new RegExp(name))
    }
  }
  for (const invalid of [{ APPLE_TEAM_ID: 'wrong' }, { CSC_LINK: '/tmp/private.p12' },
    { APPLE_ID: 'not-email' }, { APPLE_APP_SPECIFIC_PASSWORD: 'main-account-password' },
    { APPLE_API_KEY: '/tmp/key.p8' }, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, { CSC_NAME: '-' }]) {
    assert.throws(() => validateCredentials({ ...credentials, ...invalid }), error => {
      assert.ok(!error.message.includes(Object.values(invalid)[0]))
      return true
    })
  }
})

test('ошибка внешней команды не раскрывает аргументы с паролями; stderr успеха доступен проверке', () => {
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(7)', 'private-secret']), error => {
    assert.ok(!error.message.includes('private-secret'))
    return /\(7\)/.test(error.message)
  })
  assert.equal(run(process.execPath, ['-e', 'process.stderr.write("fixture")']).stderr, 'fixture')
})

test('до импорта сертификата hook отказывает без credentials; Windows не требует Apple', async () => {
  const mac = context()
  Object.defineProperty(mac.packager, 'codeSigningInfo', { get() { assert.fail('импортировать сертификат ещё нельзя') } })
  await assert.rejects(beforePack(mac, {}), /CSC_LINK/)
  await beforePack({ electronPlatformName: 'win32' }, {}, () => assert.fail('Windows вызвал signing tool'))
  await artifactBuildCompleted({ target: { name: 'nsis' } }, {}, () => assert.fail('Windows вызвал signing tool'))
})

test('guard запрещает ad-hoc, отключённый runtime/notarization и прямую публикацию', () => {
  validateReleaseConfig(config(), 'never')
  for (const change of [{ identity: '-' }, { identity: null }, { notarize: false }, { hardenedRuntime: false },
    { forceCodeSigning: false }, { type: 'development' }, { signIgnore: ['pty.node'] }]) {
    const invalid = config()
    Object.assign(invalid.mac, change)
    assert.throws(() => validateReleaseConfig(invalid, 'never'))
  }
  for (const publish of [undefined, 'always', 'onTag']) assert.throws(() => validateReleaseConfig(config(), publish))
  const invalid = config()
  invalid.dmg.writeUpdateInfo = true
  assert.throws(() => validateReleaseConfig(invalid, 'never'), /metadata/)
})

test('keychain должен содержать Developer ID ожидаемой Team; Apple Development не подходит', async () => {
  const listing = `1) ${'A'.repeat(40)} "${identity}"\n 1 valid identities found`
  assert.equal(selectIdentity(listing, team).name, identity)
  for (const invalid of ['', listing.replace(team, 'OTHER12345'), listing.replace('Developer ID Application:', 'Apple Development:'), `${listing}\n${listing}`]) {
    assert.throws(() => selectIdentity(invalid, team), /Developer ID/)
  }
  await beforePack(context(), credentials, (file, args) => {
    assert.equal(file, '/usr/bin/security')
    assert.equal(args.at(-1), '/fixture/temporary.keychain')
    return success(listing)
  })
  await assert.rejects(beforePack(context(), credentials, () => success(listing.replace(team, 'OTHER12345'))), /Developer ID/)
})

test('целая ad-hoc подпись, чужая Team, отсутствие runtime или timestamp не проходят', () => {
  assert.equal(validateSignature(signature, team), identity)
  for (const output of ['Signature=adhoc\nTeamIdentifier=not set\n', signature.replaceAll(team, 'OTHER12345'),
    signature.replace('runtime', ''), signature.replace('Timestamp=', 'Signed Time='), signature.replace('Sep 25, 2026', 'none')]) {
    assert.throws(() => validateSignature(output, team))
  }
  validateSignature(signature.replace('runtime', ''), team, { runtime: false })
})

test('локальный профиль доступен без credentials, но запрещён в CI и при publish', () => {
  localBeforePack(context(), {})
  assert.throws(() => localBeforePack(context(), { CI: 'true' }), /CI/)
  assert.throws(() => localBeforePack(context(), { GITHUB_ACTIONS: 'true' }), /CI/)
  const local = context()
  local.packager.info.options.publish = 'always'
  assert.throws(() => localBeforePack(local, {}), /publish never/)
})

test('оба конфига и hooks совместимы с установленным builder 26.15.3', async () => {
  const require = builderRequire()
  assert.equal(require('app-builder-lib/package.json').version, '26.15.3', 'обновление builder требует повторной проверки DMG metadata и hooks')
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config')
  const { resolveFunction } = require('app-builder-lib/out/util/resolve')
  for (const name of ['electron-builder.yml', 'electron-builder.local.yml']) {
    const effective = await getConfig(desktop, name)
    await validateConfiguration(effective, { isEnabled: false })
    const hook = await resolveFunction(undefined, resolve(desktop, effective.beforePack), 'beforePack', root)
    assert.equal(typeof hook, 'function')
    if (name.includes('.local.')) {
      assert.equal(effective.mac.identity, '-')
      assert.equal(effective.mac.notarize, false)
      assert.equal(effective.artifactBuildCompleted, null)
      assert.equal(effective.directories.output, 'release/local')
    } else {
      validateReleaseConfig(effective, 'never')
      assert.equal(await resolveFunction(undefined, resolve(desktop, effective.artifactBuildCompleted), 'artifactBuildCompleted', root), artifactBuildCompleted)
    }
  }
})

test('реальный CLI builder запрещает macOS-упаковку на Windows, иначе отказывает без credentials', () => {
  const require = createRequire(join(desktop, 'package.json'))
  const cli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js')
  const env = { ...process.env, CI: 'true' }
  for (const name of Object.keys(env)) if (/^(CSC_|APPLE_|GH_TOKEN|GITHUB_TOKEN)/.test(name)) delete env[name]
  const result = spawnSync(process.execPath, [cli, '--mac', '--dir', '--publish', 'never'], { cwd: desktop, env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  // На Windows builder отклоняет платформу до beforePack; guard credentials
  // дополнительно проверяется напрямую на всех ОС и через CLI на macOS/Linux.
  assert.match(result.stdout + result.stderr, process.platform === 'win32'
    ? /Build for macOS is supported only on macOS/
    : /не задан CSC_LINK/)
  assert.doesNotMatch(result.stdout + result.stderr, /packaging\s+platform=darwin|notarization successful/)
})

function notaryStub(calls, { status = 'Accepted', exit = 0, stapleFailure = false, validateFailure = false } = {}) {
  return (file, args) => {
    calls.push([file, args])
    if (args[0] === 'notarytool' && args[1] === 'submit') return { status: exit,
      stdout: JSON.stringify({ id: '00000000-0000-0000-0000-000000000001', status }), stderr: '' }
    if (args[0] === 'notarytool') return success('{"issues":[]}')
    if (stapleFailure && args[1] === 'staple') throw new Error('stapler failed')
    if (validateFailure && args[1] === 'validate') throw new Error('stapler validate failed')
    if (args[0] === '--display') return success('', signature)
    return success()
  }
}

test('DMG: timestamp → submit Accepted → staple → validate; лог сохраняется', async t => {
  const directory = temporary(t)
  const calls = []
  const event = { ...context(), target: { name: 'dmg' }, file: join(directory, 'orca-board-1.0.0-arm64.dmg'), isWriteUpdateInfo: false, updateInfo: null }
  await artifactBuildCompleted(event, credentials, notaryStub(calls))
  const signed = calls.findIndex(([, args]) => args.includes('--timestamp'))
  const submit = calls.findIndex(([, args]) => args[1] === 'submit')
  const staple = calls.findIndex(([, args]) => args[1] === 'staple')
  const validate = calls.findIndex(([, args]) => args[1] === 'validate')
  assert.ok(signed >= 0 && signed < submit && submit < staple && staple < validate)
  assert.equal(JSON.parse(readFileSync(join(directory, 'notarization/orca-board-1.0.0-arm64.dmg.json'))).status, 'Accepted')
  await assert.rejects(artifactBuildCompleted({ ...event, isWriteUpdateInfo: true }, credentials, () => assert.fail()), /metadata/)
})

test('Invalid, ошибка submit, отсутствие JSON и ошибка stapler прерывают выпуск', t => {
  for (const options of [{ status: 'Invalid' }, { status: 'In Progress' }, { exit: 1 }, { stapleFailure: true }]) {
    const calls = []
    assert.throws(() => notarizeDmg(join(temporary(t), 'fixture.dmg'), credentials, notaryStub(calls, options)))
    if (!options.stapleFailure) assert.ok(!calls.some(([, args]) => args[0] === 'stapler'))
    assert.ok(!calls.some(([, args]) => args[1] === 'validate'))
  }
  assert.throws(() => notarizeDmg(join(temporary(t), 'fixture.dmg'), credentials, () => success('not json')), /JSON/)
  assert.throws(() => notarizeDmg(join(temporary(t), 'fixture.dmg'), credentials, notaryStub([], { validateFailure: true })), /stapler validate/)
})

function metadataFixture(t) {
  const directory = temporary(t)
  const files = ['arm64', 'x64'].map(arch => {
    const url = `orca-board-1.0.0-${arch}.zip`
    writeFileSync(join(directory, url), arch)
    writeFileSync(join(directory, `${url}.blockmap`), 'blockmap')
    writeFileSync(join(directory, url.replace('.zip', '.dmg')), 'stapled dmg')
    return { url, size: Buffer.byteLength(arch), sha512: createHash('sha512').update(arch).digest('base64') }
  })
  const manifest = { version: '1.0.0', files, path: files[1].url, sha512: files[1].sha512 }
  const save = () => writeFileSync(join(directory, 'latest-mac.yml'), JSON.stringify(manifest))
  save()
  return { directory, manifest, save }
}

test('metadata привязаны к финальным ZIP; DMG stapling не портит их', t => {
  const { directory } = metadataFixture(t)
  verifyUpdateMetadata(directory, '1.0.0')
  writeFileSync(join(directory, 'orca-board-1.0.0-arm64.dmg'), 'new stapled bytes')
  verifyUpdateMetadata(directory, '1.0.0')
  writeFileSync(join(directory, 'orca-board-1.0.0-arm64.zip'), 'changed zip')
  assert.throws(() => verifyUpdateMetadata(directory, '1.0.0'), /SHA-512\/size/)
})

test('отклоняются устаревшие хеши/размеры, DMG metadata и неполный комплект', t => {
  for (const mutate of [
    f => { f.manifest.files[0].sha512 = 'old' }, f => { f.manifest.files[0].size++ },
    f => { f.manifest.sha512 = 'old' }, f => { f.manifest.path = '../other.zip' },
    f => { f.manifest.files[0].url = 'orca-board-1.0.0-arm64.dmg' },
    f => { f.manifest.files.pop() }, f => { f.manifest.files[0] = f.manifest.files[1] },
    f => writeFileSync(join(f.directory, 'orca-board-1.0.0-arm64.dmg.blockmap'), 'old'),
    f => rmSync(join(f.directory, 'orca-board-1.0.0-x64.zip.blockmap'))
  ]) {
    const fixture = metadataFixture(t)
    mutate(fixture)
    fixture.save()
    assert.throws(() => verifyUpdateMetadata(fixture.directory, '1.0.0'))
  }
})

function appFixture(t) {
  const app = join(temporary(t), 'orca-board.app')
  for (const path of ['Contents/MacOS/orca-board', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    'Contents/Frameworks/libEGL.dylib',
    'Contents/Frameworks/orca-board Helper.app/Contents/MacOS/orca-board Helper', 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper']) {
    mkdirSync(dirname(join(app, path)), { recursive: true })
    writeFileSync(join(app, path), Buffer.from('cffaedfe', 'hex'))
  }
  return app
}

const jitEntitlements = JSON.stringify({ 'com.apple.security.cs.allow-jit': true })

function appCommands({ failure = '', entitlements } = {}) {
  return (file, args, options) => {
    if (file.endsWith('PlistBuddy')) return success(args[1].includes('Identifier') ? 'dev.orca-board' : args[1].includes('Version') ? '1.0.0' : 'orca-board')
    if (file.endsWith('lipo')) return success(failure === 'arch' ? 'arm64' : 'x86_64')
    if (args.includes('--entitlements')) return success(entitlements ? entitlements(args.at(-1)) :
      JSON.stringify({ 'com.apple.security.cs.allow-jit': failure !== 'jit', 'com.apple.security.get-task-allow': failure === 'debug' }))
    // На macOS используем настоящий парсер; на остальных ОС пустой/повреждённый ввод тоже обязан падать.
    if (file.endsWith('plutil')) return process.platform === 'darwin' ? run(file, args, options) : success(JSON.stringify(JSON.parse(options.input)))
    if (file.endsWith('spctl')) return failure === 'spctl' ? { status: 3, stdout: '', stderr: 'rejected' } : success('', 'accepted\nsource=Notarized Developer ID')
    if (args[0] === '--display' && args[1] === '--verbose=4') return success('', failure === 'native' && args.at(-1).endsWith('pty.node') ? 'Signature=adhoc' : signature)
    if (file.endsWith('xcrun') && failure === 'ticket') throw new Error('ticket отсутствует')
    return success()
  }
}

test('проверка вложенного native-кода, entitlements, Gatekeeper и ticket не заменяется codesign verify', t => {
  const app = appFixture(t)
  verifyApp(app, 'x64', '1.0.0', team, appCommands())
  for (const failure of ['arch', 'debug', 'jit', 'spctl', 'native', 'ticket']) assert.throws(() => verifyApp(app, 'x64', '1.0.0', team, appCommands({ failure })))
  assert.throws(() => verifyDmg('/fixture.dmg', team, appCommands({ failure: 'spctl' })), /проверка не пройдена/)
  for (const key of ['get-task-allow', 'com.apple.security.get-task-allow', 'com.apple.security.app-sandbox']) {
    assert.throws(() => validateEntitlements({ [key]: true }), /entitlement/)
  }
})

test('пустые entitlements библиотек Framework/dylib/node не блокируют проверку приложения', t => {
  const app = appFixture(t)
  verifyApp(app, 'x64', '1.0.0', team, appCommands({ entitlements: path =>
    path.includes(`.framework${sep}`) || path.endsWith('.dylib') || path.endsWith('.node') ? '' : jitEntitlements }))
})

test('основной Electron executable и helpers по-прежнему требуют allow-jit', t => {
  const app = appFixture(t)
  for (const target of [app, join(app, 'Contents/MacOS/orca-board'),
    join(app, 'Contents/Frameworks/orca-board Helper.app/Contents/MacOS/orca-board Helper')]) {
    for (const missing of ['', '{}', JSON.stringify({ 'com.apple.security.cs.allow-jit': false })]) {
      assert.throws(() => verifyApp(app, 'x64', '1.0.0', team,
        appCommands({ entitlements: path => path === target ? missing : jitEntitlements })), /allow-jit/)
    }
  }
})

test('непустые запрещённые или повреждённые entitlements библиотек отклоняются', t => {
  const app = appFixture(t)
  for (const forbidden of ['get-task-allow', 'com.apple.security.get-task-allow', 'com.apple.security.app-sandbox']) {
    assert.throws(() => verifyApp(app, 'x64', '1.0.0', team,
      appCommands({ entitlements: path => path.endsWith('pty.node') ? JSON.stringify({ [forbidden]: true }) : jitEntitlements })), /entitlement/)
  }
  assert.throws(() => verifyApp(app, 'x64', '1.0.0', team,
    appCommands({ entitlements: path => path.endsWith('.dylib') ? 'invalid plist' : jitEntitlements })))
  const execute = appCommands()
  assert.throws(() => verifyApp(app, 'x64', '1.0.0', team, (file, args, options) => {
    if (args.includes('--entitlements') && args.at(-1).endsWith('.dylib')) throw new Error('codesign failed')
    return execute(file, args, options)
  }), /codesign failed/)
})

test('macOS: verifyApp читает entitlements подписанной dylib настоящими codesign/plutil', { skip: process.platform !== 'darwin' }, t => {
  const app = appFixture(t)
  const library = join(app, 'Contents/Frameworks/libEGL.dylib')
  run('/usr/bin/xcrun', ['clang', '-dynamiclib', '-x', 'c', '-', '-o', library], { input: 'int fixture(void) { return 0; }\n' })
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements',
    join(desktop, 'build/entitlements.mac.inherit.plist'), library])
  const execute = appCommands()
  verifyApp(app, 'x64', '1.0.0', team, (file, args, options) => {
    if (args.includes('--entitlements') && args.at(-1) === library) return run(file, args, options)
    return execute(file, args, options)
  })
})

test('CI не загружает установщики до проверки macOS; Apple secrets ограничены mac-шагом', () => {
  const workflow = readYaml(join(root, '.github/workflows/release.yml'))
  const steps = workflow.jobs.package.steps
  const mac = steps.find(step => step.env?.CSC_LINK)
  assert.equal(mac.if, "matrix.platform == 'mac'")
  assert.match(mac.run, /electron-builder --mac --publish never\s+node scripts\/verify-macos-release.mjs/)
  const upload = steps.find(step => step.with?.name === 'installers-${{ matrix.platform }}')
  assert.ok(steps.indexOf(mac) < steps.indexOf(upload))
  assert.equal(upload.if, undefined, 'upload должен зависеть от успеха всех предыдущих шагов')
  assert.equal(workflow.permissions.contents, 'read')
  assert.deepEqual(workflow.jobs.draft.needs, ['validate', 'package'])
  assert.ok(!config().forceCodeSigning, 'mac forceCodeSigning не должен требовать Windows certificate')
})

const releaseWorkflow = () => readYaml(join(root, '.github/workflows/release.yml'))
const validationJob = () => releaseWorkflow().jobs['macos-validation']

// Выполняем выражения из YAML на таблице событий. Это ограниченный контракт workflow,
// а не эмулятор Actions: неизвестные конструкции должны потребовать обновления проверки.
function condition(expression, github, succeeded = true) {
  const source = (expression ?? 'success()').replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const evaluate = new Function('github', 'startsWith', 'success', 'failure', 'always', `return (${source})`)
  return Boolean(evaluate(github, (value, prefix) => value.startsWith(prefix), () => succeeded, () => !succeeded, () => true))
}

test('manual/tag: dispatch никогда не достигает release jobs и токена записи', () => {
  const workflow = releaseWorkflow()
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch'])
  assert.deepEqual(workflow.on.push, { tags: ['v*'] })
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.required, true)
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.type, 'string')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(validationJob().permissions, { contents: 'read' })
  assert.equal(validationJob().needs, undefined)
  for (const event_name of ['workflow_dispatch', 'push', 'pull_request']) {
    for (const ref of ['refs/heads/feature/signing', 'refs/heads/develop', 'refs/heads/master', 'refs/tags/v1.0.1', 'refs/tags/other']) {
      const github = { event_name, ref }
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const enabled = condition(job.if, github)
        assert.equal(enabled, name === 'macos-validation' ? event_name === 'workflow_dispatch' :
          event_name === 'push' && ref === 'refs/tags/v1.0.1', `${event_name} ${ref}: ${name}`)
        if (event_name === 'workflow_dispatch' && enabled) assert.deepEqual(job.permissions ?? workflow.permissions, { contents: 'read' })
      }
    }
  }
})

test('validation: только шаг подписи получает пять secrets; подготовка и upload без credentials', () => {
  const workflow = releaseWorkflow()
  assert.equal(workflow.env, undefined)
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.env, undefined)
    const secretSteps = job.steps.filter(step => JSON.stringify(step).includes('secrets.'))
    assert.equal(secretSteps.length, ['macos-validation', 'package'].includes(name) ? 1 : 0)
    for (const step of secretSteps) {
      assert.deepEqual(step.env, Object.fromEntries(Object.keys(credentials).map(key => [key, '${{ secrets.' + key + ' }}'])))
      assert.match(step.run, /electron-builder --mac --publish never\s+node scripts\/verify-macos-release.mjs/)
    }
  }
  const job = validationJob()
  assert.equal(job['runs-on'], 'macos-14')
  const steps = job.steps
  const guard = steps.findIndex(step => step.id === 'validation-ref')
  const checkout = steps.findIndex(step => step.uses?.startsWith('actions/checkout@'))
  const head = steps.findIndex(step => step.id === 'validation-checkout')
  const setup = steps.findIndex(step => step.uses?.startsWith('actions/setup-node@'))
  const install = steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile')
  const build = steps.findIndex(step => step.run === 'pnpm build')
  const sign = steps.findIndex(step => step.id === 'validation-sign')
  const sums = steps.findIndex(step => step.id === 'validation-checksums')
  assert.ok(guard === 0 && guard < checkout && checkout < head && head < setup && setup < install && install < build && build < sign && sign < sums)
  assert.equal(steps[checkout].with.ref, '${{ github.sha }}')
  assert.equal(steps[checkout].with['persist-credentials'], false)
  assert.equal(steps[guard].env.EXPECTED_SHA, '${{ inputs.expected_sha }}')
  assert.equal(steps[setup].with['node-version-file'], '.nvmrc')
  assert.equal(readFileSync(join(root, '.nvmrc'), 'utf8').trim(), '24')
  assert.match(JSON.parse(readFileSync(join(root, 'package.json'))).packageManager, /^pnpm@\d+\.\d+\.\d+$/)
  assert.ok(steps.some(step => step.uses?.startsWith('pnpm/action-setup@')))
  for (const step of steps) {
    assert.equal(step['continue-on-error'], undefined)
    if (step.run) assert.equal(step.if, undefined, 'ни одну обязательную проверку нельзя пропустить')
  }
  assert.equal(job['continue-on-error'], undefined)
  assert.deepEqual(config().mac.target, [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }])
})

// Shell этих шагов — bash на macOS runner; контракт YAML выше проверяется на всех ОС.
test('настоящий guard отклоняет тег/master/orca, короткий или неверный SHA и подменённый checkout', { skip: process.platform === 'win32' }, t => {
  const cwd = temporary(t)
  for (const args of [['init'], ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim()
  const env = { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch',
    GITHUB_REF: 'refs/heads/feature/signing', GITHUB_SHA: sha, EXPECTED_SHA: sha }
  const guard = validationJob().steps.find(step => step.id === 'validation-ref').run
  const head = validationJob().steps.find(step => step.id === 'validation-checkout').run
  const execute = (script, override) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd, env: { ...env, ...override }, encoding: 'utf8' })
  for (const ref of ['refs/heads/feature/signing', 'refs/heads/feature/nested/signing', 'refs/heads/develop']) {
    assert.equal(execute(guard, { GITHUB_REF: ref }).status, 0)
  }
  for (const invalid of [{ GITHUB_REF: 'refs/heads/master' }, { GITHUB_REF: 'refs/heads/orca/task' },
    { GITHUB_REF: 'refs/tags/v1.0.0', GITHUB_REF_TYPE: 'tag' }, { GITHUB_REF: 'refs/heads/feature/' },
    { GITHUB_REF: 'refs/heads/feature/a..b' }, { GITHUB_REF_TYPE: 'tag' }, { GITHUB_EVENT_NAME: 'push' },
    { EXPECTED_SHA: '' }, { EXPECTED_SHA: sha.slice(0, 7) }, { EXPECTED_SHA: 'f'.repeat(40) },
    { EXPECTED_SHA: 'g'.repeat(40) }, { EXPECTED_SHA: `${sha}\n` }, { EXPECTED_SHA: '$(exit 0)' }]) {
    assert.notEqual(execute(guard, invalid).status, 0, JSON.stringify(invalid))
  }
  assert.equal(execute(head, {}).status, 0)
  assert.notEqual(execute(head, { GITHUB_SHA: 'f'.repeat(40) }).status, 0)
})

test('ошибка builder/verifier блокирует upload установщиков; диагностика доступна отдельно', { skip: process.platform === 'win32' }, () => {
  const steps = validationJob().steps
  const sign = steps.find(step => step.id === 'validation-sign')
  const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(uploads.length, 2)
  for (const [builderExit, verifierExit] of [[0, 0], [23, 0], [0, 24]]) {
    // Запускаем именно shell из workflow; функции заменяют только внешние команды.
    const script = `pnpm() { printf 'builder:%s\\n' "$*"; return ${builderExit}; }\nnode() { printf 'verifier:%s\\n' "$*"; return ${verifierExit}; }\n${sign.run}`
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { encoding: 'utf8' })
    assert.equal(result.status, builderExit || verifierExit, result.stderr)
    assert.match(result.stdout, /builder:--filter @orca-board\/desktop exec electron-builder --mac --publish never/)
    assert.equal(result.stdout.includes('verifier:scripts/verify-macos-release.mjs'), builderExit === 0)
    const enabled = uploads.filter(step => condition(step.if, {}, result.status === 0))
    assert.equal(enabled.length, 1)
    assert.equal(enabled[0].with.name.includes('notarization'), result.status !== 0)
  }
  const installers = uploads.find(step => !step.with.name.includes('notarization'))
  assert.ok(steps.indexOf(installers) > steps.findIndex(step => step.id === 'validation-checksums'))
  assert.equal(condition(installers.if, {}, false), false, 'ошибка checksums тоже запрещает upload')
  assert.equal(installers.with['if-no-files-found'], 'error')
  assert.match(installers.with.name, /validation-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}/)
  const diagnostic = uploads.find(step => step.with.name.includes('notarization'))
  assert.deepEqual(diagnostic.with.path.trim().split('\n').sort(), ['arm64', 'x64'].flatMap(arch =>
    ['json', 'log'].map(ext => `apps/desktop/release/notarization/orca-board-*-${arch}.dmg.${ext}`)).sort())
})

test('validation хеширует только полный финальный комплект; upload использует тот же закрытый список', t => {
  const fixture = metadataFixture(t)
  const cwd = temporary(t)
  const desktop = join(cwd, 'apps/desktop')
  mkdirSync(desktop, { recursive: true })
  const directory = join(desktop, 'release')
  cpSync(fixture.directory, directory, { recursive: true })
  writeFileSync(join(desktop, 'package.json'), '{"version":"1.0.0"}')
  writeFileSync(join(directory, 'private.p12'), 'не должно попасть в артефакт')
  const steps = validationJob().steps
  const script = steps.find(step => step.id === 'validation-checksums').run
  // Исполняем тело Node из YAML, заменяя лишь путь к модулю проекта для временного cwd.
  const source = script.match(/node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/)?.[1]
  assert.ok(source)
  const code = source.replace("'./scripts/macos-release.mjs'", JSON.stringify(pathToFileURL(join(root, 'scripts/macos-release.mjs')).href))
  const output = join(cwd, 'output')
  const execute = () => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output }
  })
  const expected = ['latest-mac.yml', ...['arm64', 'x64'].flatMap(arch =>
    ['dmg', 'zip', 'zip.blockmap'].map(ext => `orca-board-1.0.0-${arch}.${ext}`))].sort()
  const verifySums = () => {
    const lines = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n')
    assert.deepEqual(lines.map(line => line.slice(66)).sort(), expected)
    for (const line of lines) assert.equal(line.slice(0, 64), createHash('sha256').update(readFileSync(join(directory, line.slice(66)))).digest('hex'))
  }
  assert.equal(execute().status, 0)
  verifySums()
  const before = readFileSync(join(directory, 'SHA256SUMS'), 'utf8')
  writeFileSync(join(directory, 'orca-board-1.0.0-arm64.dmg'), 'байты после stapling')
  assert.equal(execute().status, 0)
  verifySums()
  assert.notEqual(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), before)
  assert.match(readFileSync(output, 'utf8'), /^version=1.0.0\n/)
  const upload = steps.find(step => step.with?.name?.startsWith('macos-validation-${{'))
  const paths = upload.with.path.trim().split('\n').map(path => path.replace('${{ steps.validation-checksums.outputs.version }}', '1.0.0'))
  assert.deepEqual(paths.sort(), [...expected, 'SHA256SUMS'].map(file => `apps/desktop/release/${file}`).sort())
  rmSync(join(directory, 'orca-board-1.0.0-x64.zip.blockmap'))
  assert.notEqual(execute().status, 0, 'неполный комплект не должен получить успешный checksum-шаг')
})
