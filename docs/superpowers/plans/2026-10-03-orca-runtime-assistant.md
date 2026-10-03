# Общий движок диалогов ассистента

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Пользователь подтвердил самостоятельное продолжение архитектуры и одно итоговое ревью; повторное разрешение не нужно.

**Goal:** Перенести существующие structured transports, сессию ассистента и чтение истории в общий runtime, сохранив работу Desktop.

**Architecture:** Runtime владеет процессом/протоколом и состоянием экземпляра сессии; host задаёт сообщения, env, homeDir, executablePath и platform. Desktop сохраняет совместимые facade exports, OrcaError, текущую локализацию и wiring окна. DTO находятся в contracts; host-интерфейсы драйвера — в pure runtime leaf без Node imports; backend suites идут вместе с реализацией.

**Tech Stack:** TypeScript strict, Node 24, node:test, существующие contracts/runtime/Electron; без новых dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §§3–6, 11–12. Этот срез начинает рубеж 4, не заявляет завершения registry/persistence/reconnect.

## Global Constraints

- Назначенный linked worktree `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`; baseline `5aa1ddfafd0f1ce6a115dc3126586db54d0fd374`. Не менять root/shared branches.
- Production runtime не импортирует Desktop/Electron/node-pty, включая type-only/transitive imports. Contracts остаётся browser-safe.
- Сохраняются protocol v2 assistantChat, IPC/socket/HELP, legacy dependency-free CLI, schema и версия 1.1.3. Amp/shell остаются terminal fallback.
- Codex app-server, Claude stream-json и ACP сохраняют существующие frames, policies, approvals, contextual acceptance и cancellation. Настоящие CLI fixtures вместо платных LLM.
- Прежние пути facade и совместимость renderer/preload сохраняются; UI не меняется. Процесс не привязывается к BrowserWindow.
- Новый factory не получает module singleton env/language; сообщения и окружение задаёт host. Desktop translator остаётся динамическим.
- Полный registry диалогов, сохранённые transcript/provider binding, idempotent send, revision conflicts, observers/replay и owner относятся к следующим срезам. Текущий runtime class — одна сессия на экземпляр.
- Перед сдачей pnpm verify, одно fresh final review, один fix pass Important/Critical, pack/open, PR #59/push/CI точного HEAD. Без merge/release.

## Review Focus

1. Разные hosts с собственными env/messages не смешивают CLI настройки, errors или события. Проверяется двумя реальными subprocess-сессиями.
2. Отказ нового агента не закрывает прежний диалог; reset/dispose отбрасывает поздние события/ответы и закрывает только собственный процесс. Проверяется session и provider suites.
3. Permission/question нельзя подтвердить чужим/устаревшим id; contextual send ждёт acceptance, обычный send сохраняет early resolve. Переносятся реальные wire regressions.
4. UTF-8/незавершённая строка, параллельное чтение и переписанный файл одинакового размера не дают дублей/старой истории. Проверяются настоящими файлами и контролируемым mtime.
5. Public Node entry работает без Electron/DISPLAY; Windows shim сохраняет argv с пробелами/метасимволами и использует host Node. Проверяются subprocess smoke и launch suite.

## Task 1: Общая история и транскрипты

**Files:** create `packages/runtime/src/transcripts.ts`, `packages/runtime/src/assistant-chat.ts`, `packages/runtime/test/transcripts.test.ts`, `packages/runtime/test/assistant-chat.test.ts`; modify runtime `src/index.ts`, Desktop `main/transcripts.ts`, `main/assistant-chat.ts` и их tests, `docs/architecture.md`, `docs/assistant-chat.md`.

**Interfaces:**
- Produces: прежние `TranscriptEnv`, `TranscriptCache`, `parseClaudeLine`, `parseCodexLine`, `readLines`, `collectSessionUsage`, `UsageContext`, `claudeSlug`.
- Produces: `transcriptEnv(env?: NodeJS.ProcessEnv, homeDir?: string): TranscriptEnv`; optional homeDir сохраняет Desktop defaults и позволяет явный host path.
- Produces: прежние `AssistantChatCache`, `ChatBuildState`, `applyChatLine`, `emptyChatState`, `chatSnapshot`, `drainChatUpdates`, `chatInputBytes`, `assistantTranscriptPath`, `assistantChatAvailable`, `ASSISTANT_CHAT_MESSAGE_LIMIT`.

