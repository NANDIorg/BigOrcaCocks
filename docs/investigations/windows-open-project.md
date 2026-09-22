# Windows: не открывается (не добавляется) локальный проект

Исследование без правок кода продукта. Интерпретация: в запущенном приложении кнопка «+» (добавить
репозиторий) на Windows не приводит к появлению проекта. Живой Windows не было — выводы по коду,
часть причин воспроизведена на macOS тестом `apps/desktop/src/main/projects.win32.test.ts`
(`pnpm --filter @orca-board/desktop test`).

## Путь «открыть проект»

1. `App.tsx:351` `addProject()` → `window.orca.projects.add()` (`preload/index.ts:18`, IPC `projects:add`).
2. `main/index.ts:306-311`: `dialog.showOpenDialog(win, { properties: ['openDirectory'] })` →
   `projects.add(res.filePaths[0])`. Путь из диалога — нативный: `C:\Users\Иван\repo`.
3. `main/projects.ts:110-133` `ProjectManager.add`: `execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd })`;
   **любая** ошибка → `«<path> — не git-репозиторий»`. Корень — вывод git (`C:/Users/Иван/repo`, прямые слэши),
   дедуп `p.root === root`, `id = sha1(root).slice(0,10)`, `name = basename(root)`, запись в
   `%APPDATA%\orca-board\projects.json`.
4. `App.tsx:352-353`: если вернулся проект — `refreshProjects()` (`projects:list`, `board:get`, `agents:list`).

Сокет, worktree и `.orca-worktrees` в момент добавления не участвуют — они нужны позже, при старте
воркера/координатора и работе CLI.

## Что уже сделано в задачах Win32 (git log)

- `8abf9dc` — сокет → именованный канал `\\.\pipe\orca-board` (`core/src/paths.ts`, `socket.ts:333`).
- `8005d0e`, `eb3573e` — оболочка по умолчанию, запуск агентов без cmd.exe, `findBin` с PATHEXT, `mergeEnv` для `Path`.
- `3b1b5e4` — `orca-board.cmd`, win-цели electron-builder.
- `d330fec` — аудит `git.ts`: git только `execFileSync` массивом, без shell. Вывод «git.exe находится по PATH» —
  верен, но **не проверено, что git вообще есть в PATH GUI-процесса** и как обрабатываются ошибки git.

Пропущено: путь добавления проекта (`projects.ts` / `projects:add` / `App.tsx`) ни одна Win32-задача не трогала;
single-instance для Windows-трея; `safe.directory`.

## Причины, по убыванию вероятности

### 1. Ошибка добавления проглатывается: в UI ничего не происходит — вероятность очень высокая (усилитель всех прочих)

- `apps/desktop/src/renderer/src/App.tsx:351-354` — `addProject()` без `try/catch`. `ipcRenderer.invoke`
  отклоняется, промис уходит в unhandled rejection, пользователь видит: выбрал папку — и ничего.
  В соседних действиях (`App.tsx:307`, `:321`, `:366`) ошибки показываются через `alert(ipcErrorMessage(e))`, здесь — нет.
- `apps/desktop/src/main/projects.ts:112-116` — `catch {}` заменяет любую ошибку git (ENOENT, dubious ownership,
  таймаут, битый `.git`) на «не git-репозиторий». Даже если сообщение дойдёт до UI, оно вводит в заблуждение.
- Почему именно Windows: на macOS git есть почти всегда и владелец каталога совпадает, поэтому ветка ошибки
  там почти не встречается; на Windows её регулярно дают причины №2 и №3.
- Воспроизвести: любая ошибка в `add()` (например, выбрать не-репозиторий) — в UI нет реакции, в DevTools
  `Uncaught (in promise) Error: Error invoking remote method 'projects:add'`.
- Фикс: в `addProject()` — `try/catch` + `alert(ipcErrorMessage(e))` (как у соседей). В `add()` различать
  `code === 'ENOENT'` («git не найден в PATH…») и `stderr` git (показывать его текст, для dubious ownership —
  подсказку `git config --global --add safe.directory <путь>`).

### 2. Git отказывается работать с репозиторием: «detected dubious ownership» (safe.directory) — высокая

