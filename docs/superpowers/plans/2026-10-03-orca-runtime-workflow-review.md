# Общие исполнители workflow и review Orca

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Автор выполняет задачи последовательно; пользователь уже разрешил автономное продолжение и одно отдельное итоговое ревью.

**Goal:** Исполнять графы задач/прогонов, приёмку и решения человека через общий runtime без Electron, сохранив Desktop.

**Architecture:** Отдельные фабрики review, task workflow и run workflow получают общие ресурсы и typed messages. `createWorkflowServices` объединяет их и связывает обработку событий/решений с явно переданным store/репозиторием. Desktop сохраняет прежние exports, локализацию, scheduling и проверку вложений.

**Tech Stack:** TypeScript strict, Node 24, pnpm 10.33.0, node:test, существующие Git/node-pty/Electron/Vite.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`

## Global Constraints

- Использовать назначенный `/private/tmp/orca-web-migration-audit`, `feature/web-migration-audit`; версия 1.1.3 не меняется. BASE среза `df0f2568533b1ef50b8e4e5a0e7f8370e9c76441`; `origin/develop` уже предок.
- Runtime не импортирует Electron/Desktop/node-pty, включая type-only/transitive imports. Native backend выбирает host.
- Сохранять schemas, migrations, события, CLI/socket/IPC/HELP, графы и лимит 50 последовательных переходов. Новых зависимостей нет.
- Git — массив аргументов без shell; существующий синхронный порядок сохраняется. Async/commonDir/EffectToken относятся к следующему рубежу надёжности.
- Ресурсы/Git одного owner и сообщения передаются явно. `forProject(deps)` использует переданные store/repo/callbacks, без activeId и кеша выбранного проекта.
- Переносить самостоятельные backend suites вместе с модулями; Desktop suites, зависящие от renderer/socket/IPC/ProjectManager, оставить как интеграционную совместимость.
- Desktop scheduling (`setImmediate` вне store commit), liveness/agent guards и сохранение файлов остаются в host. Их полный lifecycle bootstrap и client context ещё предстоят.
- Комментарии, docs и коммиты по-русски; strict types, без any/console.log. UI проверяет пользователь, автоматических кликов нет.
- Перед сдачей pnpm verify, одно независимое ревью с RED→GREEN исправлениями, локальный pack/open, push/update PR #59 и CI точного HEAD. Без merge/release.

## Review Focus

1. Мерж отличает конфликт от ошибки Git; пропавшая база или устаревший ответ отвергаются до коммита/удаления worktree, работа сохраняется.
2. `worker_done` со старым dispatch, заменённый gate/decision или уже решённый request не продвигают актуальный этап/соседний путь.
3. Повтор после рестарта не дублирует gate/ask/approval, stopped stage ждёт человека; ошибка одного пути не блокирует эффекты другого.
4. Два экземпляра services/project bindings не смешивают store, Git targets, callbacks и язык ошибок; строки для UI и журнала остаются раздельными.
5. Native сценарий и plain Node entrypoint выполняют переход workflow → решение человека → review/merge без окна; сохраняются worktree/ветка конца без мержа и чужой ветки checkout.

## Task 1: Review и параметры запросов

**Files:** create runtime `workflow-messages.ts`, `review.ts`, `request-params.ts`, `test/workflow-test-host.ts`, `test/review-services.test.ts`; move Desktop `review.test.ts` и `request-params.test.ts` в runtime; modify runtime `index.ts`, Desktop `review.ts`, `request-params.ts`, create `workflow-services.ts`; docs `architecture.md`.

**Interfaces:**
- `WorkflowErrorKey`: review.noBranch/notReviewable/stageBlocked, git.noCommits/mergeTargetMissing, request.alreadyCancelled/alreadyResolved, global.approvalAmbiguous.
- `WorkflowTextKey`: runApproval.acceptHint/acceptHintLane/laneTitle; params — `Record<string, string | number>`.
- `WorkflowMessages { error(key: WorkflowErrorKey, params?): Error; text(key: WorkflowTextKey, params?): string; displayError(error: unknown): string }`; host переводит displayError, журнал хранит исходную причину.
- `createReviewServices({ resources: ExecutionResources, messages: WorkflowMessages })` → getReview, mergeTaskBranch, acceptReview, resolveHumanRequest с прежними сигнатурами. MergeTargetOf/MergeResult/ResolveOutcome — общие types.
- `askOptions`, `findOption`, `singleOption`, `resolutionFromParams` сохраняют подписи, Desktop reexports runtime.

- [x] Добавить API-тесты настоящих Git/store: мерж в ветку прогона без изменения master, missing target до dirty commit/cleanup, старый ответ до effects, уже решённый request до start, UI displayError отдельно от причины escalation; два review host не смешивают ошибки.
- [x] Run: `node --test packages/runtime/test/review-services.test.ts`. Expected: FAIL — createReviewServices отсутствует.
- [x] Перенести review/parser, внедрить ресурсы и сообщения, сохранить Desktop facades. Перенести самостоятельные suites, меняя только host imports/ожидания кода ошибки; Git/store assertions сохраняются.
- [x] Run: runtime/desktop typecheck и runtime tests; core docs tests. Expected: PASS.
- [x] Commit: `refactor: вынести приёмку и решения человека в runtime`.

## Task 2: Исполнитель задач

**Files:** create runtime `workflow.ts`, `test/task-workflow-services.test.ts`; move `workflow-git.test.ts` в runtime; modify runtime `index.ts`, Desktop `workflow.ts`, `workflow-services.ts`, docs `architecture.md`.

**Interfaces:**
- `createTaskWorkflowServices({ resources, review: ReviewServices, messages })` → taskEngine, enterWork, advance, handleWorkflowEvents, resumeStuckStages, reviewAccept, reviewReject, approvalResolved; прежние WorkflowDeps/TaskEngine.
- WorkflowDeps сохраняет store/repoRoot/run/startWorker/mergeTarget. Showcase helper берётся из contracts.

- [x] Добавить тесты общего API: done→human→accept→merge→done с настоящим Git, старый dispatch без перехода, рестарт lost done без повторного approval, stopped stage не исполняется автоматически, конец без мержа сохраняет ветку, host error codes review.notReviewable/stageBlocked.
- [x] Run: `node --test packages/runtime/test/task-workflow-services.test.ts`. Expected: FAIL — createTaskWorkflowServices отсутствует.
- [x] Перенести алгоритм, сохранив 50 steps, классификацию Git/merge и foreign branch; Desktop получает методы общей singleton factory. Перенести самостоятельный workflow-git suite.
- [x] Run: runtime/desktop typecheck, runtime tests, Desktop workflow compatibility suite и core docs tests. Expected: PASS.
- [x] Commit: `refactor: выделить общий исполнитель задач workflow`.

## Task 3: Исполнитель прогонов

**Files:** create runtime `workflow-run.ts`, `test/run-workflow-services.test.ts`; move Desktop `workflow-run.test.ts` в runtime; modify runtime `index.ts`, Desktop `workflow-run.ts`, `workflow-services.ts`, docs `architecture.md`.

**Interfaces:**
- `createRunWorkflowServices({ resources, workflow: TaskWorkflowServices, messages })` → прежние exports функций; SUBTASK_MERGE_NODE='subtask-merge' остаётся общим constant. RunWorkflowDeps сохраняет startCoordinator/isAlive.
- branchHead остаётся argument-based Git read, внутри runtime. Request option parser из Task 1, showcase helper из contracts, ошибки/три approval текста через WorkflowMessages.

- [x] Добавить API-сценарии: fork с двумя human approvals, неоднозначная карточка без мутаций, принятие одного пути не двигает другой, повтор effects после восстановления не дублирует gate/ask, stale decision/gate без продвижения, два независимых host с разными approval текстами, отказ одного worker не мешает соседнему пути.
- [x] Run: `node --test packages/runtime/test/run-workflow-services.test.ts`. Expected: FAIL — createRunWorkflowServices отсутствует.
- [x] Перенести run executor, подключить shared task/review/resources, сохранить Desktop facade; перенести самостоятельную suite с сохранением сценариев и disk/store/Git assertions.
- [x] Run: runtime/desktop typecheck, runtime tests, Desktop workflow-run/fork E2E и core docs tests. Expected: PASS.
- [x] Commit: `refactor: вынести исполнение прогонов workflow в runtime`.

## Task 4: Общая маршрутизация и сдача

**Files:** create runtime `workflow-services.ts`, `test/workflow-services.test.ts`; modify runtime `index.ts`, `test/core-entry.test.ts`, Desktop `workflow-services.ts`, `main/index.ts`, `worker-runtime.test.ts`, docs `architecture.md`, этот план.

**Interfaces:**
- `createWorkflowServices({ resources, messages })` → `{ review, task, run, forProject(deps: RunWorkflowDeps) }`; WorkflowServices — ReturnType.
- forProject → `handleEvents(events: readonly OrcaEvent[]): void`, `resumeStuckStages(): void`, `resolveHumanRequest(id, resolution): ResolveOutcome`, `reviewDecision(taskId, outcome, text?, images?: string[]): Task | undefined`.
- Binding маршрутизирует task/run events и approval/decision решения; main сохраняет setImmediate, project resolution, liveness и запись/проверку image paths перед вызовом общего API.

- [ ] Тесты binding: legacy/path/run события обрабатываются своим executor, task/run/decision requests идут по правильному графу, два проекта сохраняют независимые callbacks/targets; повтор решённого запроса не запускает worker.
- [ ] Run: `node --test packages/runtime/test/workflow-services.test.ts`. Expected: FAIL — createWorkflowServices отсутствует.
- [ ] Добавить aggregator/binding и подключить его к main events/resume/resolve/review, сохранив совместимые exports. Plain Node smoke выполняет реальную запись/reload и workflow; native fixture использует общий binding для перехода после done и приёмки/мержа.
- [ ] Run: Node/native targeted tests, затем `pnpm verify`. Expected: PASS без пропусков.
- [ ] Commit: `refactor: подключить Desktop к общим workflow services`.
- [ ] Одно fresh-context итоговое ревью диапазона плана; Important/Critical исправить одним RED→GREEN проходом и полным verify, Minor записать как deferred.
- [ ] Записать результат/оставшиеся рубежи, сохранить ledger/review/проверки вне scratch, удалить только workspace этого плана. Собрать/open Desktop, проверить настоящий app.asar и codesign.

Перед сдачей: push/update PR #59 и CI точного HEAD; без merge/release.

## Самопроверка

План закрывает workflow/review части рубежей 2–3. Параметры messages/resources Task 1
используются Tasks 2–4; Task 3 получает TaskWorkflowServices, Task 4 получает все
три factories. Каждый Review Focus закреплён тестами соответствующих задач.
Owner lifecycle, agent discovery, диалоги, async Git, удалённый протокол, общий UI и
installed artifacts остаются последующими этапами; готовность всей базы не заявляется.
