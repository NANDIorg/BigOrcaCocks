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

- [x] RED: реальные файлы и provider fixtures проверяют несколько диалогов, revision/snapshot после событий, observer detach, stop/late update, reload history-only без create, project/profile isolation; failed creation/write и unknown metadata. Run new suite; Expected FAIL missing registry.
- [x] Implement registry с единственным lifecycle, JSON copies, persistence-before-publish, fail closed при write error; ошибки чтения propagate, без overwrite/reset. Run registry + existing repository/conversation suites/typecheck. Expected PASS.
- [x] Commit feat: управлять общими диалогами через реестр; task-done targeted suite.

## Task 2: Совместимый Desktop адаптер и read-only UI

**Files:** runtime src/assistant-session.ts, test/assistant-session.test.ts, src/backup.ts, test/backup.test.ts; contracts src/assistant-chat.ts; Desktop main assistant-session.ts/test/index.ts/strings; renderer AssistantPanel.tsx, assistantChat.ts/test, i18n; DESIGN.md; docs/architecture.md, docs/assistant-chat.md.
**Interfaces:** AssistantSessionDependencies.repository?; errors.readOnly?/storage?; onError?. Сохранить прежние методы/unknownPty/emptyText. AssistantChatSnapshot/Update additive optional readOnly/requiresNewConversation/providerBinding. Renderer использует существующие tokens/notice/reset, сохраняет unsent draft/context.

- [x] RED: session restore без settings/guard/create; history mutation отказ; reset после restore создаёт новый чат; failed reset сохраняет прежний; PTY compatibility; backup copies dialogs bytes включая повреждённые/future; renderer send gate/history flags. Expected FAIL against legacy behavior.
- [x] Replace единственный structured lifecycle registry delegation, wire Desktop repository/userData and localized errors, preserve PTY guard; readonly notice/disabled send and composer. Backup при Desktop version change включает dialogs.json без чтения схемы. Expected relevant tests/typecheck PASS.
- [x] Update maintained docs/design. Run relevant suites + core docs tests. Commit refactor: подключить Desktop к общему реестру диалогов; task-done.

## Task 3: Реальный restart и итоговая проверка

**Files:** create runtime test/dialog-registry-integration.test.ts; update plan completion evidence.
**Interfaces:** Task1 registry + Task2 AssistantSession; actual provider fixture and separate plain Node process use public exports, no Electron/DISPLAY/CLI startup on history read.

- [x] Real Codex permission/binding persisted by session without manual save, stop/reload separate Node host reads same messages/native id, no interaction/tools execution; new dialog explicit. Different profile untouched. Expected PASS using completed APIs.
- [x] Native Node rebuild + full pnpm verify, static premium audit; one fresh reviewer, one RED→GREEN Important/Critical fix pass, Minors deferred. Expected PASS or explicit bounded rulings.
- [x] Commit test: проверить восстановление Desktop через общий реестр; task-done integration suite.

## Завершение

- [x] Final review/evidence, all Rulings and deferred Minors reported.
- [x] Pack/open latest Desktop app; ASAR/signature/startup, manual UI user (no automated screens/clicks).
- [x] Delivery подготовлен: PR59 body один раз перед push; CI и архивирование выполняются после этого финального docs commit, чтобы не отменять проверку последним редактированием. Фактический результат хранится в /private/tmp/orca-runtime-dialog-registry-evidence. No merge/release.


## Результат среза

Общий DialogRegistry теперь владеет несколькими structured conversations, revisions,
сохранением и observers. Desktop подключён к userData/dialogs.json через совместимый
AssistantSession: последний созданный глобальный чат открывается после restart только
для чтения без CLI/settings/discovery. «+» начинает новый разговор; Amp/Shell остаются
терминальными. Прежний Desktop API и global selection сохранены. Это следующий срез
рубежа4; фундамент для Web ещё требует owner/API/replay/idempotency, общих файлов/UI
и проверки независимых поставок. Provider resume и old-log import не реализованы.