- [x] Написать regressions реальных cache read: история и usage после переписывания файла того же размера/нового mtime должны обновиться; путь определяется явно переданным env/homeDir. Run Desktop cache suites. Expected: FAIL на старом содержимом/отсутствующем homeDir.
- [x] Перенести parsers/cache/usage в runtime, заменить shared IPC imports на contracts. Перенести backend tests; ProjectStats E2E оставить Desktop. Исправить invalidation для неизменного размера и изменённого mtime, сохраняя чтение дописанного хвоста и partial-line semantics.
- [x] Run runtime typecheck и runtime cache suites; Desktop cache/stats suites и core tests для docs. Expected: PASS.
- [x] Commit `refactor: вынести историю ассистента в общий runtime`.

## Task 2: Общие structured transports

**Files:** modify Desktop `shared/assistant-conversation.ts`, `main/assistant-conversation.ts` и tests; create runtime `src/assistant-conversation.ts`, `src/assistant-conversation-types.ts`, `src/assistant-conversation-messages.ts`, `test/assistant-conversation.test.ts`, `test/conversation-services.test.ts`, `test/conversation-fixture.ts`, `test/fixtures/assistant-cli.mjs`; modify runtime `src/index.ts`, docs architecture/assistant-chat. Перенести прежний fixture из Desktop после проверки consumers.

**Interfaces:**
- Produces runtime pure leaf: прежние `AssistantConversation` и `ConversationOptions` без Node imports. DTO contracts не меняются (Ruling: boundary guard запрещает provider interfaces в public contracts).
- Produces: `AssistantTransportMessageKey` — union существующих assistantTransport keys; `AssistantTransportMessages(key, params?: Record<string, string | number>): string`.
- Produces: `ConversationServicesDeps { messages: AssistantTransportMessages; env(): NodeJS.ProcessEnv; homeDir: string; executablePath: string; platform: NodeJS.Platform }`.
- Produces: `createAssistantConversationServices(deps)` с `create(options: ConversationOptions): AssistantConversation` и `structuredLaunch(command: string, args: string[], env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): { command: string; args: string[]; env: NodeJS.ProcessEnv }`.
- Desktop facade сохраняет `createAssistantConversation(options)` и `structuredLaunch(command,args,env,platform?)`.

- [x] Написать service regressions через public package entry: два host env/messages, реальные permission/send/cancel, отсутствие Electron/DISPLAY, configured Node для Windows shim. Run новых tests. Expected: FAIL — shared factory отсутствует.
- [x] Перенести существующий engine, внедрить сообщения и host process config. Сохранить argv/env sanitization, очередь notifications до ACK, handoff, provider request scoping и собственное cleanup. Перенести backend suites и fixture, оставить Desktop renderer/provider integration и проверки локализации facade.
- [x] Run contracts/runtime/Desktop typecheck, provider/services и Desktop compatibility suites; core docs tests. Expected: PASS.
- [x] Commit `refactor: вынести транспорты чата в общий runtime`.

## Task 3: Общая сессия и Desktop binding

**Files:** create `packages/runtime/src/assistant-session.ts`, `packages/runtime/test/assistant-session.test.ts`; modify runtime `src/index.ts`, Desktop `main/assistant-session.ts`/tests; docs architecture/assistant-chat.

**Interfaces:**
- Consumes Task 2 runtime pure `AssistantConversation`; DTO updates/answers из contracts.
- Produces: `AssistantSessionDependencies` с прежними callbacks settings/assertUsable/create/startTerminal/isAlive/killTerminal/onUpdate и обязательными `errors { unknownPty(): Error; emptyText(): Error }`.
- Produces: `AssistantSession(deps)` с прежними open/available/snapshot/send/interrupt/respond/dispose. Desktop subclass добавляет существующие OrcaError factories, сохраняя constructor callers.

- [x] Написать shared session regressions: reset/stale events, сохранение старого диалога при guard refusal, два независимых instances и host error identity, terminal exit/dispose, invalid empty send. Run новых tests. Expected: FAIL — shared class отсутствует.
- [x] Перенести class/state/revision; заменить OrcaError на deps.errors. Перенести backend tests, сохранить Desktop error/i18n совместимость. Main wiring остаётся совместимым.
- [x] Run runtime/Desktop session/provider compatibility suites, `pnpm verify`. Expected: PASS, нет новых schemas/commands/UI.
- [x] Commit `refactor: перенести сессию ассистента в общий runtime`.

## Завершение и оставшийся объём

