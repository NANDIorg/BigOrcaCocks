# Установка Orca Web: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Понятная автоматизированная установка с закрытым доступом по умолчанию.
**Architecture:** Bash проверяет окружение и пакет. Node-мастер собирает подтверждённый план; отдельный provision настраивает systemd и HTTPS из проверенного пакета.
**Tech Stack:** Bash, Node 24, TypeScript, systemd, Caddy, Nginx/Certbot, node:test.
**Spec:** docs/superpowers/specs/2026-10-05-web-guided-install-design.md

## Global Constraints

- Linux x64, Ubuntu 24.04; без новых npm-зависимостей.
- Listener только 127.0.0.1, SSH по умолчанию; root и публичный доступ требуют подтверждения.
- Существующие аккаунты/профиль/сайты сохраняются. Root не запускает код обычного пользователя.
- Документация, комментарии и коммиты на русском. Отдельная feature-ветка от origin/develop.
- Web 2.1.0; версии остальных продуктов не меняются.

## Review Focus

- Прерывание и повторный запуск мастера без потери аккаунтов.
- Существующая root-установка 2.0.1 с незавершённой настройкой.
- Неожиданные домены/пути не попадают в конфигурацию привилегированного сервиса.
- Занятые порты и нестандартный proxy не приводят к перехвату сайта.
- Ошибка проверки/reload возвращает предыдущую конфигурацию веб-сервера.

### Task 1: Пошаговый мастер и повторная настройка

**Files:** apps/web/src/server/setup.ts, wizard.ts, setup-options.ts; apps/web/test/setup.test.ts.
**Interfaces:** `collectSetup(io, context): Promise<SetupChoices>`; `parseHostname(value): string`; `setup({ reconfigure? }): Promise<void>`.

- [x] Написать тесты закрытого доступа, подтверждений ROOT/OPEN, отказа, доменов и повторной настройки.
- [x] Запустить тесты; получить ожидаемый FAIL отсутствующего поведения.
- [x] Реализовать шаги, объяснения, сводку, скрытый пароль, сохранение аккаунтов/backup и configure.
- [x] Запустить весь Web suite; получить PASS.

### Task 2: Сервис и HTTPS

**Files:** apps/web/src/server/provision.ts, deployment.ts, control.ts; apps/web/test/provision.test.ts.
**Interfaces:** `provisionWeb(options): Promise<void>`; consumes validated WebConfig and installation identity.

- [x] Тесты генерации и валидации Nginx/Caddy, конфликтов, отката и service identity.
- [x] Запустить тесты; подтвердить FAIL до реализации.
- [x] Реализовать обнаружение прокси, установку Caddy/Certbot, ограниченные изменения, validation/reload/rollback и health.
- [x] Запустить Web suite; получить PASS.

### Task 3: Bootstrap, документация и Linux-приёмка

**Files:** apps/web/install-orca-web.sh; scripts/smoke-web-setup.mjs, smoke-web-bundle.mjs; docs/web.md.
**Interfaces:** Bootstrap runs packaged setup then provision from root-owned verified package, with explicit target identity.

- [x] Регрессионные тесты root-confirmation, зависимостей, existing install и безопасного bootstrap.
- [x] Подтвердить FAIL, реализовать bootstrap и обновить TTY smoke для нового мастера.
- [x] Обновить документацию установки/перенастройки и ограничения автоматизации.
- [x] Выполнить pnpm verify и Linux package/smoke; исправить воспроизведённые ошибки.
- [x] Независимое ревью всей ветки; конкретные замечания проверить RED→GREEN.
- [ ] Коммит/push/PR с проверками; Web release 2.1.0 по docs/releasing.md.
- [ ] Собрать и открыть локальный Desktop pack по AGENTS.md; сообщить путь приложения.

## Решения после ревью

- Поручение пользователя «Всё, делай» разрешает выполнение плана без повторных согласований; код остаётся в отдельном feature-worktree.
- Автоматизация поддерживает стандартные системные Caddy/Nginx. Неизвестный или контейнерный proxy требует ручного подключения: установщик не может безопасно переписать неизвестную инфраструктуру.
- Замечание о русском ответе «да» повышено с Minor до Important: игнорирование ответа выключало запрошенную автонастройку. Исправлено с регрессионным тестом.
- Все два Critical и шесть остальных Important исправлены после воспроизведения; отклонённых замечаний нет. Проверены непривилегированные записи, доверенный привилегированный runtime, полный откат, продление сертификата, IPv6, проверка preview, конфликты доменов и нестандартный каталог установки.
- Проверки внешнего DNS/firewall, настоящей выдачи сертификата и входа в CLI зависят от сервера и личных аккаунтов. Доступ не предоставлен; эти действия остаются у администратора. Linux-приёмка проверяет реальные процессы и UID, файлы, шаблоны и откат; CI дополнительно использует настоящий systemd.
- Перед перенастройкой работающего сервиса добавлено отдельное подтверждение `RESTART`, поскольку перезапуск завершает задания и терминалы.
- Системные XDG-папки могут иметь групповую запись. Она допустима только для одноимённой личной группы владельца без посторонних UID: проверяются основные и дополнительные участники. Для root допустимы только UID 0. Запись для посторонних, чужой владелец и симлинки запрещены. Собственные каталоги установки создаются с `umask 077`, повторно заданной после PAM; пакет и извлечённые файлы лишаются групповой/общедоступной записи независимо от машины сборки.
- Проверка личной группы учитывает именованные ACL-права пользователей и групп: посторонний писатель не получает исключение. Регрессия с настоящим Linux ACL воспроизведена RED→GREEN. Формат сверён с [Linux UAPI](https://github.com/torvalds/linux/blob/master/include/uapi/linux/posix_acl_xattr.h) и [константами прав](https://github.com/torvalds/linux/blob/master/include/uapi/linux/posix_acl.h).
- Default ACL может открывать запись новым папкам независимо от umask. Это воспроизведено с именованным посторонним UID; каждый новый каталог установки и его новые предки создаются сразу с 0700 под целевым UID. Существующие права не переписываются. Новая папка проектов тоже создаётся с 0700. Семантика наследования сверена с [acl(5)](https://man7.org/linux/man-pages/man5/acl.5.html).

Отложенных Minor-замечаний нет.

Локальная приёмка: `pnpm verify` — 4139 PASS, один Linux-only SKIP на macOS;
Web suite — 41/41. В отдельном Linux root-regressions — 2/2, установленный пакет,
PTY/auth/CSRF/restart, обычный пользователь и custom `/srv`, повторная настройка и
откат после ошибки DNS — PASS. Настоящие Caddy/systemd/sudoers/Nginx validators — PASS.
В Docker системный менеджер заменён тестовой границей с реальными процессами и UID;
проверка настоящего systemd предусмотрена в GitHub CI и Web release workflow.
