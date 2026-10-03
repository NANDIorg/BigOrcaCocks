# Общий реестр диалогов и сохранённый чат Desktop

**Spec:** docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md
**Execution:** inline, один fresh final reviewer. Пользователь уже разрешил продолжать фундамент; повторный approval не требуется.
**Baseline:** 1067243cd13042b7b075002dc2c9bc595853a1dc.

## Цель и ограничения

Реестр runtime владеет несколькими structured conversations, их snapshots, revisions,
подписками и persistence. Desktop AssistantSession остаётся адаптером одного выбранного
диалога и прежнего IPC. Его чат по-прежнему глобальный, независимо от выбранного проекта.
Первое открытие после перезапуска читает последний глобальный сохранённый диалог без
запуска CLI; новый диалог создаётся прежней кнопкой «+». История read-only, без resume,
replay, старых permission/tool effects. Amp/Shell остаются PTY и здесь не сохраняются.

Repository optional для прежних in-memory hosts; Desktop явно задаёт dialogs.json в
userData. Единственный writer обеспечен Desktop single-instance lock; межпроцессный
owner/headless transport, auth, idempotency и async database — последующие рубежи.
Ошибки записи останавливают только затронутый driver, показывают явную ошибку и
оставляют текущий снимок в памяти; сохранённые байты не заменяются пустой историей.
Успешные события публикуются после записи. Detach observer не закрывает процесс.
Данные нормализуются при stop/dispose, поздние события закрытого driver игнорируются.
Unknown JSON metadata сохраняется через исходный DTO. Общие пакеты без Electron,
Desktop и node-pty; contracts browser-safe; versions и legacy CLI неизменны.

Реестр предоставляет create(settings, projectId?), latest(projectId?) с точным scope
(undefined означает global), list(projectId?), snapshot(id), subscribe(id, listener),
send/interrupt/respond(id,...), stop(id), dispose(). Snapshot содержит dialog и optional
readOnly/requiresNewConversation; создание возвращает opaque driver id. Ошибки и
storage reporting задаёт host. Ревизии монотонны; сортировка latest детерминированна.

## Review Focus

1. Реальный restart не запускает агент и не исполняет старые interactions/tools.
2. History send/respond/interrupt отвергаются в runtime, UI объясняет новый диалог.
3. Другие диалоги/scopes/profiles не затронуты stop, observer detach и storage failure.
4. CAS и unknown metadata сохранены; failed write не публикуется как сохранённый turn.
5. Прежние IPC/PTY/reset/settings guard и локализация совместимы; backup включает файл.

## Task 1: Реестр runtime

**Files:** create runtime src/dialog-registry.ts, test/dialog-registry.test.ts; modify runtime src/index.ts, src/dialog-repository.ts.
**Interfaces:** DialogRegistryDependencies {repository?, create, errors, onError?}; DialogSnapshot {dialog, readOnly?, requiresNewConversation?}; DialogRegistryUpdate {id, revision, update, readOnly?, requiresNewConversation?}; subscribe возвращает unsubscribe. DIALOGS_FILE='dialogs.json' для явного host/backup path.

- [ ] RED: реальные файлы и provider fixtures проверяют несколько диалогов, revision/snapshot после событий, observer detach, stop/late update, reload history-only без create, project/profile isolation; failed creation/write и unknown metadata. Run new suite; Expected FAIL missing registry.
- [ ] Implement registry с единственным lifecycle, JSON copies, persistence-before-publish, fail closed при write error; ошибки чтения propagate, без overwrite/reset. Run registry + existing repository/conversation suites/typecheck. Expected PASS.
- [ ] Commit feat: управлять общими диалогами через реестр; task-done targeted suite.

## Task 2: Совместимый Desktop адаптер и read-only UI

**Files:** runtime src/assistant-session.ts, test/assistant-session.test.ts, src/backup.ts, test/backup.test.ts; contracts src/assistant-chat.ts; Desktop main assistant-session.ts/test/index.ts/strings; renderer AssistantPanel.tsx, assistantChat.ts/test, i18n; DESIGN.md; docs/architecture.md, docs/assistant-chat.md.
**Interfaces:** AssistantSessionDependencies.repository?; errors.readOnly?/storage?; onError?. Сохранить прежние методы/unknownPty/emptyText. AssistantChatSnapshot/Update additive optional readOnly/requiresNewConversation/providerBinding. Renderer использует существующие tokens/notice/reset, сохраняет unsent draft/context.

- [ ] RED: session restore без settings/guard/create; history mutation отказ; reset после restore создаёт новый чат; failed reset сохраняет прежний; PTY compatibility; backup copies dialogs bytes включая повреждённые/future; renderer send gate/history flags. Expected FAIL against legacy behavior.
- [ ] Replace единственный structured lifecycle registry delegation, wire Desktop repository/userData and localized errors, preserve PTY guard; readonly notice/disabled send and composer. Backup при Desktop version change включает dialogs.json без чтения схемы. Expected relevant tests/typecheck PASS.
- [ ] Update maintained docs/design. Run relevant suites + core docs tests. Commit refactor: подключить Desktop к общему реестру диалогов; task-done.

## Task 3: Реальный restart и итоговая проверка

**Files:** create runtime test/dialog-registry-integration.test.ts; update plan completion evidence.
**Interfaces:** Task1 registry + Task2 AssistantSession; actual provider fixture and separate plain Node process use public exports, no Electron/DISPLAY/CLI startup on history read.

- [ ] Real Codex permission/binding persisted by session without manual save, stop/reload separate Node host reads same messages/native id, no interaction/tools execution; new dialog explicit. Different profile untouched. Expected PASS using completed APIs.
- [ ] Native Node rebuild + full pnpm verify, static premium audit; one fresh reviewer, one RED→GREEN Important/Critical fix pass, Minors deferred. Expected PASS or explicit bounded rulings.
- [ ] Commit test: проверить восстановление Desktop через общий реестр; task-done integration suite.

## Завершение

- [ ] Final review/evidence, all Rulings and deferred Minors reported.
- [ ] Pack/open latest Desktop app; ASAR/signature/startup, manual UI user (no automated screens/clicks).
- [ ] Update PR59 body once before own-branch push; exact-HEAD push/PR all five required jobs green; own scratch archive/hash/delete only. No merge/release.
