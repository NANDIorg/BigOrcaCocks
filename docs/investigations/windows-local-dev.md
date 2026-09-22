# Windows: локальный запуск репозитория (dev и сборка)

Исследование без правок кода продукта. Вопрос: почему на Windows не получается склонировать
orca-board и выполнить `pnpm install` → `pnpm dev` / `dist:win`. Проверка шла по исходникам
и `node_modules` на macOS (pnpm 12.5.1, Node 24.15, electron 38.8.6, electron-builder 26.15.3,
@electron/rebuild 4.2.0, node-pty 1.1.0). На живой Windows ничего не запускалось, поэтому
в каждом пункте указано, откуда взят вывод: из кода или из поведения инструмента.

## Итог

Скорее всего `pnpm install` падает на `postinstall` десктопа: `electron-builder install-app-deps`
пересобирает node-pty из исходников через node-gyp, а на обычной Windows нет MSVC, Spectre-библиотек
и Python. Второй кандидат: pnpm без поддержки `allowBuilds` не запускает build-скрипты,
и Electron остаётся без бинарника. Скрипты `package.json` сами по себе совместимы с cmd.exe:
в них нет `rm -rf`, `cp`, `VAR=x cmd` или bash-синтаксиса.

## Проблемы по убыванию важности

### 1. `postinstall` пересобирает node-pty из исходников, нужен полный тулчейн MSVC — **блокер**

- **Где:** `apps/desktop/package.json:11`: `"postinstall": "electron-builder install-app-deps"`;
  `apps/desktop/electron-builder.yml:37`: `npmRebuild: true`.
- **Почему:** `install-app-deps` вызывает `@electron/rebuild`. Он пропускает сборку только когда
  находит готовый бинарник в формате prebuildify (`prebuilds/<plat>-<arch>/electron.napi.node`
  или `node.napi.node`), prebuild-install или node-pre-gyp
  (`@electron/rebuild/lib/module-rebuilder.js:118-124`, `lib/module-type/prebuildify.js:26-55`).
  В node-pty 1.1.0 prebuilds для `win32-x64` есть, но они называются `pty.node` и `conpty.node`,
  а prebuildify в devDependencies нет. Rebuild их не распознаёт и запускает `node-gyp rebuild`.
  В `binding.gyp` node-pty на Windows стоит `'SpectreMitigation': 'Spectre'`
  (`node_modules/node-pty/binding.gyp:8-9`), плюс собираются conpty и winpty.
- **Симптом на Windows:** `pnpm install` падает на `apps/desktop postinstall` с ошибкой вроде
  `gyp ERR! find VS could not find a version of Visual Studio`, `find Python` или
  `MSB8040: Spectre-mitigated libraries are required for this project`. Если pnpm при этом
  не продолжает работу, `pnpm dev` дальше тоже не запустится.
- **На macOS не проявляется**, потому что там есть Xcode CLT: сборка проходит незаметно.
- **Что предложить:**
  1. Короткий путь, только документация: в README добавить требования для Windows.
     Нужны Visual Studio 2022 Build Tools с нагрузкой «Desktop development with C++»,
     компонентом «MSVC … Spectre-mitigated libs (Latest)» и Windows SDK, а также Python 3.
  2. Правильный путь: не пересобирать node-pty. node-pty 1.x работает на N-API,
     `lib/utils.js:17-19` сам загружает `prebuilds/<platform>-<arch>`, так что бинарник подходит
     и для Electron. Можно заменить `postinstall` на Node-скрипт, который пропускает
     `install-app-deps` на win32. Либо вызывать `electron-builder install-app-deps`
     только перед `pack`/`dist`, а в `electron-builder.yml` поставить `npmRebuild: false`,
     так уже сделано в `dist:win` (`apps/desktop/package.json:15`).
  3. Проверить на живой Windows, что `pnpm dev` запускает PTY на prebuild-бинарнике.

### 2. `allowBuilds` понимают только новые pnpm, а версия pnpm нигде не закреплена — **блокер, зависит от версии**

- **Где:** `pnpm-workspace.yaml:4-8` (`allowBuilds: electron, esbuild, node-pty, …`). В корневом
  `package.json` нет полей `packageManager` и `engines`.
- **Почему:** pnpm 10+ по умолчанию не запускает install-скрипты зависимостей и разрешает их
  только по списку. Ключ `allowBuilds` есть только в свежих версиях pnpm, в более старых
  аналог назывался `onlyBuiltDependencies`. Если у разработчика на Windows установлен pnpm
  из старого `npm i -g pnpm`, ключ игнорируется, и electron с esbuild не выполняют свой `install`.
