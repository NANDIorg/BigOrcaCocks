# orca-board — правила для разработки

Монорепо pnpm: `apps/desktop` (Electron: main / preload / renderer / shared), `packages/core`
(модель, store, промпты — TypeScript без сборки), `packages/cli` (голый JS, `bin/orca-board.js`),
`skills/` (инструкции координатора и воркера, вшиваются в сборку), `docs/` (архитектура и решения).
Полная картина — `docs/architecture.md`. Комментарии в коде, документация, коммиты и UI — на русском.

## Нельзя

- **Не запускать `git reset --hard`, `git checkout -- .`, `git clean` в скриптах и при проверках.**
  Так уже дважды стирали незакоммиченные правки (`docs/architecture.md`, «Грабли разработки»).
  Для проверок — только read-only git-команды. Коммитить сразу после зелёного typecheck.
- **Не импортировать `@orca-board/core` и npm-пакеты в `packages/cli/bin/orca-board.js`.** CLI запускается
  Node из Electron прямо из `Resources/cli`, без сборки и без `node_modules`. Общие функции дублируются:
  так сделано с `defaultSocketPath()` (`packages/core/src/paths.ts` ↔ `orca-board.js`). Меняй обе копии вместе.
- **Не добавлять node-импорты (`fs`, `path`, `os`…) в модули core, которые импортирует renderer**
  (`paths.ts`, `types.ts`, `global-tasks.ts` и др.). Окружение передаёт вызывающий код.
- **Не класть в `skills/*.md` ничего, что относится только к этому репозиторию** (pnpm, пути, стиль).
  Skills получают агенты **любого** проекта пользователя (`apps/desktop/src/main/prompts.ts` →
  `withRoleInstructions` в `apps/desktop/src/main/worker.ts`).
- **Не писать в skills и docs команды или флаги `orca-board`, которых нет в `HELP` CLI.** Это проверяет
  тест «команды в инструкциях и документации совпадают с CLI» в `packages/core/src/prompts.test.ts`.
  Новую команду сначала добавляй в `HELP`.
- **Не класть в payload событий длинный текст целиком.** Ответ урезается до `EVENT_ANSWER_LIMIT` (2000)
  с флагом `answerTruncated` (`eventAnswer()` в `packages/core/src/store.ts`). Полный текст отдаётся
  отдельной командой (`task answer`, `request get`, `question get`) — фикс 7b1fa05.
- **Не вызывать `git` через shell.** Только `execFileSync('git', [...])` (`apps/desktop/src/main/git.ts`),
  иначе ломаются Windows и экранирование.
- **Не хардкодить `:`, `/bin/zsh`, `~/.orca-board/orca.sock`.** Используй `path.delimiter`, `defaultShell()`
  (`src/main/pty.ts`), `defaultSocketPath()`. Всё платформозависимое — ветки `process.platform === 'win32'`
  в местах из таблицы «Кроссплатформенность» в `docs/architecture.md`. Новую ветку добавляй в эту таблицу.
- **Не коммитить отчёты и скрипты ревью** (`review/*.md`, `review/*.cjs` — так попали c4755bc, 9e36881).
  Ревьюер сдаёт отчёт через `orca-board done`, а не файлом в ветке.
- **Не запускать `pnpm pack`**: это встроенная команда pnpm. Сборка — `pnpm --filter @orca-board/desktop run pack`.
- **Не менять версию** вне задачи на релиз. Релиз — коммит `chore: release vX.Y.Z`, версия меняется
  одновременно в `/package.json` и `apps/desktop/package.json`.

## Обязательно

- **Новый IPC-канал — сразу в четырёх местах:** `apps/desktop/src/shared/ipc.ts` (`OrcaApi`),
  `preload/index.ts`, `preload/api.d.ts`, `registerIpc` в `main/index.ts`. Плюс строка в разделе «IPC»
  `docs/architecture.md`.
- **Renderer должен работать со старыми main и preload.** В `pnpm dev` renderer обновляется по HMR, а
  main и preload — только после перезапуска. Перед вызовом нового API проверяй, что он есть, и показывай
  «перезапустите приложение» вместо падения (фикс 086a654: `docsApi()` и `STALE_APP_MESSAGE` в
  `renderer/src/docLinks.ts`).
- **Новая команда или метод CLI проходит всю цепочку:** store (core) → метод сокета
  (`src/main/socket.ts`) → команда и `HELP` в `packages/cli/bin/orca-board.js` → разделы «Протокол
  сокета» / «CLI» в `docs/architecture.md` → `skills/*.md`, если команда нужна агенту → тест.
- **Меняешь поведение координатора или воркера — правь skills в том же коммите** и добавляй
  проверку в `prompts.test.ts`. Код, о котором не сказано в инструкции, агент не использует: фиксы
  0a77cb2, 2d3c5da, 7b1fa05 правили код и skills вместе.
