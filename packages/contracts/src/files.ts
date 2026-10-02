export type DocViewKind = 'markdown' | 'text' | 'image' | 'html' | 'pdf' | 'binary'

/** Вид записи папки проекта (`files:list`): симлинк отдаётся как есть, без перехода по нему. */
export type ProjectFileKind = 'dir' | 'file' | 'symlink'

/** Запись папки проекта (`files:list`). Пути renderer собирает сам: `dir + '/' + name`. */
export interface ProjectFileEntry {
  name: string
  kind: ProjectFileKind
}

export interface ProjectFilesListing {
  /** Папка от корня проекта через `/`; '' — корень (эхо запроса: renderer отбрасывает устаревшие ответы). */
  dir: string
  /** Отсортировано main: папки, затем файлы и симлинки, по имени. */
  entries: ProjectFileEntry[]
  /** Записей в папке больше `PROJECT_FILES_DIR_LIMIT` — показаны первые. */
  truncated: boolean
}

/** Сколько записей одной папки отдаёт `files:list`: огромная папка не должна подвешивать IPC и дерево. */
export const PROJECT_FILES_DIR_LIMIT = 5000

/** Ожидаемые отказы `files:*` — у каждого свой текст в renderer (образец — `PROJECT_GIT_ERROR_CODES`). */
export const PROJECT_FILES_ERROR_CODES = [
  'files.badPath', // не строка, NUL, абсолютный, `..`/`.`/пустой сегмент, `\`, `:` на win32
  'files.outside', // путь (по realpath) вне корня проекта
  'files.hidden', // `.git`
  'files.notFound', // папки/файла уже нет (удалили после последнего чтения)
  'files.notDir', // list на файле
  'files.notFile', // ожидался файл, а это папка, FIFO, сокет, устройство (`docs:view/bytes/previewUrl/open`)
  'files.rootMissing', // корня проекта нет на диске
  'files.readFailed' // прочее: доступ, ввод-вывод, слишком длинный путь; параметры path, error
] as const

export type ProjectFilesErrorCode = (typeof PROJECT_FILES_ERROR_CODES)[number]

/**
 * Файл в просмотрщике «Документы»: в группе `project` — любой файл проекта, в группах задач — `.md`. Старый main
 * отдаёт и в `project` только `.md`: renderer не должен на это полагаться ни в ту, ни в другую сторону.
 */
export interface DocFile {
  /** Относительно корня источника (проекта или worktree задачи), через `/`. */
  path: string
  size: number
  mtime: number
  /** Не отслеживается git'ом — новый файл. */
  untracked: boolean
  /** Симлинк на файл (цель может быть вне корня или битой — это выяснится при `docs:view`). Нет поля — не симлинк. */
  link?: boolean
}

/** Файл показа для превью (`showcase:read`): mime по расширению и содержимое. */
export interface ShowcaseFileData {
  mime: string
  bytes: Uint8Array
}

/** Адрес страницы показа для изолированного фрейма (`showcase:previewUrl`). */
export interface ShowcasePreviewUrl {
  /** `orca-preview://<токен>/<путь>` — renderer ставит его в `src`, только проверив схему. */
  url: string
  mime: string
  /** `orca-preview://<токен>/` — корень снимка: к нему разрешаются относительные картинки markdown. */
  base: string
}

/** Параметры `showcase:previewUrl`. */
export interface ShowcasePreviewOptions {
  /** Разрешить странице интернет-ресурсы (CDN, шрифты). По умолчанию сеть закрыта; выбор не запоминается. */
  network?: boolean
}

/** Группа документов: проект (`source: 'project'`) или worktree задачи в работе (`source` — id задачи). */
export interface DocGroup {
  source: string
  title: string
  branch?: string
  files: DocFile[]
  /** Только `project`: файлов больше `DOCS_LIST_LIMIT` (`shared/docs-view.ts`) — отданы первые. */
  truncated?: boolean
}