- **Симптом:** `pnpm install` проходит с предупреждением `Ignored build scripts: electron, esbuild, node-pty…`,
  затем `pnpm dev` падает с `Error: Electron failed to install correctly, please delete node_modules/electron and try installing again`
  или на загрузке бинарника esbuild.
- **Фикс:** добавить в корневой `package.json` `"packageManager": "pnpm@<версия>"` (подхватывается
  через `corepack enable`) и `"engines": { "node": ">=24", "pnpm": ">=<версия>" }`, а в README
  написать `corepack enable` вместо «pnpm». Для совместимости со старыми pnpm можно продублировать
  список в `onlyBuiltDependencies`.

### 3. `.gitattributes` задаёт окончания строк только для `*.cmd`, sh-обёртка получает CRLF — **высокая**

- **Где:** `.gitattributes:1` содержит одну строку: `*.cmd text eol=crlf`. Затронуты
  `packages/cli/bin/orca-board:1` (`#!/bin/sh`) и `packages/cli/bin/orca-board.js:1` (`#!/usr/bin/env node`).
- **Почему:** Git for Windows по умолчанию ставится с `core.autocrlf=true`, поэтому все текстовые
  файлы без атрибута извлекаются с CRLF. Claude Code на Windows выполняет команды через Git Bash.
  В `PATH` воркера первой стоит `packages/cli/bin` (`apps/desktop/src/main/worker.ts:22-23,136`),
  и в bash `orca-board` находит файл без расширения, то есть sh-скрипт, а не `.cmd`.
- **Симптом:** в терминале агента при dev-запуске `orca-board done …` падает с
  `/bin/sh^M: bad interpreter` или `$'\r': command not found`. Воркер не может отчитаться,
  хотя приложение открылось. Node читает CRLF в `.js` без проблем.
- **Фикс:** заменить `.gitattributes` на:
  ```
  * text=auto eol=lf
  *.cmd text eol=crlf
  *.bat text eol=crlf
  *.png binary
  *.ico binary
  ```
  Затем выполнить `git add --renormalize .`. На уже сделанных клонах поможет `git rm --cached -r . && git reset --hard`.

### 4. В README нет инструкции «из исходников» для Windows — **высокая**

- **Где:** `README.md:66-87`. Раздел «Из исходников» пустой, в «Требованиях» перечислены
  только Node 24, pnpm, git и claude. Раздел Windows (`README.md:49-63`) описывает только готовую сборку.
- **Чего не хватает:**
  - VS Build Tools, Spectre-библиотек и Python (см. п. 1);
  - `corepack enable` и конкретной версии pnpm (п. 2);
  - `git config --global core.autocrlf false` или `input` перед клоном (п. 3);
  - `git config --global core.longpaths true` и совета клонировать в короткий путь (п. 6);
  - указания, что в dev-режиме `orca-board.cmd` берёт **системный** `node`
    (`packages/cli/bin/orca-board.cmd:11-13`), потому что `ORCA_NODE` выставляется только
    при `app.isPackaged` (`apps/desktop/src/main/worker.ts:142`), так что Node должен быть в PATH;
  - предупреждения, что `pack`, `dist` и `dist:mac` работают только на macOS (п. 5).
- **Фикс:** добавить подраздел «Windows: запуск из исходников» с этими шагами.

### 5. Скрипты `pack`, `dist` и `dist:mac` жёстко собирают mac — **средняя**

- **Где:** `apps/desktop/package.json:12-14` (`electron-builder --mac …`).
- **Симптом на Windows:** `pnpm --filter @orca-board/desktop run pack` или `dist` падает с ошибкой
  electron-builder о том, что сборка под macOS возможна только на macOS. README называет `pack`
  основной командой сборки (`README.md:91`), поэтому пользователь Windows начнёт с неё.
- **Фикс:** сделать `pack` и `dist` без `--mac`, чтобы собиралась текущая платформа, добавить
  `pack:win` (`electron-builder --win --dir`) и отметить в README, что на Windows нужен `dist:win`.
  В `dist:win` уже стоит `npmRebuild=false`, но хвостовой `&& electron-builder install-app-deps`
  (`package.json:15`) снова запускает пересборку node-pty из п. 1.

### 6. Длинные пути: pnpm-store, worktree рядом с репо — **средняя**

