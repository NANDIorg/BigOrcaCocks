# Архитектура orca-board

## Процессы

```
Electron main ───── node-pty ───── PTY: claude (координатор)
   │                                   └─ bash: orca-board task-create ...
   │                                          │ unix socket / JSON-RPC
   ├── SQLite (tasks, events, dispatches) ◄───┘
   ├── node-pty ───── PTY: claude (воркер задачи #12, worktree ../wt/task-12)
   ├── node-pty ───── PTY: codex  (воркер задачи #13, worktree ../wt/task-13)
   └── renderer (React): доска + xterm.js на каждый PTY
```

- Все агенты — дочерние процессы приложения. Никакого API: агент логинится сам.
- CLI `orca-board` — тонкий клиент к сокету приложения. Его вызывают агенты
  через свой Bash. Приложение — единственный владелец состояния.

## Модель

- `Task { id, title, spec, status, deps[], worktree?, branch?, agent, dispatchId? }`;
  `agent` — `AgentKind`, id из реестра `packages/core/src/agents.ts` (см. «Агенты»).
- `Dispatch { id, taskId, pty, startedAt, endedAt?, outcome? }`
- `Event { id, type, taskId?, dispatchId?, payload, createdAt, consumedBy? }`
  типы: `task_ready`, `worker_done`, `question`, `escalation`, `gate_answered`.
- Статусы задачи: `backlog → ready → in_progress → (needs_input) → review → done`.
  `ready` ставится автоматически, когда все `deps` в `done`.

## CLI (минимум для координатора)

```
orca-board run create --objective "..."
orca-board agents list                      # [{id,title,installed,enabled,version?}]
orca-board task create --title ... --spec ... [--agent <id>] [--dep <id>]
orca-board worker start --task <id>
orca-board check --wait --types worker_done,question --timeout-ms 900000
orca-board worker read --dispatch <id>
orca-board gate create --task <id> --question "..." --options a,b
```

## CLI (для воркера, внутри его PTY)

```
orca-board done --summary "..." --files a.ts,b.ts
orca-board ask --question "..." --options a,b      # блокирует до ответа
```

## Как воркер получает контекст

При старте PTY в env кладутся `ORCA_TASK_ID`, `ORCA_DISPATCH_ID`, `ORCA_SOCKET`, `ORCA_PROJECT`,
а в `PATH` — папка с `orca-board`. Команда запуска берётся из реестра:
`AGENTS[task.agent].invoke(инструкция, задание, {permissionMode, shell})` → `{command, args}`
(`worker.ts`). Инструкция — `skills/worker.md`, задание — `# Задача: <title>` + spec + замечания ревью.

| Агент | Бинарник | Как передаются инструкция и задание |
|---|---|---|
| `claude` | `claude` | инструкция через `--append-system-prompt`, задание — позиционный аргумент; плюс `--permission-mode`, `--allowedTools "Bash(orca-board:*)"` |
| `codex`, `cursor` (`cursor-agent`), `amp` | по id | склейка `инструкция\n\n---\n\nзадание` одним позиционным аргументом |
| `opencode` | `opencode` | склейка в `--prompt` |
| `gemini`, `copilot` | по id | склейка в `-i` (интерактив с начальным промптом) |
| `goose` | `goose` | `run --interactive --text <склейка>` |
| `shell` | `$SHELL` (для детекта — `sh`) | ничего: пустой терминал в worktree |

Координатор всегда запускается через `claude` с `skills/coordinator.md` и целью.

## Агенты (`packages/core/src/agents.ts`, `src/main/agents.ts`)

- **Реестр** `AGENTS` в core: `{id, title, bin, versionArgs?, invoke}`. Из него выводятся
  `AgentKind`, `AGENT_IDS`, `AGENT_TITLES` (для UI), `DEFAULT_AGENT = 'claude'`.
  Новый агент — одна запись в массиве, остальное (типы, детект, UI, проверки) подхватывается само.
- **Детект** (`detectAgents`): ищем `bin` как исполняемый файл в `PATH` процесса плюс стандартных папках
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `~/.bun/bin`) —
  Electron из Finder получает урезанный PATH. Сам агент не запускается; только для найденного бинарника
  читается версия `<bin> <versionArgs>` с таймаутом 3 с (первая строка, до 60 символов; ошибка → без версии).
  Результат кэшируется на процесс, `detectAgents(true)` пересканирует (кнопка «Обновить» в «О проекте»).
