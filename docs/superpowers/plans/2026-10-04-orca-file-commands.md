# Общие файлы, документы и показы — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести последний файловый backend из Desktop и подключить единый FileCommands с явным проектом и проверенным principal.

**Architecture:** Node factories получают сообщения и Git/preview ports; общий path-safety убирает цикл docs/project-files. Preview grants, CSP, bounded reads и snapshot остаются общими, адреса внедряются хостом. Desktop сохраняет IPC/DTO/схему orca-preview и выполняет native open/reveal только после общего разрешения пути.

**Tech Stack:** Node24, TypeScript strict, pnpm/node:test, реальные Git/worktrees/файлы/symlinks/Request streams.

**Spec:** docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md §§3–8,11–12; docs/orca-foundation-progress.md, рубеж A.

## Global Constraints

- Inline в назначенном feature worktree; продолжение уже одобрено. Один final reviewer/pack/open в конце всего фундамента, UI не меняется.
- Runtime graph без Desktop/Electron; contracts browser-safe. Shared factories не запускают processes при import. Legacy agent CLI/envelope/skills и JSON paths сохраняются.
- Все файловые операции ограничены root/source; public DTO не содержат абсолютных backend paths. Native path передаётся только trusted host callback, а не клиенту.
- Preview: bounded100 grants, прежний CSP/sandbox/no-store/range/whitelist. Network разрешён лишь для snapshot; project/worktree preview всегда без сети. HTTP route/deploy — позже.
- Лимиты: docs text1MiB/image10MiB, old read markdown2MiB; directory5000/ignore-input20000; snapshot core limits. Сохраняем UTF-8/BOM/stubs/CRLF, hidden/git/symlink и atomic snapshot guards.
- `withStatusSource` не удерживается через await; commit/native/issue-grant/result требуют current registration/store и повторную policy.
- Async Git workflow, composition/operator endpoint, UI/client/release — последующие планы; наличие services ещё не готовый foundation.

## Review Focus

- `.git` с casing/Windows suffix, NTFS/drive/backslash, hidden preview, URL percent/dot normalization и symlink наружу отклоняются.
- Файл вырос после stat: чтение ограничено, ответ stub/tooBig, FIFO не открывается; native open не запускает executable.
- Grant network не переиспользуется как no-network, двух service instances не разделяют grants; вытесненный token даёт404.
- Удаление/re-add проекта или изменение task/worktree/dispatch во время await отменяет поздний result/preview/native effect.
- Foreign caller и malformed source/options/id отклоняются до project lookup и файловых эффектов; Desktop legacy no-project list/explicit files сохраняются.

### Task 1: Общие services и preview policy

**Files:** create runtime file-messages.ts, path-safety.ts, project-files.ts, docs.ts, docs-view.ts, showcase.ts, showcase-snapshot.ts, preview.ts и соответствующие runtime tests/fixtures/file-services.ts; modify runtime/index.ts, четыре docs/dashboard. Старые Desktop modules пока сохраняются.

**Interfaces:**
- `isInside(root,target)` чистый общий helper.
- `createProjectFileServices({messages,gitCheckIgnore})` → splitSafeSegments/resolveProjectPath/listProjectDir; export прежних directory/noise constants.
- `createDocServices({messages})` → resolveDocPath/readDoc/listProjectFiles/listWorktreeDocs/docTasks/docSourceRoot/listDocGroups; messages.Error + text('docs.project'). Export DOC_MAX_BYTES/PROJECT_SOURCE/DocTask/ProjectFileList.
- `PreviewAddress { cspSource; base(token); urlFor(token,segments); parse(url): {token,path}|undefined }`; `createSchemePreviewAddress(scheme)` сохраняет ручной разбор без URL normalization; `createPreviewServices(address)` → previewBase/previewUrlFor/previewSegments/CSP/headers/resolvePreviewRequest/handlePreviewRequest/range/navigation. PreviewTokens/типы и limit экспортируются; host owns each registry.
- `createDocViewServices({messages,files,preview})` → resolveDocFile/viewDoc/viewResolved/readDocBytes/docsPreviewUrl/docsOpenPath/docsRevealPath/sniffText.
- `createShowcaseServices({messages,preview})` → прежние root/source/resolve/read/previewUrl/base, snapshot path из runtime/execution-resources. `createShowcaseSnapshotServices()` → plan/write/snapshotDispatch/markdownRefs с прежними алгоритмами и ошибками.

