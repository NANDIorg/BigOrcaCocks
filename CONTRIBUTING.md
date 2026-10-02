# Разработка orca-board

Начни с [CLAUDE.md](CLAUDE.md): ограничения архитектуры, стиль и проверки.
Полный командный процесс — [docs/git-flow.md](docs/git-flow.md).
Выпуск по поручению «собери релиз» — [docs/releasing.md](docs/releasing.md).
Устройство приложения — [docs/architecture.md](docs/architecture.md).

1. Используй отдельный clone и собственную Git/GitHub-учётную запись. Node 24,
   pnpm **10.33.0** (поле `packageManager`), Git и `gh` для работы с PR.
2. Возьми задачу, запиши владельца и критерии готовности в Issue или описание PR.
   Один владелец ветки; параллельные агенты не пишут в один worktree.
3. `git fetch origin --prune`, затем создай `feature/<issue>-<slug>` от `origin/develop`
   в отдельном worktree. Номер Issue необязателен, имя должно однозначно называть задачу.
4. Установи зависимости: `pnpm install --frozen-lockfile`. Делай небольшие Conventional
   Commits на русском вместе с тестами и документацией.
5. `pnpm verify` запускает проверки процесса, typecheck, все тесты и сборку.
   Для UI отдельно проверь приложение руками и перечисли сценарии в PR.
6. Опубликуй свою ветку и открой PR с явным `--base develop`. После зелёного CI
   второй разработчик проверяет результат и одобряет PR. Слияние — merge commit.
7. Релизы, hotfix, перенос исправлений обратно и работа через Orca — по
   [пошаговому регламенту](docs/git-flow.md). Агент сам доводит задачу до готового PR,
   но не выдаёт локальные проверки за CI и не одобряет PR от имени коллеги.

Изменение процесса тоже проходит PR. Не создавай копии правил в персональных промптах:
дай агенту ссылку на `AGENTS.md` и документы из него.

Общие DTO и чистые функции находятся в `packages/contracts`; доменная модель и store —
в `packages/core`. Contracts не зависит от Node/Electron/Desktop. Его отдельная проверка —
`pnpm --filter @orca-board/contracts test`; корневой `pnpm verify` включает её автоматически.
Desktop API и составные настройки остаются в `shared/desktop-api.ts` и
`shared/desktop-settings.ts`; прежний `shared/ipc.ts` сохраняет совместимые экспорты.
Runtime, серверный API, общий UI и независимые релизные инструменты ещё предстоит извлечь
по [согласованной архитектуре](docs/superpowers/specs/2026-10-02-orca-shared-foundation-design.md).
