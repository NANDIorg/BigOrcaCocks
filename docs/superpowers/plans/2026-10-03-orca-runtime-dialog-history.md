# Общее хранилище истории диалогов

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Пользователь подтвердил самостоятельное продолжение общей архитектуры, inline execution и одно итоговое ревью; повторное approval не требуется.

**Goal:** Сохранить provider binding и transcript в общем versioned JSON repository и безопасно читать историю после рестарта без запуска инструментов/CLI.

**Architecture:** Contracts содержит только JSON DTO и чистое представление history-only. Существующий driver добавляет optional providerBinding к snapshot. Runtime repository работает с явным абсолютным file, проверяет весь документ и revision до atomic write; один owner задаётся host. Desktop wiring/UI пока прежние, registry подключит repository следующим переносом.

**Tech Stack:** TypeScript strict, Node 24, node:test, существующий writeFileAtomic; без dependencies.

**Spec:** docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md, §§4–7, 11–12. Это часть рубежа 4, не его завершение.

## Global Constraints

- Назначенный worktree /private/tmp/orca-web-migration-audit, feature/web-migration-audit; baseline 37abfb8df8ede58c0e6ad6e450437545c6bae390. origin/develop a5555147bd2bf850b587ad9af5344d2f99c59a2a unchanged ancestor.
- Версия 1.1.3, deps/lockfile, legacy agent CLI/HELP/socket и IPC protocol v2 не меняются. Новый isolated файл создаёт только явный caller; существующие данные Desktop не мигрируются.
- Contracts browser-safe, no driver/store export; runtime no Electron/Desktop/node-pty imports. Provider frames/permissions/acceptance сохраняются.
- Новый envelope {schemaVersion:1,dialogs:DialogRecord[],retiredDialogIds?:string[]}; иная версия/повреждение/дубликаты отвергаются до writes. Старые байты не заменяются пустым и не quarantined автоматически. Unknown JSON fields сохраняются внутри поддерживаемой версии.
- Registry/подключение Desktop persistence, async I/O/owner acquisition, idempotency/replay/resume и UI выбора истории — следующие переносы. Repository не является lock между процессами и вызывается после ownership.
- History-only не выполняет tools/CLI, не отвечает прежним interactions, не выдает новый thread/start за resume. Никакого auto restart оплачиваемого LLM.
- Перед сдачей full pnpm verify, один fresh reviewer, один Critical/Important fix pass, pack/open, обновить PR59 once перед push, CI exact HEAD; без merge/release. Только собственный scratch архивируется и удаляется.

## Review Focus

1. Повреждённый/будущий/частично невалидный файл не превращается в пустую историю при последующей мутации; исходные байты и чужой tmp directory сохраняются.
2. Старый revision не заменяет/удаляет новый dialog; разные проекты и profiles не смешиваются, opaque id не становится filesystem path.
3. Реальные Claude/Codex/ACP native ids сохраняются; conversation UUID не подменяет Codex thread или ACP session. Отсутствующий handshake не объявляется resume.
4. History-only очищает pending interactions/running tools и показывает interrupted для незавершённого turn; исходный сохранённый record не мутируется и tools не исполняются.
5. Public Node reload после остановки provider работает без Electron/DISPLAY и создания subprocess; unknown JSON metadata и все прежние сообщения сохраняются.

## Task 1: DTO, history-only и provider binding

**Files:** create contracts src/dialogs.ts, test/dialogs.test.ts; modify contracts src/conversation.ts, src/index.ts; runtime src/assistant-conversation.ts; create runtime test/conversation-binding.test.ts; docs/architecture.md и docs/assistant-chat.md.

**Interfaces:**
- ConversationBinding {transport:'claude-stream-json'|'codex-app-server'|'acp';sessionId?:string}; ConversationSnapshot.providerBinding?:ConversationBinding.
- DialogRecord {id:string;projectId?:string;createdAt:number;updatedAt:number;revision:number;conversation:ConversationSnapshot}.
- DialogHistorySnapshot {dialog:DialogRecord;readOnly:true;requiresNewConversation:true}; dialogHistory(record:DialogRecord):DialogHistorySnapshot.
- History copies JSON DTO; starting/thinking/waiting → interrupted, interactions=[], running toolCalls → cancelled, done/error/previous completed tools retained. Это read-only view, не новая persisted mutation/revision.
- Driver snapshot exposes Claude configured session id (conversation UUID), Codex thread id/ACP session id после handshake. До native id known transport присутствует, sessionId отсутствует у Codex/ACP. Optional поле совместимо со старым snapshot/preload.

