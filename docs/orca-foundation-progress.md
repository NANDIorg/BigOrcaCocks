# Готовность общего фундамента Orca

Требования: [утверждённая архитектура](superpowers/specs/2026-10-02-orca-shared-foundation-design.md), §12.
04.10.2026: реализация общего фундамента завершена. Web для собственного сервера,
терминальный UI CLI и их развёртывание — следующие отдельные проекты.

## Реализованные рубежи

| Рубеж | Результат | Основные планы |
| --- | --- | --- |
| A. Application API | Общие validated commands для профиля/config, board/global tasks, workers/coordinator, review/requests, Git/runs/agents, files/docs/rules/stats, dialogs/PTY; Desktop и agent socket используют один runtime | [Профиль](superpowers/plans/2026-10-04-orca-profile-commands.md), [файлы](superpowers/plans/2026-10-04-orca-file-commands.md), [Git/runs](superpowers/plans/2026-10-04-orca-project-run-agent-commands.md), [сессии/диалоги](superpowers/plans/2026-10-04-orca-session-dialog-commands.md) |
| B. Async effects | Общий Git process owner, canonical commonDir queue, scopes/stale/cancel guards, journal/reconciliation; прежний sync Git body удалён | [Git process](superpowers/plans/2026-10-04-orca-async-git-process.md), [workflow](superpowers/plans/2026-10-04-orca-workflow-async-integration.md), [reads](superpowers/plans/2026-10-04-orca-git-read-services.md), [recovery](superpowers/plans/2026-10-04-orca-effect-recovery.md) |
| C. Operator protocol | Handshake/capabilities, revisions/durable dedup, bounded snapshot/replay barrier, независимый project/dialog selection, writer leases; observer не потребляет agent check | [Протокол](superpowers/plans/2026-10-04-orca-operator-protocol.md) |
| D. Headless | Общая composition Desktop/Node, import без daemon startup, private loopback operator endpoint отдельно от agent socket, graceful shutdown/ownership и product backups | [Runtime/Node host](superpowers/plans/2026-10-04-orca-runtime-composition.md) |
| E. Client/UI | Browser-safe typed client с retry identity и late guards, HTTP/IPC ports; React/CSS/i18n/assets в общем UI, injected client/platform, Desktop bridge и HMR compatibility | [Client/UI](superpowers/plans/2026-10-04-orca-client-ui.md) |
| F. Поставка | Раздельные Node/Electron native roots, installed Linux artifact smoke в CI, независимые product branch/tag/manifest guards и release fixtures | [Native/releases](superpowers/plans/2026-10-04-orca-product-native.md) |

## Итоговые критерии §12

- [x] Desktop сохраняет полный цикл project → workflow → agent → human → review/merge: автоматические integration suites PASS; актуальный pack/open выполнен.
- [x] Production graph runtime/headless без Electron/Desktop; contracts/client/UI без Node, включая type-only/orphan/symlink guards.
- [x] Installed Linux headless artifact вне workspace: Node24, настоящий PTY/Git/legacy CLI, без DISPLAY/Electron и SHELL, без явной команды оболочки.
- [x] Два startup одного profile дают одного owner до backup/migrations; foreign live endpoint не затронут.
- [x] Независимые project/dialog двух клиентов; disconnect, duplicate send и поздний ответ проверены.
- [x] Observer не потребляет check; snapshot/replay barrier, expired cursor и bounded queues проверены.
- [x] Git не блокирует owner; commonDir serialization и stale effects проверены реальными hooks/processes.
- [x] Прежние данные/backup/restore/restart сохраняются; миграция Desktop путей на сервер не выполняется.
- [x] Старый agent CLI/skills совместимы; operator/secret методы не доступны агенту/browser principal автоматически.
- [x] Protocol/schema incompatibility блокирует запись; независимые release fixtures сохраняют Desktop feed/Latest/codenames.

## Проверки и передача

`pnpm verify` EXIT0: scripts51 + core944 + CLI38 + contracts50 + client3 + runtime1059 +
UI952 + Desktop994 = **4091/4091**, все typechecks и production builds PASS.
Один свежий независимый whole-range reviewer (`f7e429d..5be774b`) нашёл четыре Important;
все исправлены одним проходом с воспроизведением RED→GREEN: writer heartbeat не заполняет
durable ledger, повторный Desktop quit ждёт native/owner exit, Windows named pipe сохраняет
разделители, Linux service без SHELL использует системный sh. Minor/Critical не обнаружены.
Ошибка renderer build после переноса React устранена явным разрешением UI dependencies.

Последний installed Linux artifact smoke EXIT0: native PTY/default shell, Git, legacy CLI,
operator snapshot/disconnect, writer duplicate ровно один раз, second owner refusal/restart.
`pnpm --filter @orca-board/desktop run pack` EXIT0; приложение открыто и его процесс подтверждён:
`/private/tmp/orca-web-migration-audit/apps/desktop/release/local/mac/orca-board.app`.
После Electron rebuild настоящий Node PTY test **1/1 EXIT0**; native roots физически раздельны.
Автоматических UI-кликов не было; визуальную проверку выполняет пользователь в этом билде.

PR [#59 → develop](https://github.com/NANDIorg/BigOrcaCocks/pull/59) обновляется финальным
коммитом; CI проверяется именно на опубликованном HEAD. Merge, теги, публикации, version
bumps и изменение remote rulesets не входят в поручение. Desktop сохраняет прежний feed,
Latest, codenames и versions; CLI/Web workflows добавляются с их настоящими поставками.

Прежняя доставка `f7e429d` и её 44 evidence directories сохранены отдельно:
`/private/tmp/orca-worker-commands-evidence/delivery-final.json`.
Итоговые logs/review/rulings архивируются вне Git; технические решения не скрыты за статусом.

## Темп исполнения

По просьбе пользователя связанные изменения объединены в крупные блоки. По ходу выполнялись
значимые persistence/native regression checks и необходимые types; полные verify/core/task-done
повторы перенесены на конец. После найденной сборочной ошибки выполнен один исправленный
whole verify. Новые Web/CLI функции и дополнительные циклы ревью сюда не добавлялись.
