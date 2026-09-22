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

- `Task { id, title, spec, status, deps[], worktree?, branch?, agent?, dispatchId? }`
- `Dispatch { id, taskId, pty, startedAt, endedAt?, outcome? }`
- `Event { id, type, taskId?, dispatchId?, payload, createdAt, consumedBy? }`
  типы: `task_ready`, `worker_done`, `question`, `escalation`, `gate_answered`.
- Статусы задачи: `backlog → ready → in_progress → (needs_input) → review → done`.
  `ready` ставится автоматически, когда все `deps` в `done`.

## CLI (минимум для координатора)

```
orca-board run create --objective "..."
orca-board task create --title ... --spec ... [--dep <id>]
orca-board worker start --task <id> --agent claude
orca-board check --wait --types worker_done,question --timeout-ms 900000
orca-board worker read --dispatch <id>
orca-board gate create --task <id> --question "..." --options a,b
```

## CLI (для воркера, внутри его PTY)

```
orca-board done --summary "..." --files a.ts,b.ts
orca-board ask --question "..." --options a,b      # блокирует до ответа
```

## Открытые вопросы

- Как воркер узнаёт свой `dispatchId` — через env `ORCA_DISPATCH_ID` при старте PTY.
- Определение «агент завис»: таймаут без вывода в PTY N минут → событие `escalation`.
- Мерж: кнопка на карточке в `review`, `git merge --no-ff` в основной ветке.
