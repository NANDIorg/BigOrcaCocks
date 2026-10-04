# Протокол operator clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Один совместимый protocol для Desktop bridge, будущих Web/CLI и headless host: безопасный reconnect, независимые клиенты и bounded observer events без повторных native effects.

**Architecture:** Browser-safe contracts описывают handshake/call/result/cursor. Runtime проверяет handshake и host-verified principal, хранит persistent mutation identity/results и отдаёт независимый memory replay с snapshot barrier. Transport вызывает явно зарегистрированные общие commands; legacy agent socket не получает operator API. Сетевой endpoint и полная composition подключаются следующим блоком D; client transport/reconnect — E.

**Tech Stack:** TypeScript strict, Node24 JSON persistence и crypto для digest, existing command executors; node:test.

**Spec:** docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md §4–7/10/12.

## Global Constraints

- Inline в назначенном worktree, связанные изменения одним блоком/commit. По просьбе пользователя только значимые regressions/typecheck по ходу, full verify/core/review/pack после B–F; не повторять task-done suites.
- `protocolMajor=1`, `schemaVersion=1` обозначает shared host protocol/storage compatibility. Product SemVer может отличаться; runtimeRevision и реальные capabilities сообщает host.
- Principal и client identity устанавливает проверенный host; actor/clientId из call JSON отвергаются. Browser/agent не получает secret/admin capabilities автоматически. Не делать общий публичный сервис/RBAC/SaaS.
- JSON calls максимум64KiB/32 args; большие файлы и upload/download имеют отдельный binary transport capability в D/E, не base64 RPC. Existing Desktop native IPC/agent envelope/HELP остаются совместимы.
- Dedup хранится24h, максимум1024 записей: незавершённые записи не удаляются по TTL; завершённые внутри окна не вытесняются, capacity отказывает до нового effect. После restart pending имеет uncertain outcome и не повторяется автоматически.
- Observer memory history максимум512 событий/2MiB/24h; одна subscriber queue максимум128 событий/1MiB. Slow/expired/foreign-epoch cursor требует snapshot. PTY output не пишется синхронно на диск на каждый chunk. Disconnect удаляет подписки/lease клиента, процессы живут у owner.
- Revision/state changes из legacy agent и owner callbacks тоже видны клиентам. Клиент не мигрирует профиль; owner preflight unsupported schemas должен происходить до backups/миграций в D.

## Review Focus

- Разные product versions совместимы; неверный protocol/schema или отсутствующая capability отказывает до project lookup/native effects.
- Один request id с разными method/project/args/revision/issuedAt отвергается; параллельный одинаковый запрос исполняется один раз, crash gap остаётся uncertain.
- Replay/observer не меняет core consumedBy; snapshot и subscribe не теряют события, включая reentrant publication, очереди bounded при отсутствующем drain.
- Курсор прошлого owner после restart и старый request за пределами reconnect window не превращаются в безопасный retry.
- Project/dialog selection двух соединений независимы; разрыв соединения не вызывает kill/dispose driver и не открывает доступ к secret/native methods.

### Task 1: Contracts, handshake и observer barrier

**Files:** contracts src/operator-protocol.ts/index.ts; runtime src/operator-handshake.ts/observer-events.ts/index.ts; test operator-protocol.test.ts.

**Interfaces:** `OperatorMetadata{protocolMajor,schemaVersion,runtimeRevision,product:{name,version},capabilities}`; `OperatorHello{protocolMajor,schemaVersion,product:{name,version},requiredCapabilities?}`. `assertOperatorHello(hello,metadata):OperatorMetadata` runtime validation до эффектов. `createObserverEvents({epoch,maxEvents?,maxBytes?,maxAgeMs?,queueEvents?,queueBytes?,now?})` exposes `publish(topic,payload,projectId?)`, `cursor`, `subscribe(cursor?,filter?)`, `snapshot(readSnapshot,filter?)` with atomically installed subscription and barrier cursor. Subscription `take()`/`close()`; reset marker вместо unbounded queue. Payloads oversized заменяются invalidation marker; события не исполняют действий.

- [x] **Step 1: RED.** One focused suite validates different product versions accepted, malformed/incompatible/capability refusal; snapshot reentrant event retained; two observers independent and no consumedBy writes; overflow/expired/restart cursor reset and bounded queue.
- [x] **Step 2: Run RED.** `node --test packages/runtime/test/operator-protocol.test.ts`; Expected FAIL missing factories.
- [x] **Step 3: Implement.** Closed validated DTOs, bounded cursor/replay/filtering, queue byte budgets and strict caller teardown only. Publish ordering stable for reentrant callbacks.
- [x] **Step 4: GREEN.** Same test file PASS; typecheck at block completion. No full suite repeat.

### Task 2: Persistent mutation identity и verified operator session

**Files:** runtime src/mutation-ledger.ts/operator-session.ts/index.ts; contracts protocol error/call/result; test operator-mutations.test.ts; четыре docs/dashboard.

**Interfaces:** `createMutationLedger({dataDir,ownerId,now?,ttlMs?,maxEntries?})` uses `operator-mutations.json` version1; `execute({clientId,actorId,id,issuedAt,method,projectId?,revision?,args},operation):Promise<MutationResult>`. Canonical digest covers complete action payload, excludes secret host context. Result variants applied/rejected/uncertain; concurrent callers share one Promise. Journal intent persisted before callback, final result after; future/corrupt file refuses without write. `createOperatorSession({context,metadata,ledger,events,commands,getRevision,onDetach?})` owns selection state, validated hello/call/snapshot/subscribe/close. Explicit descriptor map `{capability,mutation,scope?,invoke}` dispatches shared command only; client JSON supplies args/project/request identity, host supplies principal. `getRevision(scope)` guards mutation expected revision; D binds actual owner change notifications and snapshot providers.

- [x] **Step 1: RED.** Real temp profile tests duplicate concurrent side effect once, changed payload conflict, persistent completed replay, interrupted owner reload uncertain, I/O refusal before callback, TTL/capacity without pending eviction. Two sessions with independent selection/observers; forged actor/clientId, missing handshake/capability and stale revision refuse before invoke. Close does not kill registry/process.
- [x] **Step 2: Run RED.** `node --test packages/runtime/test/operator-mutations.test.ts`; Expected FAIL missing ledger/session.
- [x] **Step 3: Implement.** Atomic publish-after-save ledger with bounded retained results, strict packet validators and host principal only. Unknown pending request requires explicit recovery; no automatically replayed tools. No arbitrary property/prototype dispatch.
- [x] **Step 4: GREEN/types/docs/commit.** Both protocol suites and runtime/contracts types PASS. Четыре docs/dashboard describe C implementation and D/E/F pending. Inspect exact diff, commit `feat: добавить общий operator protocol и восстановление запросов`; ledger completion from receipts, no duplicate suite run. Continue D.
