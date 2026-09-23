import type { HumanRequest, RequestOption, RequestResolution } from '@orca-board/core'

// Разбор флагов CLI для запросов к человеку (`ask`, `request resolve`). Чистый модуль — без pty/electron.

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Старое `--options a,b`: split по запятой. */
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

/** Повторяемый флаг (`--option a --option b`): CLI присылает массив, одиночный — строку. Без split по запятой. */
function many(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return [v]
  return []
}

/**
 * Варианты ответа `ask`: `--option "метка|пояснение"` (повторяемый, запятые в метке допустимы) или
 * старое `--options a,b`. `--recommend` — id (номер) или метка рекомендуемого варианта.
 */
export function askOptions(params: Record<string, unknown>): RequestOption[] {
  const raw = many(params.option)
  const options: RequestOption[] = raw.length
    ? raw.map((o, i) => {
        const bar = o.indexOf('|')
        const label = (bar < 0 ? o : o.slice(0, bar)).trim()
        const hint = bar < 0 ? '' : o.slice(bar + 1).trim()
        return { id: String(i + 1), label, ...(hint ? { hint } : {}) }
      })
    : list(params.options).map((label, i) => ({ id: String(i + 1), label }))
  const rec = params.recommend
  if (rec !== undefined) {
    if (typeof rec !== 'string' || !rec.trim()) throw new Error('--recommend требует id или метку варианта')
    const hit = findOption(options, rec)
    if (!hit) throw new Error(`--recommend ${rec}: такого варианта нет`)
    hit.recommended = true
  }
  return options
}

/** Вариант по id или метке (без учёта регистра). */
function findOption<T extends RequestOption>(options: T[], key: string): T | undefined {
  const k = key.trim()
  return options.find((o) => o.id === k) ?? options.find((o) => o.label.toLowerCase() === k.toLowerCase())
}

/**
 * `--option` в `request resolve`: CLI считает флаг повторяемым (он нужен `ask`) и присылает массив даже
 * для одного вхождения — принимаем и строку, и массив из одного элемента.
 */
function singleOption(v: unknown): string | undefined {
  if (v === undefined) return undefined
  const values = Array.isArray(v) ? v : [v]
  if (values.length > 1) throw new Error('--option — только один вариант (id или метка)')
  if (typeof values[0] !== 'string') throw new Error('--option требует значения')
  return values[0]
}

/**
 * Решение запроса из флагов `request resolve`: ровно одно из --option/--text (можно вместе: вариант +
 * комментарий), --accept [--decision], --clarify, --reject (approval: вернуть с замечаниями), --restart, --dismiss.
 */
export function resolutionFromParams(request: Pick<HumanRequest, 'id' | 'options'>, params: Record<string, unknown>): RequestResolution {
  const text = (key: string): string | undefined => {
    const v = params[key]
    if (v === true) throw new Error(`--${key} требует значения`)
    return str(v)
  }
  const option = singleOption(params.option)
  const answer = text('text')
  const decision = text('decision')
  const clarify = text('clarify')
  const reject = text('reject')
  const actions = [
    option !== undefined || answer !== undefined ? 'answer' : undefined,
    params.accept === true ? 'accept' : undefined,
    clarify !== undefined ? 'clarify' : undefined,
    reject !== undefined ? 'reject' : undefined,
    params.restart === true ? 'restart' : undefined,
    params.dismiss === true ? 'dismiss' : undefined
  ].filter(Boolean)
  if (actions.length !== 1) {
    throw new Error('укажи одно: --option <id|метка> и/или --text "...", --accept [--decision "..."], --clarify "...", --reject "...", --restart, --dismiss')
  }
  if (decision !== undefined && params.accept !== true) throw new Error('--decision — только вместе с --accept')
  switch (actions[0]) {
    case 'answer': {
      let optionId: string | undefined
      if (option !== undefined) {
        const hit = findOption(request.options, option)
        if (!hit) throw new Error(`варианта «${option}» у запроса ${request.id} нет`)
        optionId = hit.id
      }
      return { action: 'answer', ...(optionId ? { optionId } : {}), ...(answer !== undefined ? { text: answer } : {}) }
    }
    case 'accept': return { action: 'accept', ...(decision !== undefined ? { text: decision } : {}) }
    case 'clarify': return { action: 'clarify', text: clarify ?? '' }
    case 'reject': return { action: 'reject', ...(reject?.trim() ? { text: reject } : {}) }
    default: return { action: actions[0] as 'restart' | 'dismiss' }
  }
}
