import { createEffectJournal, type EffectJournal } from '@orca-board/runtime'

let journal: EffectJournal | undefined
/** Вызывается только под profile lease, до backup/ProjectManager. Import не читает профиль. */
export function initializeEffectJournal(dataDir: string, ownerId: string): void {
  if (journal) throw new Error('Журнал effects Desktop уже создан')
  journal = createEffectJournal({ dataDir, ownerId })
}
export const getEffectJournal = () => journal
export function requiredEffectJournal(): EffectJournal {
  if (!journal) throw new Error('Profile owner ещё не готов')
  return journal
}