- **`Project.enabledAgents?: AgentKind[]`** (`projects.ts`): какие агенты включены в проекте; `undefined` —
  все установленные. `agentInfos(enabledAgents)` собирает `AgentInfo[]`:
  `enabled = installed && (enabledAgents === undefined || включён)`. Меняется через IPC `projects:setEnabledAgents`.
- **Где проверяется** (`assertAgentUsable`: неизвестный / не установлен / выключен → ошибка с текстом для CLI и UI):
  `task.create` по сокету и `tasks:create` из UI — через `pickAgent`: указанный агент проверяется,
  без `--agent` берётся `claude`, если включён, иначе первый включённый;
  `worker.start` (сокет и UI) — агент задачи проверяется заново, его могли выключить после создания.
- **Сокет `agents.list`** → `[{id, title, installed, enabled, version?}]` в порядке реестра;
  IPC `agents:list(refresh?)` — то же для активного проекта.

## Протокол сокета

Одна строка JSON-запроса `{id, method, params, dispatchId?, taskId?}`, одна строка ответа
`{id, ok, result | error}`. `check --wait` и `ask` держат соединение открытым до события.
События помечаются `consumedBy`, повторно `check` их не отдаёт.

## Разрешения Claude Code

Координатор и воркеры запускаются с `--permission-mode <режим проекта>` и
`--allowedTools "Bash(orca-board:*)"`. Режим хранится в `Project.permissionMode`
(вкладка «О проекте»), по умолчанию `auto`: Claude Code сам одобряет обычные действия и
спрашивает только про опасные. `bypassPermissions` — вообще без вопросов, `acceptEdits` —
только правки файлов без вопросов, остальной Bash спросит в терминале приложения.

## Ревью и мерж (`src/main/review.ts`, `src/main/git.ts`)

- `review info`: `git diff --stat base...branch`, `git log base..branch`, плюс незакоммиченное в worktree.
- `review accept`: незакоммиченное коммитится от `orca-board`, затем `git merge --no-ff` в текущую
  ветку репозитория, `git worktree remove --force`, `git branch -D`. Конфликт → `merge --abort` и ошибка в UI.
- `review reject --feedback`: задача → `ready`, `task.feedback` добавляется в промпт при следующем старте.

## Детектор тишины

`pty.ts` хранит `lastOutputAt` на сессию. Раз в минуту main проверяет живые dispatch'и:
нет вывода дольше `ORCA_STUCK_MINUTES` (по умолчанию 10) → одно событие `escalation` на dispatch
(`Dispatch.stuckNotified`), на карточке чип «молчит».

## Подготовка worktree

Если worktree только что создан и есть lock-файл, агент запускается через
`$SHELL -c "<setup>; exec <agent> ..."` — установка идёт в том же терминале, что видит пользователь.

## Проекты (`src/main/projects.ts`)

`ProjectManager` хранит список репозиториев в `userData/projects.json`, доску каждого —
в `userData/boards/<id>.json` (`id` = sha1 от корня репозитория). `userData` фиксирован:
`~/Library/Application Support/orca-board`. UI работает с активным проектом; агенты получают
`ORCA_PROJECT` в env, и CLI кладёт его в запрос, поэтому воркер продолжает писать в свою доску,
даже если пользователь переключился на другой проект.

## Уведомления

`ProjectManager.onEvents` отдаёт новые события store; main показывает `Notification`
для `question`, `escalation`, `worker_done`. Клик по уведомлению фокусирует окно и переключает проект.

## Сборка

`electron-builder.yml`: `extraResources` копирует `packages/cli/bin` в `Resources/cli`,
`cliBinDir()` в проде берёт его оттуда. `npmRebuild: true` пересобирает node-pty под Electron.
`pnpm run pack` (не `pnpm pack` — это встроенная команда pnpm).

## Грабли разработки

- `git reset --hard` в скриптах тестирования дважды стёр незакоммиченные правки. Правило:
  коммит сразу после зелёного typecheck, тесты — только read-only git-командами.

## Открытые вопросы

- Удалённый запуск по SSH, мобильный просмотр.
- SQLite вместо JSON, если событий станет много.
- Подпись и нотаризация .app.
