# Общий API сессий и диалогов Orca

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** завершить application boundary для PTY/assistant/dialogs и ввести одного writer каждой PTY независимо от наблюдателей.

**Architecture:** SessionCommands используют общий SessionRegistry и host env/root ports; WriterLeases принадлежат owner и не останавливают процессы при disconnect. DialogCommands адресуют DialogRegistry без singleton selection; Desktop AssistantCommands сохраняют старый выбранный assistant как compatibility adapter. Async client executor проверяет host principal до lookup и после await.

**Tech Stack:** Node24, strict TS, pnpm10.33.0, node:test, существующие PTY/conversation ports; новых dependencies нет.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md` §4/5/6/11/12.

## Global Constraints

- Назначенный feature worktree; native inline execution, один финальный whole-foundation review. Следующие B/C/D/E/F продолжаются без handoff.
- Runtime без Electron/Desktop/node-pty; contracts browser-safe; no any/as any/console.log.
- Caller проверяется до payload/selection/lookup/effect, JSON actor не удостоверение. Legacy Desktop сигнатуры/локализация/режим Amp/Shell сохраняются.
- Client detach освобождает leases/observer, не убивает driver/PTY. Owner stop — отдельный lifecycle.
- Writer lease TTL по умолчанию30000ms, максимум60000ms; лимиты input64KiB, dimensions2..1000 cols/1..1000 rows; expiry проверяется при действии, не background interval.
- Существующий JSON/transcript и provider binding сохраняются; новые clientMessageId/revision/dedup/observer replay формализуются в следующем протокольном плане C. История не повторяет tool calls.
- Docs4/dashboard с кодом, final verify/review/pack/open по всей задаче. Никакого Web/CLI UI/deploy/version/release.

## Review Focus

- Expired/foreign writer lease не вводит/resize; второй клиент наблюдает и получает tail, процессы живы после disconnect — Task1.
- Неизвестный/чужой projectId и malformed env/dimensions не вызывают spawn — Task1.
- Dialog driver получает явный project binding, поздний update старого диалога не меняет другой — Task2.
- Async rejection/permission answer проверяет действующие dialog/request и policy; malformed payload не влияет на driver — Task2.
- Desktop event channels не выбрасывают необработанное исключение, mainFrame verified до открытия системного terminal/assistant — Task3.

### Task 1: Session API и writer leases

**Files:** create contracts/session-commands.ts, runtime/session-writer-leases.ts, session-commands.ts, test/session-commands.test.ts; barrels, docs4/dashboard/plan, command errors/ru/en если необходим отдельный conflict code.

**Interfaces:** createSessionWriterLeases({isAlive,now?,ttlMs?}) -> claim(ptyId,clientId), require(ptyId,clientId,leaseId), renew/release/dropClient/dropSession; один lease {id,ptyId,clientId,expiresAt}. createSessionCommands(host) -> spawn/list/writer/claimWriter/renewWriter/releaseWriter/write/resize/kill, ClientCommandContext explicit. Host project(id), sessions (общий registry), leases, env(project?), defaultCwd, onExit and authorize. Spawn payload existing PtySpawnOptions, projectId optional explicit; backend не читает active project. Shell meta/env/defaults собираются общим service; Desktop адаптер добавляет legacy selected project. Нативные любые cwd/command/env остаются trusted operator capability, не выданы агенту.

- [x] **Step 1:** Real SessionRegistry с controllable minimal PTY port: forbidden/invalid before effects, two clients metadata/tail, expired/foreign lease no input/resize, claim conflict и renew, disconnect сохраняет process/tail, exit/kill удаляет lease, dimensions/env/project validation и host execution defaults. Assert registry activity/output/input, not mock factory existence.
- [x] **Step 2:** `node --test packages/runtime/test/session-commands.test.ts`; Expected FAIL missing factories.
- [x] **Step 3:** Implement validation, writer identity/TTL guards; require writer before input/resize, operator kill separate from writer. Returned DTO detached. Lease refusal code command.conflict, unknown terminal command.rejected with host message.
- [x] **Step 4:** Session commands/sessions/import-boundary suites, contracts/runtime/Desktop types/core docs; Expected PASS.
- [x] **Step 5:** Diff/staged diff/code+tests+docs commit/task-done affected suite.

### Task 2: Dialog и legacy Assistant commands

**Files:** create contracts/dialog-commands.ts, assistant-commands.ts; runtime/dialog-commands.ts, assistant-commands.ts, async-client-commands.ts; tests/dialog-commands.test.ts; modify dialog-registry.ts project binding port, barrels/docs4/dashboard/plan.

**Interfaces:** DialogCommands list/create/snapshot/send/interrupt/respond/stop with ClientCommandContext and optional explicit projectId for create/list, create {projectId?,settings?:Partial<AssistantSettings>}; host registry/settings/project(id)/authorize. DialogSnapshot DTO переезжает в contracts без поведения. DialogRegistryDependencies.create(settings,onUpdate,projectId?:string) forwards actual dialog binding. AssistantCommands open/reset/available/snapshot/send/interrupt/respond; host legacy AssistantSession and buildWorkflowContext(context?). AsyncClient scope checks authorize on commit/result; no status attribution across await. No global selection added to new Dialog API.

- [x] **Step 1:** Real repository + actual conversation fixture tests two bound projects/drivers/history/late callbacks, forbidden/malformed before lookup/CLI, unknown project/dialog/request, readOnly restart, native terminal fallback legacy compatibility and Promise domain cause (ru/en adapter Task3). Send result must not apply to another dialog.
- [x] **Step 2:** Runtime targeted new test; Expected FAIL missing factories.
- [x] **Step 3:** Implement commands and shared validator for InteractionAnswer shape; actual provider validates request/turn and answer choices. Optional workflow context prepared by host helper before send. Forward project binding into driver port; old two-argument factories compatible.
- [x] **Step 4:** New API + dialog-registry/repository/assistant-session/conversations/import guards/types/core; Expected PASS.
- [x] **Step 5:** Diff/staged diff/docs commit/task-done.

### Task 3: Desktop compatibility

**Files:** create main/session-assistant-commands.ts/.test.ts; modify main/pty.ts/index.ts/assistant-session.ts as needed; native attachment handlers verified; docs4/dashboard/plan.

**Interfaces:** Desktop handles existing pty:spawn/terminals:list and pty:write/resize/kill events + existing assistant/assistantChat channels through common commands. Auto claim/renew verified local window writer for legacy event args; rejected fire-and-forget reported via logger, not uncaught exception. Window disconnect drops its leases only; PTY owner disposal unchanged. AssistantSession common registry remains single selected compatibility instance; new operator composition uses DialogRegistry independently.

- [x] **Step 1:** Real session/assistant adapters tests exact channels, foreign mainFrame stops before selection/lookup/spawn/native, no-project default shell and selected project/env/meta, event unknown/lease conflicts reported, dialog Promise translation/legacy args. No UI clicks.
- [x] **Step 2:** Desktop Node/ts-resolve new adapter test; Expected FAIL missing register factory.
- [x] **Step 3:** Wire adapters, remove inline session/assistant mutation logic; retain Electron notifications/windows/update glue. Native attachment OS handlers validate caller and continue shared resource guard.
- [x] **Step 4:** Affected Desktop/runtime/types/core + full verify after completed A; Expected PASS. Remaining B–F before final claim.
- [x] **Step 5:** Diff/staged diff/commit/task-done; dashboard records actual A/C writer portion, continue async Git B.

Self-review: Task1 exports SessionWriterLeases and explicit commands consumed Task3; Task2 preserves legacy AssistantSession projection and supplies independent Dialog API for future composition. C durable dedup/revisions/replay and D installed artifact intentionally remain separate requirements; no readiness claim from module presence alone.
