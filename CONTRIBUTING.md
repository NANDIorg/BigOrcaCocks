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
   Ветка и worktree по умолчанию **локальные**: на remote постоянно только `master` и `develop`
   (плюс максимум одна активная `release/*`).
4. Установи зависимости: `pnpm install --frozen-lockfile`. Делай небольшие Conventional
   Commits на русском вместе с тестами и документацией.
5. `pnpm verify` запускает проверки процесса, typecheck, все тесты и сборку.
   Для UI отдельно проверь приложение руками и перечисли сценарии в PR.
6. Публикация — только по явному решению владельца задачи (для агента — по явному поручению):
   тогда опубликуй ветку и открой PR с явным `--base develop`. После зелёного CI
   второй разработчик проверяет результат и одобряет PR. Слияние — merge commit.
   Ветка PR удаляется сразу после мержа (автоудаление GitHub) или отмены PR.
7. Релизы (в том числе срочные — `release/*` от `master`, без отдельных `hotfix/*` и `fix/*`),
   перенос исправлений обратно и работа через Orca — по [пошаговому регламенту](docs/git-flow.md).
   Агент сам доводит задачу до проверенной локальной ветки; push и PR — только по явному поручению.
   Он не выдаёт локальные проверки за CI и не одобряет PR от имени коллеги.

Изменение процесса тоже проходит PR. Не создавай копии правил в персональных промптах:
дай агенту ссылку на `AGENTS.md` и документы из него.

Общий фундамент уже реализован. Доменная модель и store — `packages/core`, browser-safe
контракты — `packages/contracts`, application services и Node backend — `packages/runtime`,
HTTP/IPC client — `packages/client`, React/CSS/i18n/assets — `packages/ui`.
`apps/desktop` подключает backend и UI к Electron, `apps/headless` запускает тот же backend
без окна, `apps/web` добавляет HTTP/auth, browser host и Linux-поставку. Карта зависимостей, запуск Node host и оставшаяся работа над Web/CLI —
[docs/shared-foundation.md](docs/shared-foundation.md).

Размещай общую бизнес-логику в core/runtime, клиентские контракты — в contracts,
представление — в UI. Runtime не импортирует Electron/Desktop; contracts/client/UI
не импортируют Node backend даже через type-only exports. Browser-safe части core
проверяются транзитивно. Native PTY передаёт host; Node и Electron устанавливают
его в разные корни, описанные в [архитектуре](docs/architecture.md).

Desktop shared-модули сохраняют совместимые экспорты; API и platform ports теперь
определены в client, общие UI-токены — в `packages/ui/shared`. Старый preload поддерживается
через UI-адаптер, пока отдельные экраны подключаются к typed operator client.
Web использует общий typed UI adapter и собственные auth/platform/server file actions.
Запуск, installed smoke и Linux bundle — [docs/web.md](docs/web.md).

Для локальной проверки одного пакета используй `pnpm --filter @orca-board/<пакет> test`
или `typecheck`; перед PR обязательный `pnpm verify` проверяет все workspace-пакеты,
границы импортов и сборки. После правок docs/skills/HELP обязательно проверяются
тесты core, которые сверяют документированные команды с реальным агентским CLI.
После всей пользовательской задачи собери и открой локальный Desktop по [AGENTS.md](AGENTS.md);
ручную проверку интерфейса выполняет пользователь.

Desktop, Web и будущий CLI имеют независимые версии/теги/выпуски: `vX.Y.Z`, `web/vX.Y.Z`,
`cli/vX.Y.Z`. Общие пакеты включаются из SHA сборки, без принудительного выпуска всех продуктов.
Web workflow проверяет Linux-поставку и создаёт отдельный Draft с latest=false; Desktop feed сохранён.
[Git Flow](docs/git-flow.md), [релизы](docs/releasing.md) и [установка Web](docs/web.md) описывают текущий порядок;
фактический результат и проверки — [журнал готовности](docs/orca-foundation-progress.md).