- [x] RED: contracts histories waiting permission/tool-running → interrupted/no interactions/cancelled, completed/error unchanged, nested clone independent. Real provider fixtures Claude/Codex/ACP сохраняют literal native ids; before handshake Codex/ACP не имеют sessionId. Run new suites; Expected FAIL missing history/binding.
- [x] Implement DTO/helper и optional snapshot metadata, no protocol changes. Run contracts tests/boundaries, provider binding + existing provider suites, typecheck. Expected PASS.
- [x] Commit feat: добавить общие снимки истории диалогов; task-done whole relevant suites.

## Task 2: Versioned repository с revision guards

**Files:** create runtime src/dialog-validation.ts, src/dialog-repository.ts, test/dialog-repository.test.ts; modify runtime src/index.ts; docs/architecture.md/assistant-chat.md.

**Interfaces:**
- DialogRepositoryError extends Error with code:'dialog.invalid'|'dialog.schemaUnsupported'|'dialog.conflict'.
- createDialogRepository(file:string) requires explicit absolute path, no creation at import/factory.
- Returned list(projectId?:string):DialogRecord[], get(id:string):DialogRecord|undefined, history(id:string):DialogHistorySnapshot|undefined.
- save(record:DialogRecord,expectedRevision:number|null):void: null=create with revision0; update requires existing expected revision and next record revision=expected+1. Mismatch → dialog.conflict before write.
- remove(id:string,expectedRevision:number):void requires existing exact revision, otherwise conflict. No implicit force/reset.
- Private validation checks JSON envelope/version, unique ids, safe nonnegative integer revision/timestamps, optional project id, known agent/status, messages<=CONVERSATION_MESSAGE_LIMIT, all nested messages/tools/interactions/options/questions and binding transport/agent association. Nonempty ids; text may be empty. Unknown JSON fields preserved, prototypes/functions never stored (JSON round-trip validated).

- [x] RED actual files: missing repository has no side effects; create/reload/update/remove, project filter and separate profiles; stale save/delete retain bytes; invalid incoming DTO; future schema/corrupt JSON/invalid nested record/duplicate ids prevent ALL writes; unknown fields round-trip; tmp directory fault keeps original bytes and retry succeeds. Expected FAIL missing repository.
- [x] Implement full-file read before each mutation, only ENOENT=empty. Validate incoming JSON clone and whole existing document before CAS; atomic write uses existing helper. I/O errors propagate, no mutable cache advanced. Add get/history read-only views. Expected targeted PASS, no writes on failed guards.
- [x] Run runtime test + typecheck/core docs tests. Expected PASS. Commit feat: сохранять историю диалогов с проверкой ревизии; task-done repository suite.

## Task 3: Реальный Node round-trip и итоговая проверка

**Files:** create runtime test/dialog-history-integration.test.ts; docs/architecture.md/assistant-chat.md.

**Interfaces:** Consumes Task1 driver snapshot and Task2 repository/history. No new production API.

- [x] Test real Codex + Claude in two profiles: send permission, persist current snapshot/binding, dispose provider, separate plain Node process reads history-only, exact messages/native ids retained, no pending interaction, can only view/new conversation, source JSON unchanged, no Electron/DISPLAY. Also completed ACP snapshot round-trip. Expected PASS using existing completed APIs; integration pins their boundary.
- [x] Run integration + Desktop conversation/session compatibility, full pnpm verify after Node native rebuild. Expected PASS. Commit test: проверить восстановление истории под Node; task-done integration suite.

## Завершение

- [x] Fresh final review текущего диапазона; re-grade every Declined, one RED→GREEN fix pass Important/Critical, defer Minors explicitly.
- [x] Pack/open 1.1.3; ASAR/code signature/startup verified, manual UI user.
- [x] Delivery подготовлен: PR59 body once перед push, exact-HEAD CI all required jobs, archive/hash/delete только этого plan scratch. Фактические push/checks/архив выполняются после этого финального docs commit; результаты в /private/tmp/orca-runtime-dialog-history-evidence, чтобы docs update не отменял зелёный CI.


