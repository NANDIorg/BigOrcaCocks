# Общий запуск и владелец профиля Orca

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Общая защита одного профиля и bootstrap под Node/Electron до загрузки,
бэкапа и миграций; Desktop использует этот запуск.
**Architecture:** Runtime приобретает OS-owned guard и публикует проверяемую
instance identity. Bootstrap запускает host initializer только после acquisition,
владеет зарегистрированным cleanup и освобождает guard после успешного shutdown.
Desktop держит guard до выхода процесса: legacy IPC/socket могут работать до quit.
**Tech Stack:** Node24, TypeScript strict, node:net/fs/crypto, node:test; новых dependencies нет.
**Spec:** docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md, разделы4/5/7/12.

## Global Constraints

- Пользователь уже утвердил архитектуру и inline execution с одним fresh final review; повторного approval нет.
- Назначенный /private/tmp/orca-web-migration-audit, feature/web-migration-audit сохраняется.
- Runtime без Electron/Desktop/node-pty; contracts browser-safe. Legacy CLI/HELP/socket envelope сохраняются.
- Root/Desktop1.1.3 и private0.0.1 не меняются; зависимости/lockfile прежние.
- Комментарии/docs/коммиты русские; main тексты через ru/en mt; any/as any запрещены.
- Начало mutation pipeline только после ownership. Unknown/future/corrupt owner metadata не заменять.
- Профиль на локальной файловой системе одного host. Перенос/rename dataDir — offline операция.
- Это ownership/bootstrap рубежа5, не готовый headless API. Actor/services/replay/async Git ещё следующие этапы.
- Ручной UI пользователь; после проверки pack/open Desktop, ASAR/signature/startup.

## Решения интерфейса

