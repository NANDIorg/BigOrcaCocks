# Контракт интерфейса Orca

Общий UI принадлежит `packages/ui`, host variants подключаются через client/platform.
Токены, плотность и темы — [DESIGN.md](DESIGN.md). Runtime/permissions —
[docs/architecture.md](docs/architecture.md), серверные границы — [docs/web.md](docs/web.md).

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | Общие modal/form классы и useModalFocus | packages/ui/src/styles.css, useModalFocus.ts | Web login без modal, terminal setup в host | i18n/static checks; ручная keyboard проверка |
| Select/Listbox | Общие controls/PopupMenu | packages/ui/src/PopupMenu.tsx и styles.css | Web directory picker — список кнопок серверных каталогов | path guards, stale response guard, ручной focus |
| CRUD | Существующие панели/диалоги общего UI | packages/ui/src/App.tsx и typed UI client | project selection per client; file actions скачивают в Web | scoped revision/dedup tests и installed smoke |
| Toast | Общий UI feedback и Web session bar | ipcError.ts, main.tsx Web shell | Web expiry возвращает login; mismatch требует reload | error/expiry guards и ручная визуальная приёмка |
| Scrollbar | Общие scroll surfaces | packages/ui/src/styles.css | Web picker ограничен max-height | статическая проверка и ручной narrow viewport |

Web не создаёт вторую доску или редактор workflow. Login принимает password manager/paste,
пароль маскируется, явная кнопка раскрывает; pending блокирует повторный submit. Cancel/escape
каталога возвращает прежний экран, поздний ответ не меняет новый выбор. API error не выдаёт
секреты и показывает перевод общего кода. При потере связи задания продолжаются; cursor
recovery перечитывает чат/доску и восстанавливает доступный tail терминала. Writer подтверждается
отдельной кнопкой и освобождается при hide/detach. Старый browser bundle не монтирует рабочий
UI и требует reload перед записями. Native file actions в Web подписаны «Скачать».

Ручную проверку screen states, locale/theme/reduced motion и клавиатуры выполняет пользователь
в рабочем билде. Автоматического обхода экранов и кликов по правилам AGENTS.md нет.

Обновления Web используют общие UpdateCard/UpdateBanner/useUpdates: mode server,
прогресс worker, подтверждение restart, reload/login после установки. Source/unmanaged
host имеет реальную проверку и явный fallback, без имитации установки.
