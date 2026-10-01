import { canChangeRunType, type ColumnKind, type GlobalTask, type RunImage } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { t } from './i18n'

/**
 * Вложения глобальной задачи — картинки и любые файлы (docs/nested-kanban.md → «Картинки задачи»; имена `images`
 * исторические): правила и обёртки IPC.
 * renderer обновляется по HMR раньше preload и main, поэтому методов может не быть.
 */

/** Ошибка «старый main/preload не умеет вложения задач» на текущем языке интерфейса. */
export function staleImagesMessage(): string {
  return t('global.stale.images')
}

/** Можно ли добавлять и удалять вложения: то же правило, что у смены типа (`canChangeRunType` — до начала работы). */
export function imagesEditable(
  global: Pick<GlobalTask, 'inbox' | 'startedAt' | 'coordinatorPtyId' | 'progress'>,
  statusKind: ColumnKind | undefined
): boolean {
  return canChangeRunType({
    inbox: global.inbox,
    startedAt: global.startedAt,
    coordinatorPtyId: global.coordinatorPtyId,
    subtasks: global.progress.total,
    statusKind
  })
}

type GlobalTasksApi = OrcaApi['globalTasks']
type ImagesApi = Pick<GlobalTasksApi, 'addImages' | 'removeImage' | 'image' | 'revealAttachment'>

const NO_HANDLER = (name: string): RegExp => new RegExp(`No handler registered for 'globalTasks:${name}'`)

/**
 * `globalTasks.addImages/removeImage/image/revealAttachment` или ошибка «перезапустите приложение». Новый preload
 * со старым main падает на invoke «No handler registered for 'globalTasks:…'» — её тоже переводим в понятное
 * сообщение. `revealAttachment` появился позже остальных: его отсутствие не мешает работать с картинками,
 * ошибка — только при вызове.
 */
export function runImagesApi(api: { globalTasks?: Partial<GlobalTasksApi> } | undefined): ImagesApi {
  const gt = api?.globalTasks
  if (!gt || typeof gt.addImages !== 'function' || typeof gt.removeImage !== 'function' || typeof gt.image !== 'function') {
    throw new Error(staleImagesMessage())
  }
  const wrap = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await fn.apply(gt, a)
      } catch (e) {
        if (NO_HANDLER(name).test(e instanceof Error ? e.message : String(e))) throw new Error(staleImagesMessage())
        throw e
      }
    }
  const reveal = gt.revealAttachment
  return {
    addImages: wrap('addImages', gt.addImages),
    removeImage: wrap('removeImage', gt.removeImage),
    image: wrap('image', gt.image),
    revealAttachment:
      typeof reveal === 'function'
        ? wrap('revealAttachment', reveal)
        : async () => {
          throw new Error(staleImagesMessage())
        }
  }
}

/**
 * Main без вложений молча игнорирует второй аргумент `create`: задача создаётся, вложений в ней нет. Отличить
 * его можно только по ответу — отправляли файлы (картинки или любые), а в карточке их не стало столько же.
 */
export function imagesLost(created: Pick<GlobalTask, 'images'>, sent: number): boolean {
  return sent > 0 && (created.images?.length ?? 0) < sent
}

/** Вложения, которые ещё есть у задачи: id из списка `ids` уже удалены другой попыткой — второй раз main вернёт ошибку. */
export function idsToRemove(ids: Iterable<string>, saved: readonly RunImage[] | undefined): string[] {
  const have = new Set((saved ?? []).map((i) => i.id))
  return [...ids].filter((id) => have.has(id))
}

/**
 * Можно ли нажать «Создать»/«Сохранить». У «Входящих» название фиксированное и описания нет — при правке нужно
 * только название. Создание — название или описание; картинки без текста задачу не создают (main: «нет ни названия,
 * ни описания»), зато при названии описание может быть пустым. Пока файлы читаются, сохранять нельзя — часть
 * вложений не попала бы в отправку.
 */
export function canSaveGlobal(x: { busy: boolean; reading: boolean; editing: boolean; title: string; description: string }): boolean {
  if (x.busy || x.reading) return false
  return x.title.trim() !== '' || (!x.editing && x.description.trim() !== '')
}
