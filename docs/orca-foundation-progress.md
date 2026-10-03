# Готовность общего фундамента Orca

Авторитет требований: [утверждённая архитектура](superpowers/specs/2026-10-02-orca-shared-foundation-design.md), особенно §12.
04.10.2026 пользователь поручил самостоятельно пройти все оставшиеся этапы без промежуточных запросов «продолжать?». Исполнение inline, один независимый итоговый reviewer. Web, терминальный UI CLI и развёртывание сервера — последующие проекты.

## Подтверждённая база

Общие contracts, persistence/projects, launcher/sessions/workers, workflow/review services, agent discovery/preflight, assistant transports/dialog registry/history, profile ownership/bootstrap извлечены. Desktop использует общий board/global-task/coordinator/worker/review/human-request command API. Перенос review/requests: [план и проверки](superpowers/plans/2026-10-04-orca-review-request-commands.md), общий API `68b875b`, IPC/socket подключены следующим коммитом; полный verify3675/3675, typecheck/build PASS. Последняя полная доставка: `f7e429d`, verify3634/3634, CI10/10, локальный Desktop собран и запущен. Её delivery receipt: `/private/tmp/orca-worker-commands-evidence/delivery-final.json`. Перенос service сам по себе не подтверждает готовность headless/client/UI.

## Оставшиеся рубежи

| Рубеж | Проверяемый результат | Статус |
| --- | --- | --- |
| A. Полный application API | Review, вопросы/requests, проекты/settings/types/templates, files/docs/rules/stats, dialogs/PTY; явный client/project и host principal, runtime validation, Desktop/socket вызывают общие операции | Review/requests подключены. Profile/config API и Desktop31 IPC: [план](superpowers/plans/2026-10-04-orca-profile-commands.md), verify3720/3720 и typecheck/build PASS. Rules/stats services/API: [план](superpowers/plans/2026-10-04-orca-rules-stats-commands.md), targeted34/34, runtime764/764, contracts50/core943 и types PASS; Desktop подключается. Далее — files/docs/showcase, Git проекта, runs/agents и dialogs/PTY |
| B. Async effects | Async Git, очередь по canonical commonDir; независимые repo параллельны, EffectToken после await, отмена/устаревший результат и restart reconciliation | Ожидает A |
| C. Протокол и клиенты | Handshake/capabilities, revisions/dedup, bounded observer replay с barrier, независимый выбор project/dialog, writer leases; disconnect сохраняет процессы | Ожидает A/B |
| D. Headless | Общая runtime composition, импорт без старта daemon; local operator endpoint отдельно от agent socket, graceful stop; Node24/Linux без DISPLAY, установленный artifact вне workspace с настоящим PTY | Ожидает A/B/C |
| E. Client и UI | Browser-safe client/reconnect и React UI; client/platform injection, Desktop bridge к старому preload и HMR, неизменный интерфейс | Ожидает A/C |
| F. Поставка | Раздельные Node/Electron native roots, product-aware release guards/fixtures/docs; Desktop feed/Latest/codenames сохраняются | Ожидает D/E |

Детальные планы фиксируются перед каждым переносом на фактическом коде. После коммитов эта таблица получает ссылки на реализацию и фактические проверки. Ни один рубеж не помечается готовым по наличию папки или заглушки.

## Итоговые критерии §12

- [ ] Desktop сохраняет полный цикл project → workflow → agent → human → review/merge; актуальный pack/open.
- [ ] Production graph runtime/headless без Electron/Desktop; contracts/client/UI без Node.
- [ ] Installed Linux headless artifact вне workspace: настоящий PTY/Git, без DISPLAY/Electron.
- [ ] Два startup одного profile дают одного owner до backup/migrations; foreign endpoint не затронут.
- [ ] Независимые project/dialog двух клиентов; disconnect, повторная send и поздний ответ проверены.
- [ ] Observer не потребляет check; snapshot/replay barrier, expired cursor и bounded queues проверены.
- [ ] Git не блокирует owner; commonDir serialization и stale effects проверены.
- [ ] Прежние данные/backup/restore/restart сохраняются; без миграции путей на сервер.
- [ ] Старый agent CLI/skills совместимы, operator/secret методы не доступны агенту/browser principal автоматически.
- [ ] Protocol/schema incompatibility блокирует запись; независимые release fixtures сохраняют Desktop feed/Latest/codenames.

Итоговая доставка: полный verify, один fresh review оставшегося диапазона и исправление блокирующих замечаний с RED→GREEN; локальный pack/open, PR #59 → develop и CI финального HEAD. Merge, публикации, теги и изменение remote rulesets не входят в поручение. Ручной UI проверяет пользователь; автоматических кликов нет.