## Результат среза

Общие DTO/history-only, provider binding и versioned repository готовы. Это часть
рубежа 4: нынешний Desktop ещё не сохраняет диалоги через новый repository.
Следующий перенос — общий registry и подключение Desktop persistence; Web/CLI
пока не создаются. Никакого paid-provider resume/restart из файла.

Task1 RED6→GREEN60, contracts50; Task2 RED34→GREEN34; Task3 separate Node
reload2/2 и Desktop compatibility5/5. Reviewer42/42 нашёл Important CAS ABA:
удаление/recreate того же id сбрасывало revision и позволяло stale caller потерять
новый transcript. Root воспроизвёл update/delete, один fix pass RED6→GREEN48:
atomic retired ids и full validation, после reload повтор id запрещён.
Полный pnpm verify3444/3444 (scripts49/core943/CLI38/contracts50/runtime508/Desktop1856),
failures/skips/cancelled0, typecheck/build PASS. Повторного ревью нет;
новых deferred Minors нет, прежний assistant test-formatter Minor не менялся.

Local mac x64 pack1.1.3 собран с fee6558 production и открыт; ASAR embedding,
providerBinding, strict deep codesign, новые main/renderer проверены. Неиспользуемый
repository tree-shaken до wiring. Ручной UI — пользователь, без автоматических кликов.
Этот финальный commit меняет только план; файл не входит в app bundle.

Решения и все reviewer Declined:

- Ruling: Продолжать утверждённую архитектуру inline с одним итоговым reviewer — пользователь повторно поручил дальше и подтвердил самостоятельное исполнение, developer не допускает повторных approval flows — цена ошибки: пересмотр текущего объёма.
- Ruling: Сначала DTO/binding и versioned history repository, затем registry/Desktop persistence — реализация resume отсутствует у нынешних drivers, repository является проверяемой опорой следующего переноса без изменения UI/legacy files — цена ошибки: текущий Desktop ещё не восстанавливает чат из этого файла; нужно последующее подключение.
- Ruling: После reload предоставлять только history-only, без CLI/tools и прежних interactions — thread/start/session/new создают новый диалог, не resume — цена ошибки: продолжение сохранённого контекста требует явного нового диалога до настоящего provider resume.
- Final: Ruling: Ownership/async I/O остаются host/следующим рубежом — синхронный repository вызывается уже единственным owner, CAS не lock — цена ошибки: без будущего owner lock параллельные процессы могут потерять запись; большие истории блокируют loop.
- Final: Ruling: Desktop/registry, legacy migration/backup wiring следующим переносом — новый изолированный файл ещё не используется Desktop, старое состояние не затронуто — цена ошибки: текущая UI-сессия ещё не восстанавливается из repository.
- Final: Ruling: Resume/replay/idempotency/late-turn arbitration следующим service-слоем — library читает history-only, не делает provider/send effects — цена ошибки: продолжение контекста и повтор сетевого send пока не гарантируются.
- Final: Ruling: Cross-project authorization/host-path confinement в будущих authenticated adapters — текущий caller trusted, absolute file явный, opaque dialog id не путь — цена ошибки: прямой доступ недоверенного клиента к runtime пока нельзя предоставлять.
- Final: Ruling: save заменяет полный DTO; unknown metadata сохраняется при get→update/save того же DTO и соседних records — patch API не предусмотрен, это явно описано в docs — цена ошибки: caller, заново собравший DTO без unknown fields, может их потерять; adapter обязан сохранять исходный DTO.
- Final: Ruling: Installed Linux/headless packaging и live paid providers отдельным этапом — текущие проверки source Node и реальные fixture subprocess без inference — цена ошибки: установленный Linux bundle и актуальный внешний CLI пока не доказаны.
- Final: Ruling: После удаления запрещать повтор dialog id, хранить retiredDialogIds в schema1 — закрывает ABA без изменения revision0/create API и без замены данных новой генерацией — цена ошибки: восстановление удалённого диалога потребует нового opaque id; список retired ids растёт до будущего backend/compaction.