Один fresh reviewer39/39 + адресные probes нашёл2 Important и1 Minor. Root воспроизвёл
оба Important. Единый fix pass: RED5 (четыре реальные Codex/ACP state/human fault
subprocesses ETIMEDOUT, loss unknown binding metadata) → GREEN78/78. Driver проверяет
closed после host callbacks/перед acceptance и очищает ожидание при синхронной ошибке;
binding extras сохраняются при обновлении известных полей и очистке native id.
Повторного ревью нет. pnpm verify3472/3472: scripts49/core943/CLI38/contracts50/runtime532/
Desktop1860, failures/skips/cancelled0, strict typecheck/build PASS. Первый verify3467/3467.

Статический strict audit renderer36 замечаний, точно те же36 на baseline1067243;
новых0. Whole-app premium compliance не заявляется, UI вручную проверяет пользователь.
Mac x64 pack1.1.3 собран с production6a350a3 и открыт: main/preload ASAR embedding,
DialogRegistry/repository/history-only, strict deep codesign и новые main/renderer
проверены. Финальные docs commits меняют план и архитектурную документацию,
не входящие в app bundle.

Все решения в порядке принятия:

1. Ruling: Продолжить inline с одним итоговым reviewer — пользователь уже подтвердил самостоятельную работу — цена ошибки: пересмотреть объём этого среза.
2. Ruling: Восстанавливать последний глобальный чат, сохранить Desktop global/PTY API — выбор чата сейчас не зависит от проекта; новые clients имеют явный scope — цена ошибки: пока нет выбора старой истории и автоматического продолжения.
3. Ruling: History-only, новый разговор после restart — у drivers нет resume — цена ошибки: отправка требует нового диалога.
4. Ruling: Optional repository для прежних ephemeral hosts; Desktop задаёт файл под single-instance lock — один structured lifecycle вместо дублирования — цена ошибки: headless ещё требует межпроцессного owner и async I/O.
5. Ruling: Использовать прежние UI tokens/notice/reset и manual UI пользователя — AGENTS не разрешает автоматические обходы интерфейса — цена ошибки: визуальные состояния требуют ручной проверки.
6. Ruling: Read-only transition несёт полный snapshot — иначе клиент оставляет старые permissions/tools и не видит unsaved текст — цена ошибки: одно событие содержит больше данных.
7. Ruling: latest сортирует createdAt прежде updatedAt — checkpoint закрываемого старого диалога записывается после create нового — цена ошибки: параллельные clients не получают выбор по последней активности, используют явные ids.
8. Ruling: Не расширять перенос фундамента до legacy UI migration — strict audit36 совпадает с baseline, новых0; владельцы затронутого UI уже описаны — цена ошибки: полная premium compliance не доказана.
9. Final Ruling: Headless owner/auth/replay/idempotency/resume остаются следующим service этапом — нынешний Desktop имеет единственного writer и history-only — цена ошибки: runtime нельзя напрямую открывать недоверенным или нескольким writer clients.
10. Final Ruling: Оставить sync whole-file backend для текущего Desktop — atomic CAS проверен; database migration существенно расширяет срез — цена ошибки: большая история блокирует event loop и потребует async backend.
11. Final Ruling: History picker/project UI позже — global latest соответствует существующему Desktop, explicit registry ids/scopes уже работают — цена ошибки: Desktop пока не выбирает старый или project-scoped диалог.
12. Final Ruling: Legacy UI migration и визуальные проверки остаются ручными; executor собирает и проверяет ASAR/signature/startup — замечания audit прежние, AGENTS назначает UI пользователю — цена ошибки: whole-app visual/premium compliance не установлена.

Deferred Minors: successfully stopped/detached entries удерживают transcripts до конца
lifetime registry; память растёт с новыми диалогами, eviction/limits нужны перед
долгоживущим headless owner. Прежний assistant fixture formatter ослабляет точность
части assertions причины отказа; он также отложен. Исторический EOF cosmetic устранён
в уже затронутых backup source/test без отдельного расширения задачи.