- [x] Fresh final reviewer с plan/spec/ledger и текущим диапазоном. Re-grade Declined, Important/Critical исправить одним RED→GREEN проходом; Minors отложить явно.
- [x] Pack/open локальный mac app, ASAR/signature/main+renderer; UI вручную проверяет пользователь.
- [x] Подготовить обновление PR #59 и evidence доставки. После финального docs-коммита: обновить body один раз, push, дождаться CI точного HEAD и архивировать/убрать только scratch этого плана; результат фиксируется вне checkout.

После текущего среза остаются пять архитектурных рубежей: завершить диалоги/observers;
headless/owner/async/reconciliation; полный service API и файлы; общий UI/client;
installed artifact и независимая release policy. Это крупные блоки, а не число мелких
переносов: календарный срок ещё не зафиксирован. Web начинается после критериев §12.


## Результат переноса

Tasks 1–3 выполнены: история/cache, существующие structured drivers и одна
AssistantSession на экземпляр находятся в runtime. Desktop сохраняет прежние
facades, IPC/socket и язык ошибок; UI, схемы, версия и dependencies не менялись.

Полный `pnpm verify` после единственного fix pass: **3396/3396**,
failures/skips/cancelled 0; core 943, runtime 463, Desktop 1856, scripts 49,
CLI 38, contracts 47. Git Flow, typecheck и build проходят. Fresh reviewer
самостоятельно выполнил runtime 91/91, Desktop 5/5 и UTF-8/1MiB/partial smoke.
Important: гонка Codex cumulative usage воспроизведена новым тестом
(actual [10,20,10] вместо [10,10,10]), исправлена объединением reads:
RED → history GREEN 30/30 → полный verify. Второго ревью после исправления нет.

Локальный mac x64 pack 1.1.3 собран и открыт; ASAR/signature/main+renderer
проверены. После этих проверок меняется только данный план, не bundled files.
Ручной интерфейс проверяет пользователь. Push/CI выполняются после фиксации
этого документа; финальные SHA/jobs, review, ledger и логи сохраняются в
`/private/tmp/orca-runtime-assistant-evidence` (вне commits).

### Принятые решения

1. Продолжить утверждённую архитектуру inline без нового запроса подтверждения плана — пользователь многократно подтвердил самостоятельное продолжение, разработчик запрещает повторные approval flows при уже данном разрешении — цена ошибки: пересмотр границ текущего среза.
2. Извлечь существующие transports/session/history до полного registry/persistence/reconnect — это перенос рубежа 4 с сохраняющимся Desktop, не готовый server dialog service — цена ошибки: до следующих диалоговых/owner этапов Web/новый CLI подключать рано.
3. Сбрасывать оба reader cache при том же размере и новом mtime — реальные RED показывают старую историю и usage после rewrite; append/partial-line не меняются — цена ошибки: изменение только metadata может вызвать лишнее полное чтение файла, без исполнения tools.
4. Driver interfaces AssistantConversation/ConversationOptions держать в pure runtime leaf, а не contracts public DTO — существующий boundary test запрещает provider driver types; spec отделяет process runtime от wire contracts — цена ошибки: временный Desktop type bridge ссылается на pure runtime leaf; при переносе общего UI оставляем только DTO, guard не ослабляем. Task 3 consumes runtime interfaces, остальные сигнатуры прежние.
5. Полный dialog registry/persistence/idempotency/replay/owner/installed artifact остаётся будущими срезами — текущий перенос сохраняет Desktop и не объявляет server readiness; это подтверждение утверждённой границы — цена ошибки: Web/новый CLI нельзя подключать до завершения этих обязательных этапов.
6. Не добавлять rollback прежнего диалога после async startup/handshake failure нового CLI — явный reset создаёт новую сессию; guard refusal сохраняет старую, а сбой уже созданного процесса показывается в новой сессии, как baseline — цена ошибки: контекст прежнего in-memory диалога не восстановится при таком сбое до будущего persistence.
7. Не обещать детекцию всех внешних замен transcript — текущие provider logs дописываются, перенос добавляет только same-size/new-mtime reset; проверка содержимого на каждом read меняет стоимость кеширования — цена ошибки: при внешней замене на больший файл или сохранении size/mtime возможны устаревшие history/usage до сброса cache; надёжность import/rotation требует отдельного решения.

### Отложенный Minor

- Общий test formatter prefix request capability ослабляет точность ряда assertions конкретной причины отказа; отклонение и отсутствие wire mutation всё ещё проверяются.