- **Где:** worktree создаётся в `<repo>/../.orca-worktrees/<taskId>`
  (`apps/desktop/src/main/worker.ts:151,174`), и в каждом ставятся зависимости по lock-файлу.
  Имена в `.pnpm` длинные, например
  `electron-builder@26.15.3_electron-builder-squirrel-windows@26.15.3_supports-color@7.2.0/node_modules/…`,
  а node-gyp добавляет к ним ещё `build\Release\obj\…`.
- **Симптом:** при глубоком клоне (`C:\Users\<имя>\Documents\projects\…`) появляются
  `ENAMETOOLONG` и `EPERM` в pnpm, `Filename too long` в git при `worktree add`
  и ошибки MSBuild с путями больше 260 символов.
- **Фикс:** в README предложить клонировать в короткий путь (`C:\src\orca-board`),
  выполнить `git config --global core.longpaths true` и включить `LongPathsEnabled`
  (реестр или групповая политика). pnpm на Windows уже укорачивает имена
  (`virtual-store-dir-max-length`), поэтому его настройки менять не нужно.

### 7. Нет `.npmrc` и настроек загрузки Electron — **низкая, зависит от окружения**

- **Где:** `.npmrc` в репозитории нет.
- **Симптом:** за корпоративным прокси или антивирусом загрузка Electron и winCodeSign
  (`electron-builder`) обрывается, а Defender блокирует `winpty-agent.exe` в `node_modules`.
  Это не особенность Windows как таковой, но на рабочих Windows-машинах встречается часто.
- **Фикс:** в README упомянуть `ELECTRON_MIRROR` и `ELECTRON_BUILDER_BINARIES_MIRROR`
  и исключение папки репозитория из проверки Defender. Код продукта менять не нужно.

## Что проверено и оказалось в порядке

| Что | Где | Вывод |
|---|---|---|
| Корневые скрипты | `package.json:5-10` | Только `pnpm …`, без shell-специфики |
| `&&` в скриптах | `apps/desktop/package.json:12-15` | cmd.exe поддерживает `&&` |
| `rm -rf`, `cp`, `VAR=x cmd`, `export` | все `package.json` | Нет, cross-env, rimraf и shx не нужны |
| `echo skip` | `packages/cli/package.json:9`, `packages/core/package.json:10` | Работает в cmd |
| Тесты core | `packages/core/package.json:11` (`node --test src/*.test.ts`) | cmd не раскрывает `*`, но Node 22+ раскрывает glob в `--test` сам. Type stripping в Node 24 включён по умолчанию |
| Тест CLI | `packages/cli/test/cli.test.js:12-13` | Использует `tmpdir()` и именованный канал на win32 |
| typecheck | `apps/desktop/package.json:10`, `packages/cli/package.json:8` | `tsc … && tsc …` и `node --check`, всё кроссплатформенно |
| Конфиг electron-vite | `apps/desktop/electron.vite.config.ts` | Пути через `resolve(__dirname, …)` |
| Симлинки в git | `git ls-files -s \| grep ^120000` | Нет. pnpm на Windows использует junction, прав администратора не нужно |
| Каталог `scripts/` с sh-скриптами | — | Нет |
| `orca-board.cmd` | `packages/cli/bin/orca-board.cmd` | CRLF задан в `.gitattributes`, логика рабочая |
| Сокет CLI | `packages/core/src/paths.ts:14`, `packages/cli/bin/orca-board.js:12` | На win32 используется `\\.\pipe\orca-board` |
| Оболочка и PATH в main | `apps/desktop/src/main/pty.ts:33`, `apps/desktop/src/main/index.ts:24` | Ветки для win32 есть (COMSPEC, без `-ilc`) |
| Вызов git | `apps/desktop/src/main/git.ts:5-8` | `execFileSync` с массивом аргументов, без shell |

## Как проверить на живой Windows (чек-лист)

1. Чистая Windows 11 с Node 24 и Git for Windows по умолчанию (`autocrlf=true`), без VS Build Tools.
2. `corepack enable`, `git clone`, `pnpm install`. Ожидается падение по п. 1 или предупреждение по п. 2.
3. Поставить VS Build Tools со Spectre-библиотеками и Python, повторить `pnpm install`, затем `pnpm dev`.
4. В приложении запустить воркера на Claude Code и выполнить в его Bash `orca-board --help`.
   Ожидается ошибка `bad interpreter` по п. 3.
5. `pnpm --filter @orca-board/desktop run dist:win`.
