# Web W1: сервер и авторизация — Implementation Plan

> Состояние 05.10.2026: W1–W6 выполнены; актуальные результаты — в таблице ниже и handoff.
> Последнее уточнение: независимые Desktop/Web версии и release workflows.
> Checklist W1 сохраняет исходный инженерный план; фактическое выполнение расширено пользователем,
> тестовая последовательность переопределена его просьбой проверять основные suites в конце.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Запустить отдельный Web host с входом операторов и существующим typed HTTP API одного общего runtime.

**Architecture:** `apps/web` добавляет configuration/accounts/session и HTTP router, а `apps/headless` остаётся единственным Node bootstrap native/resources/profile. Operator handler выделяется из существующего private listener и обслуживает оба входа без копии business commands. Browser principal задаёт Web host, приватный endpoint сохраняется для будущего CLI.

**Tech Stack:** Node.js 24, TypeScript strict, node:http, node:crypto.scrypt, esbuild, pnpm 10.33.0; существующие contracts/runtime/client/headless.

**Spec:** [Утверждённая спецификация Web](../specs/2026-10-04-orca-web-self-hosted-design.md), включая уточнение об общем выпуске Desktop/Web.

## Фактическое выполнение 04.10.2026

Пользователь расширил поручение до всех W1–W6 и попросил основные тесты в конце.
Этот исходный подробный план W1 сохранён как утверждённый срез, включая RED-шаги,
которые по прямому указанию пользователя не выполнялись на каждом этапе. Текущий
беклог и результаты — [handoff](../../orca-development-handoff.md#состояние-web-после-w1w6)
и [установка Web](../../web.md). Implementation W1–W6 завершён; ручная GUI-приёмка,
выбор сервера/DNS и публичный выпуск остаются отдельными действиями.

| Рубеж | Выполнено | Проверка |
| --- | --- | --- |
| W1 | общий handler/headless, config/accounts/session/auth | security tests, installed owner/restart |
| W2 | общий typed UI client, browser login/project picker | client regression/i18n/types, static UI audit |
| W3 | long polling/cursor recovery, chat resync, writer leases | disconnect/replay tests, настоящий native PTY |
| W4 | upload, image/attachment/doc/showcase download, отдельный preview | installed binary/path/CSP smoke |
| W5 | Linux bundle Node/native, installer/TTY wizard, systemd/Caddy | Ubuntu 24.04 install/CLI/TTY, systemd-analyze/Caddy validate |
| W6 | browser update/backup/rollback/recovery и независимый Web workflow | owner/rollback tests, release guards/workflow fixtures |

Итоговое отдельное ревью выполнено; подтверждённые ошибки исправлены. Проверено
4105 тестов, все typechecks/builds и frozen lockfile. Полная цепочка verify доведена
после исправления старого workflow assertion; неизменённые suites не повторялись.
Локальный Desktop собран и открыт; автоматического обхода GUI не было.

## Global Constraints

- База `57f6d1b`, назначенный worktree `.worktrees/web-self-hosted`, ветка `feature/web-self-hosted`; не работать в root/develop/master.
- Backend не извлекается повторно: общий фундамент A–F завершён. Один physical profile — один owner до backup/migrations.
- Node.js 24; pnpm 10.33.0. Новых внешних production dependencies нет; использовать уже закреплённый esbuild 0.28.2.
- Runtime без Electron/Desktop; contracts/client/UI browser-safe; TypeScript strict, без `any` и `as any`.
- `apps/web/package.json` private, версия 2.0.0 как текущие root/Desktop; существующие версии и release tags не менять.
- Desktop/Web имеют целевой общий выпуск `vX.Y.Z`, но переход release guards/workflow выполняется в W6. В W1 нет release/tag/publication.
- Linux x64 Ubuntu 24.04 — первый installed target. В W1 проверяется host локально на macOS и в существующем CI, без заявления о готовом установщике.
- Рабочие данные и credentials не берутся из живого Desktop userData. Development/test config/profile находятся в явно заданных временных каталогах.
- Локальные defaults: app origin `http://localhost:3737`, listener `127.0.0.1:3737`; private operator endpoint остаётся на отдельном случайном loopback port.
- Scrypt: N=32768, r=8, p=1, key length 64 bytes, maxmem 64 MiB, random salt 16 bytes; одновременно не более двух вычислений.
- Пароль: минимум 12 Unicode code points, максимум 256 bytes UTF-8, введённая строка не нормализуется.
- Sessions: TTL 12 часов, idle 30 минут, максимум 64; login body 16 KiB, operator JSON 64 KiB, attachment limits из core.
- Не более 5 failed/in-flight login attempts за 60 секунд на remote address; bounded registry и hash admission без неограниченной очереди.
- Credentials не выдаются в metadata, errors, health, URL или logs. UI и installer W2–W6 не имитируются заглушками.
- Comments/docs/commits — на русском; агентский JS CLI и его HELP не меняются.

## Review Focus

- Повреждённый auth/config file, symlink или слишком широкие POSIX permissions: startup отказывает до открытия доступа и не исправляет/перезаписывает файл молча (Task 3).
- Неизвестный username и много параллельных login requests: одинаковая ошибка входа, bounded hash work/limiter, секреты отсутствуют в ответах (Task 4).
- Несколько вкладок и две сессии одного пользователя с одинаковым tab label: разные namespaces; logout отзывает только свою сессию и освобождает её writer без kill (Tasks 1, 4, 5).
- Duplicate Host/Cookie headers, поддельный forwarded header и login CSRF: запрос не получает/не продлевает сессию и не выполняет mutation (Task 4).
- Занятый port, одновременный startup/stop и cleanup failure: один owner, закрытый ingress и возможность повторить cleanup без преждевременного освобождения профиля (Tasks 2, 5).

## Область W1 и последующие рубежи

Этот план реализует только W1. Проверяемый результат — локальный backend с реальным
входом и общим operator API, без React страницы. W2 добавляет login UI, общий typed
UI adapter, server picker и root policy до доступности project registration в Web.
W3 — streams/reconnect, W4 — file/preview adapter, W5 — удобный Linux installer,
W6 — update/backup/rollback и общий выпуск Desktop/Web.

W1 хранит projectRoots в config для последующего picker. До W2 Web authorizer
отклоняет `profile.addProject` и `profile.detectTaskType`, поскольку server root
policy ещё не подключена. Остальные доступные методы используют прежние runtime
guards. Приватный локальный operator endpoint сохраняет прежнее поведение.
Первый профиль W1 создаётся отдельно; Web ещё не поставляется для internet deployment.

## Карта файлов

| Файлы | Ответственность |
| --- | --- |
| `packages/runtime/src/operator-http.ts`, `operator-endpoint.ts`, `index.ts` | Один переиспользуемый handler; прежний private listener |
| `packages/runtime/test/operator-endpoint.test.ts`, `operator-http.test.ts` | Совместимость и независимые authenticated clients |
| `apps/headless/src/index.ts`, `scripts/smoke-headless-artifact.mjs` | Trusted host options без копии resource/native bootstrap |
| `apps/web/package.json`, `tsconfig.json`, `build.mjs`, `pnpm-lock.yaml` | Новый private workspace и server artifact |
| `apps/web/src/server/config.ts`, `accounts.ts`, `admin.ts` | Валидация config, password records, локальная инициализация аккаунта |
| `apps/web/src/server/sessions.ts`, `login-limits.ts`, `http.ts` | Sessions, bounded login, browser HTTP security |
| `apps/web/src/server/index.ts`, `start.ts` | Composition, listener, startup/shutdown |
| `apps/web/test/*.test.ts`, `apps/web/test/support/runtime.ts` | Auth и integration в disposable profile с test PTY factory |
| `scripts/installed-node-artifact.mjs`, `test-web-artifact.mjs`, `smoke-web-artifact.mjs` | Проверка собранного server artifact под Node24 вне workspace |
| README/CONTRIBUTING/CLAUDE, architecture/shared-foundation/handoff | Только фактически готовый W1 и следующие рубежи |

---

### Task 1: Выделить operator handler из private listener

**Files:** Create `packages/runtime/src/operator-http.ts`, `packages/runtime/test/operator-http.test.ts`; Modify `packages/runtime/src/operator-endpoint.ts`, `packages/runtime/src/index.ts`, `packages/runtime/test/operator-endpoint.test.ts`.

**Interfaces:**

- `OperatorHttpOptions` сохраняет runtime/token/maxClients/authenticate из нынешнего `startOperatorEndpoint`.
- `OperatorHttpHandler`: `handle(request: IncomingMessage, response: ServerResponse): void`, `detach(context: ClientCommandContext): void`, `stop(): Promise<void>`.
- `createOperatorHttpHandler(options: OperatorHttpOptions): OperatorHttpHandler` не создаёт listener.
- `startOperatorEndpoint(options: OperatorHttpOptions): Promise<{url: string; stop(): Promise<void>}>` сохраняет существующие loopback/token semantics.

- [ ] **Step 1: Написать failing integration tests для handler.** Смонтировать handler на test HTTP server и реальный runtime fixture. Проверить: hello/call/snapshot/events; duplicate mutation даёт один effect; forged actor отвергнут; тот же label другого actor не использует namespace первого; `detach(contextA)` закрывает observer/writer A, B остаётся подключён и PTY A жив. `stop()` повторно безопасен; handler после stop не принимает новые calls.

  Использовать assertions `assert.equal(reply.ok, true)`, `assert.equal(groups.length, 1)`, `assert.equal(sessions.isAlive(ptyId), true)` и `assert.equal(response.status, 401)`; fixtures/cleanup только в mkdtemp. Сохранить существующий endpoint suite как regression.

  Имя основного test: `HTTP detach освобождает writer одного principal без kill`.
  Проверяемые assertions внутри fixture:

  ```ts
  handler.detach(contextA)
  assert.equal(owner.value.leases.current(ptyId), null)
  assert.equal(owner.value.sessions.isAlive(ptyId), true)
  assert.equal(responseB.status, 200)
  ```

- [ ] **Step 2: Подтвердить RED.** Run `node --test packages/runtime/test/operator-http.test.ts`; expected missing нового exported handler. Проверить, что test не падает из-за fixture/setup.

- [ ] **Step 3: Перенести handler без изменения wire format.** Clients/uploads/writer/pending/pruning принадлежат handler. `detach` использует ту же validated actor/client hash функцию, что handle, освобождает subscriptions и writer; недоступные upload tickets остаются bounded и истекают по существующему TTL. Private wrapper владеет server и закрывает соединения перед ожиданием handler cleanup. Сохранить 32 pending, 8 clients default, 60 секунд idle prune, request timeout 30 секунд, headers timeout 10 секунд и maxHeadersCount=32.

- [ ] **Step 4: Проверить GREEN и runtime typecheck.** Run `node --test packages/runtime/test/operator-endpoint.test.ts packages/runtime/test/operator-http.test.ts` и `pnpm --filter @orca-board/runtime typecheck`; оба exit 0. Без полного повторного runtime suite на этом шаге.

- [ ] **Step 5: Проверить diff и закоммитить конкретные файлы.** Commit `refactor: выделить общий HTTP handler оператора`.

### Task 2: Расширить headless trusted host options

**Files:** Modify `apps/headless/src/index.ts`, `scripts/smoke-headless-artifact.mjs`; Test installed smoke, который уже запускается в Linux CI.

**Interfaces:**

- Export `HeadlessOptions`: существующие `dataDir`, `resourceDir?`, `warn?` плюс `product?: OperatorProduct` и `operatorAuthorize?: OrcaRuntimeOptions['authorize']`.
- Export `HeadlessHost = Awaited<ReturnType<typeof startHeadless>>`; `startHeadless(options: HeadlessOptions): Promise<HeadlessHost>` сохраняет runtime/endpoint/stop result.
- Итоговый runtime authorize допускает прежнего `operator/local-user` и дополнительного проверенного operator через `operatorAuthorize(context, command)`; дополнительный callback не разрешает agent/system actor.
- Metadata default остаётся orca-headless/manifest.version; Web override orca-web/2.0.0 не меняет installed resources.

- [ ] **Step 1: Добавить assertions в installed smoke.** Существующий первый startup остаётся default. На следующем startup передать Web product и authorizer для test account; проверить metadata и сохранение private local-user доступа. Непроверенный actor не получает command. В конце снова default start/stop подтверждает release owner и совместимость. Логи не содержат token.

  ```js
  assert.deepEqual(metadata.product, { name: 'orca-web', version: '2.0.0' })
  assert.equal(privateReply.ok, true)
  assert.equal(unverifiedReply.ok, false)
  ```

- [ ] **Step 2: Подтвердить RED на текущем build.** Run `pnpm --filter @orca-board/headless build`, затем `node scripts/test-headless-artifact.mjs`; ожидается несовпадение Web metadata. Native setup готовится существующим script в собственном temporary root.

- [ ] **Step 3: Добавить только trusted options.** Сохранить canonical dataDir, agent socket naming, private credential file 0600, resource/native loading и stop ordering. Записать tests для повторного stop и cleanup failure в Task 5; не вводить второй resource loader или отдельный daemon.

- [ ] **Step 4: Проверить GREEN.** Run `pnpm --filter @orca-board/headless typecheck`, rebuild headless и тот же installed smoke. Существующие native PTY/Git/CLI/owner checks остаются, дополнительных платных agent sessions нет.

- [ ] **Step 5: Проверить diff и закоммитить.** Commit `feat: подключить доверенные Web options к Node host`.

### Task 3: Configuration, аккаунты и локальная инициализация

**Files:** Create `apps/web/package.json`, `tsconfig.json`, `src/server/config.ts`, `accounts.ts`, `admin.ts`, `test/config.test.ts`, `accounts.test.ts`; Modify `pnpm-lock.yaml`. Build entrypoint появляется в Task 5 вместе с реальным server.

**Interfaces:**

```ts
interface WebConfig {
  schemaVersion: 1
  configDir: string
  dataDir: string
  projectRoots: string[]
  origin: string
  port: number
  mode: 'local' | 'proxy'
}
interface WebAccount {
  id: string
  login: string
  password: { algorithm: 'scrypt'; salt: string; hash: string;
    N: 32768; r: 8; p: 1; keyLength: 64 }
}
```

- `parseWebConfig(input: unknown): WebConfig`, `loadWebConfig(file: string): Promise<WebConfig>`; accounts file вычисляется как configDir/accounts.json, без отдельного browser path.
- `createWebAccount(login: string, password: string): Promise<WebAccount>`; random UUID id, login regex `^[a-z0-9][a-z0-9._-]{2,63}$`, salt/hash base64, параметры из Global Constraints.
- `verifyWebPassword(account: WebAccount, password: string): Promise<boolean>` использует scrypt и timingSafeEqual; unknown login проверяется через фиксированный dummy record того же алгоритма.
- `loadWebAccounts(file: string): Promise<readonly WebAccount[]>`; формат `{schemaVersion: 1, accounts: WebAccount[]}`, от 1 до 16 unique id/login, max file 64 KiB.
- `initializeWebAccount(options: {configDir: string; login: string; password: string}): Promise<void>` создаёт первый accounts.json без overwrite. `admin.ts` вызывает её через интерактивный prompt; пароль не принимается argv/env и не выводится.

- [ ] **Step 1: Добавить failing tests с точными boundaries.** Проверить config unknown schema/key, relative paths, origin userinfo/path/query/hash, порт 0/65536/NaN, local mode с non-local origin, proxy без https. Принять defaults 3737 и local localhost, proxy https. Account tests: correct/wrong password, 11/12 code points, >256 bytes, Unicode без нормализации, уникальные salt/id; malformed base64/hash parameters/duplicate users; повторная initialization не меняет файл. Symlink config/account и POSIX mode 0644 вместо 0600 дают отказ; permissions cases условны по платформе, остальные не skip.

  Основной password test:

  ```ts
  test('пароль сохраняет Unicode и не нормализуется', async () => {
    const password = 'a'.repeat(11) + '\u00e9'
    const account = await createWebAccount('ivan', password)
    assert.equal(await verifyWebPassword(account, password), true)
    assert.equal(await verifyWebPassword(account, 'a'.repeat(11) + 'e\u0301'), false)
    await assert.rejects(createWebAccount('ivan', 'a'.repeat(11)))
    await assert.rejects(createWebAccount('ivan', 'a'.repeat(257)))
  })
  ```

- [ ] **Step 2: Подтвердить RED.** Run `node --test apps/web/test/config.test.ts apps/web/test/accounts.test.ts`; expected отсутствующие modules.

- [ ] **Step 3: Реализовать config/accounts и private workspace.** Абсолютные paths; local origin hostname localhost; оба режима bind только 127.0.0.1. `port` 1..65535; tests используют отдельный listen override в Task 5. Config max 16 KiB, projectRoots 1..32 absolute directories, realpath при load; config/schema остаётся отдельной от profile store. Файлы 0600, directory 0700, final symlink/небезопасные POSIX permissions отвергаются. Initialization публикует полностью записанный временный файл без замены существующего accounts.json. Admin prompt скрывает password, корректно завершается по SIGINT/non-TTY и не оставляет echo выключенным.

  Package scripts `test: node --test test/*.test.ts`, `typecheck: tsc -p tsconfig.json`; server build/start/admin scripts добавляются в Task 5. Dependencies workspace headless/runtime/contracts, client для integration tests; devDeps существующие TS/@types/node/esbuild. Manifest private/2.0.0. После добавления workspace обновить lock через pnpm, не редактировать lock вручную.

- [ ] **Step 4: Проверить GREEN.** Run `pnpm --filter @orca-board/web test`, `pnpm --filter @orca-board/web typecheck`; exit 0. Проверить accounts file fixture без plain password. Prompt вручную проверяется только в disposable config directory, без изменения установленного профиля.

- [ ] **Step 5: Проверить diff и закоммитить.** Commit `feat: добавить конфигурацию и аккаунты Web host`.

### Task 4: Browser sessions и безопасный HTTP router

**Files:** Create `apps/web/src/server/sessions.ts`, `login-limits.ts`, `http.ts`, `test/sessions.test.ts`, `login-limits.test.ts`, `http.test.ts`; Test handler из Task 1.

**Interfaces:**

- `WebSession` хранит accountId, opaque token, csrfToken, createdAt/lastSeen; оба token — random 32 bytes base64url.
- `createWebSessions({now?, onRevoke}): WebSessions`; `create(accountId): WebSession`, `get(token, touch?): WebSession | null`, `revoke(token): void`, `prune(): void`, `stop(): void`. TTL/idle/capacity фиксированы; unknown/expired token не восстанавливается. `onRevoke(session)` вызывается один раз, в том числе при expiry/stop.
- `createLoginLimits({now?})` предоставляет `reserve(address): {success(): void; failure(): void} | null`; pending reservation занимает budget, success возвращает его, failure удерживает до конца sliding 60-second window. Не более 256 addresses; expired keys очищаются, заполненный registry отказывает новым keys. Separate hash admission — два active jobs, остальные сразу 429.
- `createWebRouter({config, accounts, sessions, operator, now?})` возвращает `handle(request, response): void`, `authenticateOperator(request: IncomingMessage): ClientCommandContext | null`, `revokeClients(session): void`, `stop(): Promise<void>`; `operator` — handler из Task 1. Router владеет bounded pending login jobs и map session→validated client contexts; он не реализует business commands. Handler authenticate callback делегирует `router.authenticateOperator`, вызываемый только после router construction, когда открыт listener. Session onRevoke вызывает `router.revokeClients` по тому же принципу; factory construction не запускает callbacks.
- `POST /auth/login` body `{login, password}` → `{user: {id, login}, csrfToken}` и Set-Cookie; `GET /auth/session` → те же public fields; `POST /auth/logout` → 204 и удаление cookie; `/health` GET → `{status: 'ready'}`. Все auth responses no-store, без account/hash records.
- Ошибки имеют общий transport shape `{error: {code}}`: 401 `web.authRequired` / `web.invalidCredentials`, 403 `command.forbidden` для Host/Origin/CSRF, 429 `protocol.capacity`, 400 `protocol.invalidInput`, 413 `protocol.packetTooLarge`. Wrong/unknown login возвращают одинаковый `web.invalidCredentials`; raw parse/crypto exceptions не возвращаются и не логируются.

- [ ] **Step 1: Написать failing session/limiter tests с injected clock.** Проверить 12h TTL и 30m idle boundaries, 65-я сессия отвергнута без eviction живой; restart registry не принимает старый token; revoke idempotent. Лимит: шестая failed/in-flight reservation за 60s отклонена, success возвращает budget, ровно после expiry запрос разрешён, active hash jobs ≤2, map ≤256.

  ```ts
  test('сессия истекает на границе idle 30 минут', () => {
    let now = 0
    const sessions = createWebSessions({ now: () => now, onRevoke: () => {} })
    const session = sessions.create('account-a')
    now = 30 * 60 * 1000 - 1
    assert.ok(sessions.get(session.token, false))
    now++
    assert.equal(sessions.get(session.token, false), null)
  })
  ```

- [ ] **Step 2: Написать failing HTTP security tests.** Wrong/unknown login одинаковый status/body; login body >16 KiB → 413; invalid JSON/types → 400; превышение login/hash limits → 429. Без cookie protected hello/events/upload/binary → 401. Cookie: HttpOnly, SameSite=Strict, Path=/, без Domain; local имя orca-web-session, proxy `__Host-orca-web-session` с Secure. Любой mutating route без exact Origin/CSRF → 403, включая logout; login требует Origin и application/json, но ещё не session CSRF. Host отсутствует/duplicate/не совпадает, duplicate session cookies, forged X-Forwarded-Host/Proto не дают доступ. Error/log body не содержит password/token/hash.

- [ ] **Step 3: Подтвердить RED.** Run `node --test apps/web/test/sessions.test.ts apps/web/test/login-limits.test.ts apps/web/test/http.test.ts`; падение в отсутствии новых modules, не timeout.

- [ ] **Step 4: Реализовать registry/router.** Local mode использует configured origin; proxy mode доверяет `X-Forwarded-Proto: https` только loopback peer и точному configured Host, `X-Forwarded-Host`/Forwarded не определяют origin. Проверять raw duplicate Host и неоднозначные session Cookie values. GET protected routes также проверяют supplied Origin и Host; отсутствие Origin у same-origin GET допустимо. Не выдавать credentialed CORS другим origin; OPTIONS не создаёт session. Неизвестные routes → 404 без static serving.

  Operator routes остаются `/hello`, `/call`, `/select`, `/subscribe`, `/snapshot`, `/events`, `/upload`, `/binary`, `/pty/write`, `/pty/resize`, `/session`: transport использует leading slash, `/api` prefix не вводить. После auth формировать `actor: {kind: 'operator', id: 'web:' + account.id}`, raw clientId как hash `[session.token, tabLabel]`; tab label 1..128 ASCII visible chars. Handler затем использует свою actor/client hashing. Request JSON не задаёт context/actor. На session максимум 8 distinct tab contexts, global operator maxClients=64; capacity → 409. Revocation вызывает operator.detach для всех contexts этой session, не stop runtime/PTY.

  CSRF header `x-orca-csrf` сравнивается с server session; security reject не продлевает idle. Timer prune 10 секунд unref; stopped router не запускает новые login/hash jobs, ждёт только ограниченные начатые. Max pending requests 32, auth request/headers timeouts 30s/10s, maxHeadersCount=32. Active login перед публикацией cookie повторно проверяет closing state.

- [ ] **Step 5: Проверить GREEN.** Run `pnpm --filter @orca-board/web test` и `pnpm --filter @orca-board/web typecheck`; exit 0. HTTP tests используют test server, не браузерный screen walk.

- [ ] **Step 6: Проверить diff и закоммитить.** Commit `feat: защитить Web API серверными сессиями`.

### Task 5: Composition, server artifact и интеграционная приёмка W1

**Files:** Create `apps/web/src/server/index.ts`, `start.ts`, `apps/web/build.mjs`, `test/host.test.ts`, `test/support/runtime.ts`, `scripts/installed-node-artifact.mjs`, `test-web-artifact.mjs`, `smoke-web-artifact.mjs`; Modify `apps/web/package.json`, `apps/headless/package.json` (source export для workspace), `scripts/test-headless-artifact.mjs`, `.github/workflows/ci.yml`, README/CONTRIBUTING/CLAUDE, `docs/architecture.md`, `shared-foundation.md`, `orca-development-handoff.md`, этот plan.

**Interfaces:**

- `StartWebOptions`: `config: WebConfig`, `resourceDir: string`, `warn?: OrcaRuntimeOptions['warn']`, `startHost?: typeof startHeadless`, `listenPort?: number` (0 допускается только явным programmatic test override).
- `startWeb(options: StartWebOptions): Promise<{url: string; host: HeadlessHost; stop(): Promise<void>}>`; import не открывает listener. Production startHost default — общий startHeadless.
- `start.ts` требует явный config file positional argument; `admin.ts` требует явный configDir для development initialization. Default installed paths/setup появятся с W5. Scripts `build`, `start`, `admin` указывают build.mjs/dist entrypoints; Node-native dependency находится в installed resourceDir.
- Installed index экспортирует также `createWebAccount` / `initializeWebAccount` для локального setup/smoke, не через HTTP. Shared test helper `testInstalledNodeArtifact(options: {artifactDir: string; smokeScript: string}): void` выделяется из нынешнего test-headless-artifact; оба wrapper сохраняют свой artifact directory и smoke, native install происходит только в owned temporary copy.

- [ ] **Step 1: Написать failing integration на общем runtime.** Test startHost factory создаёт реальный createOrcaRuntime с безопасным test PTY, приватным endpoint и переданным product/operatorAuthorize; не подменяет operator commands. Два аккаунта/две сессии одного аккаунта с одинаковым label получают разные contexts. Через createHttpTransport с cookie/Origin/CSRF headers выполнить hello → createGroup → snapshot → logout; namespace duplicate id не смешивает пользователей, повтор одного request не дублирует effect. Actor forgery rejected; пока root policy не реализована addProject/detectTaskType denied. Logout отзывает A/writer, B продолжает; PTY не убит.

- [ ] **Step 2: Добавить lifecycle assertions.** Второй startup того же profile отвергнут до Web ingress; занятый Web port закрывает начатый headless; repeated stop идемпотентен; stop во время bounded login не публикует cookie. При cleanup failure stop rejects и сохраняет owner, retry завершается, следующий owner стартует. Private endpoint metadata — orca-web/2.0.0, bearer остаётся доступным только локально. Несовместимый protocol → существующий 409. Fixtures очищаются только после остановки owned resources.

  Test `stop не освобождает профиль до успешного native cleanup` проверяет:

  ```ts
  await assert.rejects(web.stop())
  await assert.rejects(startWeb(sameProfileOptions))
  await web.stop()
  const next = await startWeb(sameProfileOptions)
  await next.stop()
  ```

- [ ] **Step 3: Подтвердить RED.** Run `node --test apps/web/test/host.test.ts`; expected missing startWeb, без реального LLM.

- [ ] **Step 4: Собрать host и server artifact.** Config/accounts validation до startHeadless; Web authorizer допускает только account ids и отказывает двум ещё незащищённым root methods из Scope W1. Создать один operator handler с browser authentication, затем loopback server. При listen failure cleanup всех resources. При stop закрыть Web ingress/connections и одновременно начать `host.runtime.value.beginStop()` и router/handler cleanup: pending command может ждать owned Git/PTY, поэтому сначала ждать только HTTP jobs нельзя. После их успешного завершения вызвать headless.stop для private endpoint/final owner release. Cleanup failures допускают retry и сохраняют owner до успешного cleanup.

  Build ESM server/admin/start для node24 с bundled workspace dependencies; external только node-pty, source import из apps/headless разрешён через package export. Копировать skills/agent JS CLI и installed manifest с Node-native dependency по образцу headless build; resourceDir определяется по installed entrypoint, без source TS/workspace paths. Выход только apps/web/dist. Build guard отвергает Electron/Desktop imports; W1 не содержит browser/static bundle. Native package здесь использует системный Node24, bundled Node Linux и installer — W5.

  Передавать headless product name `orca-web` и version из собственного installed manifest в resourceDir (сейчас 2.0.0), а не hardcoded version. Несовместимый/повреждённый manifest отвергается до startup.

- [ ] **Step 5: Проверить W1 целиком и обновить документацию.** Run `pnpm --filter @orca-board/web test`, Web/headless/runtime typecheck, `pnpm --filter @orca-board/web build`. Дополнить copy/native-install helper без повторения installer test wiring. `node scripts/test-web-artifact.mjs` копирует реальный Web dist вне workspace и запускает `smoke-web-artifact.mjs` через системный Node24 с установленным native module: временный config/account/profile → реальный startHeadless/startWeb → login/hello/group mutation/snapshot → logout → stop/restart. Smoke не использует source TS или fake startHost; secrets не печатает, реальные платные агенты не запускает. Добавить этот smoke рядом с headless в существующий Linux CI.

  Указать реальные backend/admin commands с disposable config, отсутствие UI/installer и дальнейшие W2–W6. Handoff сохраняет точку остановки, checks и изменённую общую release policy. Это проверка server artifact с системным Node24; готовый installer, bundled Node и заявленная Ubuntu-поставка проверяются в W5.

- [ ] **Step 6: Один полный verify перед PR.** Run `pnpm verify`, `git diff --check`; expected exit 0. Core/HELP проверка входит в verify. Не повторять verify на том же source после успеха. Исправление падения требует соответствующей повторной проверки; не ослаблять guards/tests. Проверить diff/cached diff и сделать commit `feat: запустить Web host на общем runtime`.

- [ ] **Step 7: Собрать и открыть локальный Desktop по AGENTS.md.** Run `pnpm --filter @orca-board/desktop run pack`, открыть apps/desktop/release/local/mac*/orca-board.app, сообщить фактический путь. Пользователь вручную проверяет Desktop; браузерный Web интерфейс ещё не готов. Автоматического обхода GUI нет.

- [ ] **Step 8: Итоговое отдельное ревью и PR.** Сохранённый выбор пользователя — выполнять самому, отдельное ревью в конце. Проверить branch requirements/auth boundaries/lifecycle и common graph; исправить подтверждённые замечания. Push только своей feature branch и PR → develop по шаблону после зелёного verify; не мержить/публиковать без отдельного поручения. В отчёте отделить готовый backend W1 от ещё предстоящих UI/installer/shared release jobs.

## Перед началом исполнения

После проверки плана и перед Task 1 один раз выполнить `pnpm install --frozen-lockfile`
под Node24 в назначенном worktree. Не запускать install до письменного review gate;
дополнительная native установка выполняется существующими owned scripts.

План написан и самостоятельно проверен. Пользователь уже выбрал выполнение самим
агентом с отдельным итоговым ревью; повторно выбирать метод не нужно. Дождаться
проверки этого письменного плана пользователем, затем использовать
`superpowers:executing-plans`. До этого product code/dependencies не создаются.

### Уточнение W6: браузерная установка (04.10.2026)

Пользователь подтвердил проверку и установку из браузера, включая отдельный systemd worker.
Расширение существующего updater: prepare/install разделены; защищённые routes возвращают
общий UpdateState, сохраняют private job и фиксированную версию. Отдельный oneshot unit
использует те же checksum/backup/owner/rollback и переживает stop основной панели.
Service install генерирует unit + три фиксированных sudoers команды, проверяет visudo.
Общая UpdateCard/Banner сохраняется; source host имеет check + terminal fallback.
Проверки: очередь/повторы/восстановление/ошибки/CSRF, реальные systemd-analyze/visudo templates,
browser-safe types/build, финальный Desktop pack; неизменённые suites повторно не запускаются.

### Последнее решение о выпусках (05.10.2026)

Пользователь выбрал независимые выпуски Web/Desktop. Общий release policy выше superseded:
Desktop vX.Y.Z и свой feed; Web web/vX.Y.Z и отдельный web-release.yml, make_latest=false.
Web installer/check/update выбирают только собственные стабильные tags/assets; версия Web
не выравнивается с root/Desktop. Первый Web-выпуск готовится отдельным поручением, без нового Desktop.
Recovery fix pass: private transaction до stop, согласованный backup, pinned ExecStopPost rescue,
wait inactive до следующей queue, атомарный private file claim с CLI/browser ownership.
