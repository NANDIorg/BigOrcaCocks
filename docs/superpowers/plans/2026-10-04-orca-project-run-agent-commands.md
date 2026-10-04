# Общий API Git проекта, прогонов и агентов

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** убрать оставшиеся inline операции Git/runs/agents из Desktop application boundary.

**Architecture:** commands получают host principal и явные идентификаторы. Git commands используют async scope с registration identity; guard вызывается внутри очереди до каждого изменения. Runs остаются синхронными core operations, discovery/preflight используют извлечённые factories. Старый socket сохраняет envelope/HELP/policy.

**Tech Stack:** Node24, TypeScript strict, pnpm10.33.0, node:test, Git process argv; новых dependencies нет.

**Spec:** `docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md`, §4/7/11/12.

## Global Constraints

- Existing worktree `/private/tmp/orca-web-migration-audit`, feature/web-migration-audit; inline и один whole-foundation final review по разрешению пользователя.
- Runtime graph без Desktop/Electron/node-pty; contracts browser-safe. Без any/as any/console.log.
- Desktop прежние channels/signatures/DTO, locale ru/en и HMR bridge сохраняются. CLI dependency-free, HELP/envelope/exit codes без изменений.
- Проектная Git identity не требует открытия TaskStore для badge/list/read-only Git.
- Полный async Git/commonDir/effect reconciliation — следующий отдельный план B; текущие guard callbacks совместимы со старым API.
- Никаких Web/CLI UI, deployment, version bumps, merge/tag/release. Четыре docs/dashboard с кодом; финальный pack/open по всей задаче.

## Review Focus

- Git отложен очередью, проект удалён/readd либо root изменён: mutation не начинается; тест Task1.
- Живой worker появился во время проверки refs: checkout не переключает root; тест Task1.
- Unknown project badge раньше возвращал non-repo, а неизвестный initial mode empty: сохранить в verified adapter; Task2.
- Два клиента читают разные enabled agents/runs без смены selection; Task1/2.
- Domain error ru/en и Promise rejection должны сохранить IPC code; Task2.

### Task 1: Contracts и runtime commands

**Files:** create contracts/project-git-commands.ts, run-commands.ts, agent-commands.ts; runtime/project-git-commands.ts, run-commands.ts, agent-commands.ts; test/project-run-agent-commands.test.ts; modify barrels, git.ts, docs4/dashboard/plan.

**Interfaces:** ProjectGitCommands branch/branches/fetch/pull/checkout/initialCommit(context:ProjectCommandContext,...):Promise<existing DTO>. createProjectGitCommands(host) consumes project(id):Project|undefined, authorize, isCurrent, git.projectBranchInfo/projectBranches/projectFetch/projectPull/checkoutProjectBranch/createInitialCommit, liveAgents(id). Optional internal guard:()=>void runs inside Git queue before external mutation; checkout accepts number|(()=>number) for live agent recheck. RunCommands list/listWithCounts/close explicit project context, RunSummary extends Run with tasks/done; listRunsWithCounts(store) shared socket projection. AgentCommands list(clientContext,projectId?:string,refresh?:boolean):AgentInfo[], preflight(projectContext,roleId,runId?):Role; host supplies manager/discovery/preflight. Validation precedes lookup; results detached.

- [x] **Step 1:** Real ProjectManager/two Git repos/temp boards and discovery files; tests invalid/forged context/payload before lookup, detached DTO, branch/checkout/init including staged preservation, local bare fetch/pull, queued stale registration no external commit, live agent after await, runs close/history/status, per-project enabled agents and preflight role/flags. Assert actual Git HEAD/index/store JSON, not mock forwarding.
- [x] **Step 2:** `node --test packages/runtime/test/project-run-agent-commands.test.ts`; Expected FAIL missing factories.
- [x] **Step 3:** Implement contracts/factories, reusable run count projection; optional guard callbacks in async project Git and current-agent callback before checkout. Guards before network/ref/worktree changes, repeat after await; attribution only synchronous store writes.
- [x] **Step 4:** Runtime affected new commands + git/agent discovery/preflight/import boundaries, contracts/core/typechecks; Expected PASS. No changes to old Git algorithms outside current scope guard.
- [x] **Step 5:** Inspect diff/staged diff; code/tests/docs commit, task-done affected suite.

### Task 2: Desktop/socket adapters

**Files:** create main/project-run-agent-commands.ts/.test.ts; modify main/project-command-adapter.ts, index.ts, git.ts, socket.ts; docs4/dashboard/plan.

**Interfaces:** registerDesktopProjectRunAgentCommands(handle,host) consumes Task1 commands; six project Git channels explicit id, runs two legacy selected, agents one global context+optional selected id. Shared Desktop adapter exposes verified client context. Unknown project branch maps only command.projectNotFound to non-repo; invalid mode maps to empty before common validation. Native PTY/dialogs remain next plan.

- [ ] **Step 1:** Real services/repositories adapter tests: foreign caller before lookup/selection/Git, exact nine channels, A/B explicit Git, no-project runs[], global agents, unknown branch fallback, default empty initial commit, locale domain rejection and late removal no commit.
- [ ] **Step 2:** Desktop Node + ts-resolve adapter test; Expected FAIL missing register factory.
- [ ] **Step 3:** Wire common commands, remove inline projectRoot/liveAgentCount handlers as used; socket runs.list uses shared listRunsWithCounts (close already core). Keep agent socket capability filtering. Existing worker preflight factory stays reusable.
- [ ] **Step 4:** Desktop targeted adapter/project-git/initial-commit/agents/socket suites, runtime/Desktop typechecks, core docs/HELP; Expected PASS. Full verify at whole-foundation end.
- [ ] **Step 5:** Diff/staged diff/commit/task-done; continue dialogs/PTY and B/C/D/E/F without permission handoff.

Self-review: signatures align Task1→Task2; remaining dialogs/PTY and B–F intentionally in subsequent plans. Risks above pinned by real effects; native output/UI is user checked after final build.