- [x] **Step 1:** Перенести unit cases в runtime с factory fixtures и error-key assertions: реальные repo/ignore/strange names/UTF-8/growing file/symlink/FIFO/snapshot overwrite/cleanup/range/CSP. Desktop locale и mixed UI integration tests остаются на Desktop. Добавить два independent registries и injected address fixture; public URL не содержит root.
- [x] **Step 2:** `node --test packages/runtime/test/{project-files,docs,docs-view,showcase,showcase-snapshot,preview}.test.ts`; Expected FAIL missing factory при успешных imports.
- [x] **Step 3:** Извлечь алгоритмы, разорвать cycle, внедрить trusted messages/ports/address; сохранить whitelist/limits и native scheme adapter.
- [x] **Step 4:** Targeted suite, runtime/contracts import guards, runtime/Desktop typecheck; Expected PASS.
- [x] **Step 5:** Четыре docs/dashboard/plan, diff/staged diff, commit точных paths; task-done targeted suite.

Task1: targeted116/116 + HTTPS-address regression1/1, runtime/contracts import guards38/38, runtime/Desktop typecheck PASS, fail/cancel/skip0.

### Task 2: FileCommands и guards async effects

**Files:** create contracts/file-commands.ts; runtime/file-commands.ts, runtime/project-scope.ts, runtime/test/file-commands.test.ts; modify runtime/stats-commands.ts (совместимые aliases), docs.ts (single docTask lookup), docs-view.ts (guarded issue callback), contracts/files.ts (host URL docs); modify barrels, четыре docs/dashboard/plan.

**Interfaces:** `FileCommands` context-first методы listDir, listDocs, readDoc, viewDoc, docBytes, docPreview, openDoc, revealDoc, revealFile, readShowcase, showcasePreview, showcaseBase, openShowcase, revealShowcase. Native методы возвращают void, path только injected host.open/reveal. `RegisteredProject {id,root,store,registration}` использует общие registeredProject/isRegisteredProjectCurrent (stats сохраняет aliases); createFileCommands(host) принимает services, preview tokens, snapshots, branch, native ports и обязательные authorize/isCurrent. Capture doc task root / showcase dispatch reference до await; validate current identity перед issue grant/native/result; async scope.commit только sync.

- [x] **Step 1:** Failing public tests: real PM A/B, explicit selection independence, forbidden/invalid before lookup/disk, safe options/source/id, detached Uint8Array, private native path, no-network project, network only snapshot, project remove/readd и task root/dispatch replacement during real async read.
- [x] **Step 2:** `node --test packages/runtime/test/file-commands.test.ts`; Expected FAIL missing factory.
- [x] **Step 3:** Runtime validated explicit commands; native/preview late effects через sync guarded commit; output remains old DTO.
- [x] **Step 4:** Targeted + runtime types/guards и contracts tests; Expected PASS.
- [x] **Step 5:** Четыре docs/dashboard/plan, diff/staged diff/commit, task-done targeted.

Task2: file API12/12, affected56/56 (file+stats+docs-view+runtime guards), contracts50/50, runtime typecheck PASS; fail/cancel/skip0.

### Task 3: Desktop facades и IPC

**Files:** replace Desktop project-files/docs/docs-view/showcase/showcase-snapshot/preview-protocol with facades; create main/file-commands.ts и .test.ts; modify main/index.ts; четыре docs/dashboard/plan. Locale и native window navigation остаются Desktop.

**Interfaces:** registerDesktopFileCommands(handle,host) — прежние docs7/showcase5/files2 IPC, verified caller до legacy active selection; docs:list без проекта [] после caller validation, files используют explicit id. Trusted native ports shell.openPath/showItemInFolder; production previewAddress native orca-preview.

- [x] **Step 1:** Failing adapter tests с реальными services/files: exact channels, caller ordering, legacy source selection/A/B, native path/result, ru/en cause translation, late removal без shell side effect.
- [x] **Step 2:** `pnpm --filter @orca-board/desktop exec node --experimental-transform-types --no-warnings --import ./test/ts-resolve.mjs --test src/main/file-commands.test.ts`; Expected FAIL missing register factory.
- [x] **Step 3:** Подключить commands и facades; убрать inline root/source domain logic. protocol.handle и navigation/native shell остаются Desktop.
- [x] **Step 4:** Affected Desktop docs/files/showcase/preview/socket suites, Desktop/runtime typechecks + core docs HELP; Expected PASS. Полный verify — перед итоговой доставкой после остальных планов.
- [x] **Step 5:** Docs/diff/staged diff/commit/task-done affected suite; продолжить Git/runs/agents/dialogs без handoff.