- **Новое событие для координатора:** тип в `EventType` и `EVENT_TYPES` (`packages/core/src/types.ts`),
  список `--types` в `skills/coordinator.md` (три места в шаге 3: общий список, Monitor, запасной путь
  `check --wait`) и что делать по нему в шаге 4.
- **Меняешь формат состояния — пиши миграцию при загрузке store** (`migrateRequests`,
  `migrateGlobalTasks` в `packages/core/src/store.ts`). Проверь, что остаётся после рестарта:
  незакрытые dispatch, задачи в `in_progress`/`review` от старого кода (7b1fa05, 2d3c5da).
- **Тесты — рядом с кодом, `*.test.ts`, `node:test` + `node:assert`.** В desktop запускаются только
  `src/main/*.test.ts` и `src/renderer/src/*.test.ts` (скрипт `test` в `apps/desktop/package.json`):
  тест в подпапке (`about/`, `settings/`) не выполнится, клади его в `renderer/src/`
  (как `defaultsDiff.test.ts`). Логику из компонентов выноси в `.ts`-модуль и тестируй его
  (`boardSort.ts`, `duration.ts`, `docToc.ts`).
- **Обновляй docs в том же коммите:** `docs/architecture.md` (модель, IPC, сокет, CLI),
  `docs/nested-kanban.md` (глобальные задачи), `docs/human-requests.md` (запросы к человеку).
  Нашёл грабли — добавь их в раздел «Грабли разработки».

## Стиль кода

- TypeScript `strict` (`tsconfig.base.json`), без `any` и `as any` (сейчас в коде их нет — так и держим).
- Без `console.log` в main, core и renderer (сейчас нет ни одного).
- Комментарии и JSDoc — по-русски. Они объясняют «почему», а не пересказывают код (образец —
  `withRoleInstructions` в `packages/core/src/types.ts`).
- Ошибки для пользователя — по-русски и с контекстом: `роль «${r.id}»: системный промпт должен быть строкой`
  (валидация ролей в `src/main/projects.ts`).
- Renderer: компоненты лежат плоско в `renderer/src/*.tsx`, разделы «О проекте» и «Настройки» — в `about/`
  и `settings/`. Стили — `styles.css` (документы — `docs-markdown.css`), без CSS-in-JS и новых UI-библиотек.
  Иконки — `icons.tsx` / `docsIcons.tsx`.
- Markdown от агентов рендерить только через `Markdown.tsx` (`marked` + `DOMPurify`). Не использовать
  `dangerouslySetInnerHTML` в обход санитайзера.
- Новые зависимости — только если без них не обойтись, с объяснением в коммите. core зависит только от
  `typescript` (dev), cli — ни от чего.
- `*.cmd` — CRLF (`.gitattributes`) и сообщения латиницей: консоль Windows работает в OEM-кодировке.

## Проверки перед сдачей

Из корня worktree:

```
pnpm typecheck   # pnpm -r typecheck: core — tsc, desktop — tsc node+web, cli — node --check
pnpm test        # pnpm -r --if-present test: core, cli (test/cli.test.js), desktop (main + renderer)
```

- Обе команды должны пройти. Упавший тест не выключать и не подгонять под фактическое поведение
  без объяснения.
- Трогал skills, docs или HELP CLI — обязательно запусти `pnpm --filter @orca-board/core test`
  (`prompts.test.ts` сверяет команды).
- Трогал сборку, `electron-builder.yml` или node-pty — запусти `pnpm build`.
  `pnpm --filter @orca-board/desktop run pack` — только по просьбе: он пересобирает node-pty.
- UI-изменения typecheck не проверяет. В сводке `done` честно напиши, запускал ли `pnpm dev` и что
  проверил глазами; если не запускал — так и напиши.

## Git и ветки

- Работаешь в своём worktree на ветке `orca/<taskId>`. Ветку не переключай, в `master` сам не мержи:
  мержит приложение (`review accept` → `git merge --no-ff`, `mergeBranch` в `src/main/git.ts`).
- Коммиты — Conventional Commits на русском: `feat(renderer): …`, `feat(main,cli): …`, `fix: …`,
  `docs: …`, `refactor: …`, `chore: release vX.Y.Z`. Scope — слой: `core`, `main`, `cli`, `renderer`, `skills`.
  В теле — список изменений по файлам, для `fix` — **первопричина** (образец — 086a654).
- Один логический шаг — один коммит. Код, тесты, docs и skills одной фичи — в одном коммите.
- Не переписывать историю: никаких `rebase`, `commit --amend` уже запушенного, `push --force`.
- `git stash` общий для всех worktree. Не используй `git stash` / `git stash pop` без тега,
  временные правки откладывай WIP-коммитом.