OS guard: Linux abstract Unix socket, Windows named pipe; macOS/прочие Unix —
exclusive TCP127.0.0.1 в диапазоне49152..65535. Имя/порт детерминированы по SHA256
физической identity canonical directory (dev/ino): aliases не создают второго owner.
TCP collision отказывает до state writes, другой порт не выбирается. Это внутренний
read-only guard, не operator/agent endpoint. [Node24 net](https://nodejs.org/docs/latest-v24.x/api/net.html)
документирует abstract auto cleanup, IPC и exclusive listen; reusePort не включается.

Файл `.orca-owner.json`: schemaVersion1, protocolMajor1, profileId, dataDir,
hostname, pid, instanceId UUID, endpoint. Прежде записи проверяются schema/identity,
regular file/size<=16384; unknown поля сохраняются. Доказательство отсутствия owner —
успешный bind того же guard, не PID. После crash OS освобождает guard, новый owner
проверяет прежний record и заменяет identity. Живой чужой endpoint не удаляется.

Request handshake {protocolMajor:1, profileId, instanceId}; ответ identity только
при совпадении. Frames<=4096bytes, socket timeout1000ms, maxConnections16;
probe timeout1500ms. Нет mutating methods или управления процессами на guard.

## Review Focus

- Чужой процесс/коллизия guard: нельзя затирать record или запускать initializer; Task1 foreign-server test.
- Повреждённый/future/symlink metadata: байты/target остаются, guard убирается после отказа; Task1 validation tests.
- Aliases/case-sensitive paths и отдельные profiles: один физический каталог имеет один owner; Task1 alias test и Task3 process tests.
- Ошибка частичного startup/shutdown: cleanup до release; неуспешный cleanup оставляет ownership; Task2 fail/retry tests.
- Смерть owner во время startup и конкурентный takeover: ровно один initializer, сохранённые данные читаются без overwrite; Task3 crash/concurrency tests.

## Task 1: Общий profile ownership

**Files:** create runtime/src/profile-ownership.ts, runtime/test/profile-ownership.test.ts; modify runtime/src/index.ts.
**Interfaces:** ProfileOwnerInfo; ProfileLocation {dataDir, profileId, file, endpoint};
getProfileLocation(dataDir:string):Promise<ProfileLocation>; acquireProfileOwnership({dataDir}):Promise<ProfileOwnership>;
ProfileOwnership {info, release():Promise<void>}; probeProfileOwner(info):Promise<boolean>;
ProfileOwnershipError {code, cause?}; PROFILE_OWNER_FILE='.orca-owner.json'.

- [x] RED: реальные tmp directories/net проверяют acquisition/busy/handshake, aliases, разные profiles, release/idempotency, corrupt/future/symlink/oversize и foreign listener. Run `node --test packages/runtime/test/profile-ownership.test.ts`; Expected FAIL missing API.
- [x] Implement guard, metadata validation, bounded protocol, exact-identity release и cleanup на failed startup. Expected targeted PASS, runtime typecheck PASS.
- [x] Commit feat: защитить профиль общим владельцем; task-done ownership suite.

## Task 2: Общий bootstrap lifecycle

**Files:** create runtime/src/profile-runtime.ts, runtime/test/profile-runtime.test.ts; modify runtime/src/index.ts.
**Interfaces:** startProfileRuntime<T>({dataDir,start(context):T|Promise<T>}):Promise<ProfileRuntime<T>>;
ProfileRuntimeContext {dataDir, owner:ProfileOwnerInfo, deferCleanup(()=>void|Promise<void>)};
ProfileRuntime<T> {value, owner, stop():Promise<void>}; ProfileRuntimeStartupError
extends AggregateError with retryCleanup():Promise<void> only when initial cleanup fails.

- [x] RED: busy refuses initializer/file writes; canonical context; LIFO real filesystem cleanup; startup failure cleanup/reacquisition; slow shutdown keeps ownership; failed stop retains guard and retry succeeds; concurrent stop runs cleanup once; failed partial cleanup retry via error. Expected missing bootstrap FAIL.
- [x] Implement ownership before start, reverse cleanup, memoized stop/retry; original startup error retained when cleanup succeeds. Expected lifecycle+ownership suites/typecheck PASS.
- [x] Commit feat: запускать runtime под владельцем профиля; task-done both suites.

## Task 3: Desktop wiring и реальные Node процессы

**Files:** main/index.ts, main/strings/ru.ts/en.ts, main/profile-startup-errors.ts/test;
runtime/test/profile-runtime-integration.test.ts, test/fixtures/profile-host.mjs;
docs/architecture.md, этот план.
**Interfaces:** Task2 bootstrap wraps existing Desktop initializer. Fatal startup
localized native error box + app.exit1; early quit does not access uninitialized projects.
Node fixture uses public runtime, ProjectManager, backup and dialog repository;
host cleanup is real and no process.exit masks successful cleanup.

- [x] RED: Desktop error mapper ru/en; two simultaneous Node hosts execute only one initializer; probe/disconnect leaves owner; SIGKILL restart reclaims record and preserves projects/dialog bytes; failed initializer releases guard naturally. Expected tests FAIL missing mapping/fixture behavior.
- [x] Wrap Desktop initialization before backup/migrations; retain guard until process exit, preserve current agent socket/quit policy. Add fixtures/integration. Expected targeted tests/typecheck/core PASS.
- [x] Native Node rebuild; full pnpm verify. One fresh final reviewer; Important/Critical single RED→GREEN fix pass, Minors ledger. Expected PASS.
- [x] Commit refactor: запускать Desktop через общий bootstrap; task-done integration/error suites.

## Завершение

- [x] All rulings/Minors/evidence recorded; final docs/core.
- [x] Pack/open latest Desktop; embedding/codesign/main/renderer confirmed; manual UI user.
- Доставка после итогового документационного коммита: PR59 body до push, exactHEAD push/PR required CI; own scratch archive/hash/delete. Фактический результат — PR checks и внешний архив; worktree/app сохраняются, merge/release не выполняются.


## Итог реализации и ревью

Ownership/bootstrap и подключение Desktop реализованы. Полный verify после одного
fix pass — 3500/3500: scripts49, core943, CLI38, contracts50, runtime554, Desktop1866;
failed/skipped/cancelled0, typecheck/buildPASS. Один fresh reviewer нашёл три Important:
reentrant stop освобождал guard до cleanup, ранний second-instance обращался к
несозданному projects, stale hostname блокировал физически тот же профиль.
Все воспроизведены RED→GREEN: runtime22/22 и Desktop6/6; повторного ревью нет.

Два Minor отложены: cached rejected release после повреждения metadata (ресурсы
уже закрыты, но retry остаётся ошибкой); комбинация crash внутри initializer и
двух takeover через alias проверена реальными процессами reviewer, но ещё не
перенесена в постоянную suite. Цена — отсутствие именно этой регрессии в будущем CI.
Единичный первоначальный отказ recovery не воспроизведён в 30 дополнительных
прогонах; исходный error frame не сохранился, причина не установлена. Новые
assertions сохраняют code/message/cause. Сетевые пробы не подтвердили гипотезу
конфликта с outgoing ephemeral TCP; production не менялся по этой догадке.

Ограничения: guard — внутренний read-only identity endpoint, не operator API;
локальная ФС одного host, offline перенос/rename. Desktop удерживает lease до выхода
процесса, cleanup менеджеров Node регистрируется во время initializer. Неожиданные
OS-ошибки уже работающего guard требуют отдельной политики долгоживущего host.
Полный headless host, client context/commands, async Git/reconciliation, replay/writer
leases, installed Linux, общий client/UI и независимые релизы остаются следующими
этапами. Ручной UI проверяет пользователь.

Фактическая локальная упаковка, запуск и финальный CI фиксируются в PR59 и внешнем
архиве `/private/tmp/orca-profile-runtime-evidence`; commit этой сводки не является
утверждением о ещё не завершённой доставке. Назначенный worktree/app сохраняются.

Local mac x64 pack1.1.3 на production commit b37c7b3 собран и открыт. ASAR содержит
ownership/bootstrap и остальные private factories без bare workspace imports;
strict deep codesignPASS, новый main/renderer и identity probe из plain Node подтверждены.
Ручной UI не проверялся исполнителем. Последующие изменения этого плана — только docs.