/**
 * Почему содержимое файла не показывается (`DocView.stub`) — это обычный ответ `docs:view`, не ошибка: `binary` —
 * NUL в первых `DOC_SNIFF_BYTES` или бинарное расширение; `notUtf8` — невалидный UTF-8 (других кодировок не угадываем);
 * `tooBig` — больше `DOC_TEXT_MAX_BYTES` (текст) или `DOC_IMAGE_MAX_BYTES` (картинка); `pdf` — PDF только «Открыть».
 */
export type DocStub = 'binary' | 'notUtf8' | 'tooBig' | 'pdf'

/**
 * Ответ `docs:view`: как показать файл и, для текстовых видов, его содержимое. Инварианты:
 * - `kind` — вид по `docKindOf(path)`; `unknown` main уточняет по содержимому до `text` или `binary`. У заглушки это
 *   предполагаемый вид (`.ts` с NUL — `kind: 'text'`, `stub: 'binary'`), по нему renderer выбирает иконку и текст;
 * - `stub` задан ⇒ `text` нет. `stub: 'pdf'` ⇔ `kind: 'pdf'`;
 * - `text` без `stub` есть всегда у `markdown` и `text`; у `html` и SVG (`kind: 'image'`) — только при `opts.source`;
 *   у прочих картинок не бывает (байты — `docs:bytes`). Это UTF-8 без BOM, не больше `DOC_TEXT_MAX_BYTES`, переводы
 *   строк как в файле;
 * - `mime` есть у `image` и `html`;
 * - `size` и `mtime` — цели симлинка; `mtime` — мс эпохи.
 */
export interface DocView {
  kind: DocViewKind
  size: number
  mtime: number
  mime?: string
  text?: string
  stub?: DocStub
  /**
   * Кнопка «Открыть» приложением системы разрешена: расширение из `SHOWCASE_FILE_TYPES` и у пути, и у цели симлинка
   * (`a.png` → `run.sh` не откроется). Иначе `docs:open` отказывает `docs.notOpenable`.
   */
  openable: boolean
}

/** Параметры `docs:view`. */
export interface DocViewOptions {
  /** Вернуть исходный текст `html` и SVG для вкладки «Код» (у `markdown` и `text` текст есть и так). */
  source?: boolean
}

/** Байты картинки (`docs:bytes`): тот же вид, что у показа, — подходит для `useBlobUrl`. */
export type DocBytes = ShowcaseFileData

/** Адрес для изолированного фрейма (`docs:previewUrl`): `url` — HTML-страница, `base` — корень для картинок markdown. */
export type DocPreviewUrl = ShowcasePreviewUrl

/**
 * Отказы новых каналов `docs:*`, которых нет у `files:*`. Ошибки пути (`files.badPath`, `files.outside`, `files.hidden`,
 * `files.notFound`, `files.notFile`, `files.rootMissing`, `files.readFailed`) — из `PROJECT_FILES_ERROR_CODES`: резолвер
 * общий. Коды `docs.notMarkdown`, `docs.tooBig` и прежние остаются только за `docs:read`.
 */
export const DOC_VIEW_ERROR_CODES = [
  'docs.notOpenable', // `docs:open`: расширение (пути или цели симлинка) не из `SHOWCASE_FILE_TYPES`
  'docs.noPreview' // `docs:previewUrl` не для html/markdown или путь со скрытым сегментом (`.env`, `.github/…`); `docs:bytes` не для картинки
] as const

export type DocViewErrorCode = (typeof DOC_VIEW_ERROR_CODES)[number]

/** Итог `attachments.capabilities()`: что main примет в аргументе вложений IPC-каналов. */
export interface AttachmentCapabilities {
  /** `true` — любые файлы; `false` — только картинки PNG/JPEG/GIF/WebP. */
  files: boolean
  /** Лимиты, которые проверяет main (`ATTACHMENT_LIMITS` или прежние `IMAGE_ATTACHMENT_LIMITS` из core), байт. */
  limits: { maxCount: number; maxBytes: number; maxTotalBytes: number }
}