- `apps/desktop/src/main/projects.ts:113` (`rev-parse`), дальше все вызовы `main/git.ts:8`, `main/worker.ts:177-179`.
- Почему Windows: Git ≥ 2.35.2 проверяет, что владелец каталога репозитория — текущий пользователь. На Windows
  это не так для репозиториев на FAT32/exFAT/флешке, сетевом диске, в `\\wsl$\…`/`\\wsl.localhost\…`, для
  клонированных из-под администратора или другим пользователем, скопированных с другого ПК, в `C:\` вне профиля.
  `git rev-parse` падает с кодом 128 → причина №1 → «не git-репозиторий» или тишина.
- Воспроизвести: на Windows — репозиторий на exFAT-флешке или в `\\wsl.localhost\Ubuntu\home\…`; в консоли
  `git -C <путь> rev-parse --show-toplevel` → `fatal: detected dubious ownership`. На macOS/CI —
  `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` (тестовый флаг git), см. тест «dubious ownership» в `projects.win32.test.ts`.
- Фикс: показать stderr git и готовую команду `safe.directory` (или кнопку «доверять этому каталогу», которая
  выполнит `git config --global --add safe.directory <root>` с подтверждением пользователя). Молча добавлять
  `safe.directory=*` через `-c` не стоит — это отключение защиты git.

### 3. `git` нет в PATH GUI-процесса (ENOENT) — средне-высокая

- `apps/desktop/src/main/index.ts:23-24` — на Windows `shellPath()` сразу `null`, берётся PATH процесса как есть.
  `apps/desktop/src/main/agents.ts:21-32` — `extraPathDirs()` добавляет папки агентов, но не папки git;
  к тому же `execFileSync('git')` в `projects.ts:113` / `git.ts:8` использует только `process.env.PATH`, а не `findBin`.
- Почему Windows: git не входит в систему. Типичные случаи: git поставлен только вместе с GitHub Desktop /
  SourceTree / VS (их git не в PATH); при установке Git for Windows выбрано «Use Git from Git Bash only»;
  git (scoop/winget) поставлен после входа в систему, а приложение стартует из уже запущенного Explorer/трея
  со старым PATH; portable-сборка из архива. `execFileSync` → `spawnSync git ENOENT` → «не git-репозиторий».
  Node без shell ищет только `git.exe`/`git.com` — `git.cmd`/`.bat`-шимы не подхватятся.
- Воспроизвести: убрать `C:\Program Files\Git\cmd` из PATH пользователя, перезапустить Explorer/выйти из
  системы, запустить orca-board, добавить заведомо валидный репозиторий. На macOS — тест «git не найден в PATH»
  (подмена `PATH`).
- Фикс: искать git через `findBin('git')` + стандартные места (`%ProgramFiles%\Git\cmd`,
  `%LOCALAPPDATA%\Programs\Git\cmd`, `%USERPROFILE%\scoop\shims`), кэшировать абсолютный путь и использовать
  его во всех `execFileSync('git', …)`; при отсутствии — явная ошибка «git не найден, установите Git for Windows».
  Проверку можно вывести на экран «Агенты»/«Настройки» рядом с детектом агентов.

### 4. Второй экземпляр приложения (трей + повторный запуск) — средняя

- `apps/desktop/src/main/index.ts:390-430` — нет `app.requestSingleInstanceLock()`. `apps/desktop/src/main/socket.ts:333-337` —
  `server.listen('\\.\pipe\orca-board')` без обработчика `'error'`. `apps/desktop/src/main/projects.ts:66-69,84-87` — каждый
  экземпляр держит `projects.json` в памяти и перезаписывает файл целиком.
- Почему Windows: по умолчанию `keepInBackground: true` — закрытие окна оставляет процесс в трее. На macOS
  повторный запуск из Dock активирует тот же процесс (`activate`), на Windows ярлык/меню «Пуск» запускает
  **второй процесс**. У второго канал занят → `EADDRINUSE` → «A JavaScript error occurred in the main process»;
  проект, добавленный во втором окне, перетирается первым экземпляром при его следующем `save()` (любая смена
  активного проекта/настроек), а CLI агентов продолжает ходить в первый экземпляр, который о проекте не знает
  (`project not found`). Выглядит как «проект не открывается / пропадает».
- Воспроизвести: запустить orca-board, закрыть окно (остаётся в трее), запустить ярлык ещё раз → диалог
  об ошибке; добавить проект во втором окне, переключить проект в первом (через трей) → проект исчез из `projects.json`.
- Фикс: `requestSingleInstanceLock()`; при неудаче — `app.quit()`, в первом — `second-instance` → `showWindow()`.
  На `server.on('error')` — понятное сообщение.

### 5. Корень диска и отображение пути — низкая (косметика, не блокирует)

- `apps/desktop/src/main/projects.ts:126` — `name: basename(root)`: для репозитория в корне диска git отдаёт `D:/`,
  `path.win32.basename('D:/') === ''` → проект без имени в сайдбаре (кажется, что «не добавился»).
- `apps/desktop/src/renderer/src/App.tsx:563` — `p.root.replace(/^\/Users\/[^/]+/, '~')` на `C:/Users/…` не срабатывает.
- `apps/desktop/src/main/worker.ts:174` — для корня диска worktree уходит в `D:\.orca-worktrees` (работает, но это уже не «рядом с репо»).
- Фикс: `basename(root) || root`; сокращать домашнюю папку через `homedir()` из main (или отдавать готовую строку).
  Тесты — раздел «win32-пути» в `projects.win32.test.ts`.

### 6. Дубли проекта из-за регистра/формы пути — низкая

- `apps/desktop/src/main/projects.ts:117` — сравнение `p.root === root` чувствительно к регистру. Оба значения от git,
  поэтому обычно совпадают; расходятся при открытии через `subst`-диск, mapped-диск vs UNC, junction/симлинк,
  8.3-имя. Результат — второй проект с другим id и пустой доской («мой проект не открылся, доска пустая»).
- Фикс: на win32 сравнивать `realpathSync.native(root).toLowerCase()`; id считать от нормализованного пути
  (с миграцией существующих id).

### 7. Позже, при старте задачи (не открытие проекта, но выглядит похоже)

- `apps/desktop/src/main/worker.ts:174-179` — `git worktree add` в `<repo>\..\.orca-worktrees\<taskId>`: при длинном
  пути репозитория + `node_modules` упирается в MAX_PATH 260 без `core.longpaths=true` («Filename too long»);
  нет прав на запись в родителя репозитория (репо в `C:\` или в чужом каталоге).
- `apps/desktop/src/main/pty.ts:102` — `cwd ?? process.env.HOME`: на Windows `HOME` обычно не задан (только
  для терминала без проекта; с проектом cwd = root).
- `execFileSync` без `windowsHide: true` (`projects.ts:113`, `git.ts:8`, `agents.ts:88-89`) — на каждый вызов git в
  GUI-приложении мелькает консольное окно. Не ломает, но заметно.

## Проверено — не причина

- Имена файлов из пути: `id` — hex sha1, доска `boards/<id>.json` — без `:`/`\` (`projects.ts:123`, `:269`).
- Прямые слэши от git + `path.join` → корректный `C:\…\.orca-worktrees\<id>` (`worker.ts:174`); `cwd` с прямыми
  слэшами Node/CreateProcess принимает.
- Кириллица и пробелы в пути: `execFileSync` с массивом аргументов, git выводит UTF-8, `toString()` — utf8;
  в тесте путь `репо с пробелом` добавляется. `userData` = `%APPDATA%\orca-board` — Unicode-API Node.
- Именованный канал на Windows не требует каталога и `unlink` (`socket.ts:333`) — это учтено в `8abf9dc`.
- node-pty в кросс-сборке: `loadNativeModule` при неудаче `build/Release` падает обратно на `prebuilds/win32-x64`
  (node-pty 1.1.0), а `dist:win` запускается с `npmRebuild=false`.

## Как проверить на живой Windows (порядок)

1. DevTools окна (Ctrl+Shift+I) → Console → нажать «+», выбрать папку: есть ли `Error invoking remote method 'projects:add'` и его текст.
2. В cmd: `where git` и `git -C "<папка>" rev-parse --show-toplevel` — ENOENT/«не является командой» → №3, `dubious ownership` → №2.
3. Диспетчер задач: сколько процессов `orca-board.exe` (группы) — два экземпляра → №4.
