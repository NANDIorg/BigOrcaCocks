// Какой PTY показывать в панели ассистента. Логика вынесена из App.tsx, чтобы её проверял node:test.

/** Терминал из реестра (terminals:list / terminals:changed) — только поля, нужные для выбора. */
export interface AssistantCandidate {
  ptyId: string
  role?: string
  projectId?: string
  tail?: string
}

/** Терминал ассистента в панели. projectId есть только у ассистентов старого main (по одному на проект). */
export interface AssistantTerminal {
  ptyId: string
  projectId?: string
  /** Хвост вывода из terminals:list — после перезагрузки окна терминал не пустой. */
  tail?: string
}

export interface AssistantPick {
  /** Все терминалы ассистента: панель держит их смонтированными, чтобы не терять вывод. */
  terminals: AssistantTerminal[]
  /** Видимый в панели; null — ассистента нет, его надо запустить. */
  ptyId: string | null
}

/**
 * Ассистент один на приложение: PTY с ролью `assistant` без projectId, при смене проекта — тот же.
 * `launched` — ответ последнего assistant.open/reset: terminals:changed может прийти позже, а после
 * «Новый диалог» старый PTY ещё может быть в реестре, поэтому свежий из ответа важнее найденного по роли.
 *
 * Совместимость со старым main (renderer обновляется по HMR раньше, чем main): там ассистент по одному на
 * проект, PTY с projectId. Такой подходит только своему проекту — на другом ищем его ассистента по projectId,
 * не нашли — null, и App запустит ассистента активного проекта.
 */
export function pickAssistant(
  registry: AssistantCandidate[],
  launched: string | null,
  killed: ReadonlySet<string>,
  activeProjectId: string | undefined
): AssistantPick {
  const terminals: AssistantTerminal[] = registry
    .filter((t) => t.role === 'assistant' && !killed.has(t.ptyId))
    .map((t) => ({ ptyId: t.ptyId, ...(t.projectId ? { projectId: t.projectId } : {}), ...(t.tail !== undefined ? { tail: t.tail } : {}) }))
  if (launched && !killed.has(launched) && !terminals.some((t) => t.ptyId === launched)) terminals.push({ ptyId: launched })
  const fits = (t: AssistantTerminal): boolean => !t.projectId || t.projectId === activeProjectId
  const pick =
    terminals.find((t) => t.ptyId === launched && fits(t)) ??
    terminals.find((t) => !t.projectId) ??
    (activeProjectId ? terminals.find((t) => t.projectId === activeProjectId) : undefined)
  return { terminals, ptyId: pick?.ptyId ?? null }
}
