# План: морские кодовые имена Orca

> Исполнение: superpowers:executing-plans, последовательно в назначенном worktree.

**Цель:** общий неизменяемый реестр имён для серий major/minor, GitHub Release и интерфейса.

**Архитектура:** JSON в core → чистое API TypeScript → About/renderer и Node 24 guard → outputs/env Release workflow.

**Стек:** TypeScript, JSON, Node 24, Git, существующие React/Electron и GitHub Actions; новых зависимостей нет.

**Спецификация:** docs/superpowers/specs/2026-09-30-release-codenames.md.

- [x] Core: release-codenames.json/ts/test.ts, экспорт index.ts. RED → GREEN: patch наследует имя, неизвестная версия, дубликаты, запрет переназначения и удаления. API: releaseCodename, releaseVersionLabel, releaseTitle, validateReleaseCodenames.
- [x] Guard/workflow: scripts/check-release-codenames.mjs/test.mjs, package.json, ci.yml, release.yml. RED → GREEN на настоящих Git-фикстурах: текущая серия, историческое имя, база PR, плохой ref, legacy без реестра, GitHub outputs. Полная история checkout и передача title через env.
- [x] UI/документация: about-content.ts/test.ts, main strings, updateState.ts/test.ts; CLAUDE.md, git-flow.md, releasing.md, architecture.md, about-window.md, DESIGN.md. Реальные подписи версии ru/en и fallback; резервирование имени перед релизом описано.
- [x] pnpm verify, DESIGN lint, actionlint; локальный pack/codesign/open без автоматического UI-прохода.

Передача результата: commit всех собственных файлов, push feature/onboarding-redesign и обновление PR #29.
