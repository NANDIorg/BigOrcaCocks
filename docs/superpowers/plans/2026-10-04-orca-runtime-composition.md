# Общая composition и headless host

> Исполнение inline по superpowers:executing-plans, без промежуточных approvals/reviews. Spec: 2026-10-02-orca-shared-foundation-design.md §3–12.

**Goal:** Desktop и установленный Node24 host собирают одни общие службы, команды и agent socket. Импорт runtime не запускает daemon; native PTY загружает только host.

**Architecture:** Runtime composition получает paths/product/messages/settings/native ports; создаёт project/workflow/command graph с явным project context, owner events/revisions и cleanup. Headless entrypoint отдельно получает profile lease, preflight storage до backups, запускает общий graph и приватный operator endpoint. Browser/agent principal не получает native/secret методы автоматически. Старый agent envelope/HELP остаётся совместимым. Linux smoke проверяет installed JS artifact вне source workspace с настоящим PTY/Git без DISPLAY/Electron.

## Global Constraints

- Назначенный worktree, крупные связанные commits. Только целевые persistence/lifecycle/native regressions и types по ходу; full verify/core/review/pack — whole-end по прямой просьбе пользователя.
- Storage preflight read-only после lease и до backup/миграций: future projects/board/dialog/journal/mutations отказывают без перезаписи.
- Один GitProcessService во всём owner graph, очередь commonDir общая. Shutdown сначала отключает ingress/timers, дожидается команд/providers/PTY/Git, затем отдаёт lease. Не удалять foreign socket.
- Operator transport отдельно от legacy agent socket/ownership ping; bounded packet/connection queues, streams/binary без base64 JSON и без публикации на внешнем интерфейсе.
- Product/version/env/paths задаёт host. Native open/reveal/update/tray/window остаются Desktop; UI/CLI фичи не входят в блок.

## Review Focus

- Все Desktop и headless бизнес-операции используют те же factories/ports; owner/legacy callbacks публикуют observer invalidations и revisions.
- Unsupported schema отказывает до backup/миграций; lease не освобождается до native exit.
- Agent socket не получает recovery/operator/secret команды; endpoint не удаляет живой чужой socket.
- Installed artifact не разрешает Electron/source TS/workspace links; Linux smoke действительно создаёт PTY и Git repo.

### Task 1: Common graph, schema preflight и lifecycle

**Files:** runtime composition/agent-socket/preflight/lifecycle; Desktop adapters/index; focused runtime tests; четыре docs/dashboard.
**Interfaces:** `createRuntimeServices(host)` принимает host-owned projects/resources/workers/sessions/messages; выдаёт общий command graph/project ports/lifecycle. `createOrcaRuntime(options)` запускает graph под profile ownership с explicit native ports и metadata; stop останавливает owned services до lease. `assertProfileSchemas(dataDir)` не пишет. Session registry добавляет awaitable `stop()` с сохранением старого sync kill API.

- [x] RED→GREEN: real temp future storage unchanged; shutdown ждёт native exit. Два клиента/второй owner и реальные effects проверены installed Linux smoke.
- [x] Implement common graph/agent socket factory и Desktop wiring без дубля orchestration.
- [x] Targeted GREEN/types; docs вместе с code commit. Linux/native smoke после установленной упаковки Task2/F.

### Task 2: Private operator transport и installed host

**Files:** runtime operator transport/binary ports; apps/headless entry/build/package; artifact smoke/CI; docs/dashboard.
**Interfaces:** Endpoint принимает host-verified stable client identity, strict protocol packets; snapshot/replay и big results через bounded streaming; upload/download отдельный raw binary channel. Host binds owner revision/event providers, leases detach and recovery decisions. `apps/headless` bundle содержит runtime/core/contracts/skills/plain agent CLI; node-pty host dependency, без Electron/native modules в runtime graph.

- [x] RED→GREEN: real endpoint rejects forged context/incompatible hello before effect; reconnect duplicate once. Installed PTY disconnect/writer duplicate проверены; input/consumer bounds реализованы, общий final review остаётся.
- [x] Implement transport/headless artifact; fresh Linux Node24 native Git/PTY smoke outside workspace.
- [x] GREEN/types/build; four docs/dashboard and commit; continue E/F, no premature foundation-complete claim.

Фактический итог блока: focused runtime21/21, Desktop startup5/5, все workspace types PASS. Linux native artifact smoke и duplicate writer GREEN выполнены до последних cleanup/default-path изменений; один latest artifact smoke остаётся whole-end после E/F.
