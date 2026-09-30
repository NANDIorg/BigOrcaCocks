import { OrcaError } from './i18n'
import type { TaskTypeExportResult } from '../shared/ipc'

/**
 * Зависимости «Экспорта типа». Electron сюда не импортируется: диалог и запись передаёт `index.ts`, поэтому поток
 * (отмена, успех, ошибка записи) проверяется тестом без окна.
 */
export interface TaskTypeExportDeps {
  /** Текст файла и имя по умолчанию (`ProjectManager.exportTaskType`). Бросает до диалога: нет типа, граф будущей версии. */
  export(id: string): { fileName: string; text: string }
  /** Диалог «Сохранить как»; закрыли — null. */
  chooseFile(defaultName: string): Promise<string | null>
  /** Запись текста по выбранному пути (`writeFileAtomic`). */
  write(path: string, text: string): void
}

/**
 * Экспорт типа в файл: текст строится до диалога — ошибка типа не должна показываться после выбора пути. Отмена
 * диалога — null, ничего не пишется. Ошибка записи (нет прав, диск полон) — `type.exportFailed` с путём и причиной:
 * путь выбрал человек, ему и надо его показать.
 */
export async function exportTaskTypeToFile(deps: TaskTypeExportDeps, id: string): Promise<TaskTypeExportResult | null> {
  const { fileName, text } = deps.export(id)
  const path = await deps.chooseFile(fileName)
  if (path === null) return null
  try {
    deps.write(path, text)
  } catch (e) {
    throw new OrcaError('type.exportFailed', { path, reason: e instanceof Error ? e.message : String(e) })
  }
  return { path }
}
