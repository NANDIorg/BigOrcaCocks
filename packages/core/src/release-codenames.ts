import registry from './release-codenames.json' with { type: 'json' }

export interface ReleaseCodename { series: string; name: string }
const number = '(0|[1-9]\\d*)'
const versionPattern = new RegExp(`^v?${number}\\.${number}\\.${number}$`)
const seriesPattern = new RegExp(`^${number}\\.${number}$`)

/** Patch наследует животное major/minor; неизвестную серию интерфейс не называет наугад. */
export function releaseCodename(version: string, entries: readonly ReleaseCodename[] = registry): string | undefined {
  const match = versionPattern.exec(version)
  return match ? entries.find((entry) => entry.series === `${match[1]}.${match[2]}`)?.name : undefined
}

export function releaseVersionLabel(version: string): string {
  const name = releaseCodename(version)
  return name ? `${version} · ${name}` : version
}

export function releaseTitle(version: string, entries: readonly ReleaseCodename[] = registry): string {
  const name = releaseCodename(version, entries)
  if (!name) throw new Error(`для версии ${version} не закреплено морское кодовое имя`)
  return `Orca ${version.replace(/^v/u, '')} · ${name}`
}

function parseRegistry(value: unknown): ReleaseCodename[] {
  if (!Array.isArray(value)) throw new Error('реестр кодовых имён должен быть массивом')
  const series = new Set<string>()
  const names = new Set<string>()
  return value.map((raw: unknown): ReleaseCodename => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('некорректная запись кодового имени')
    const entry = raw as Record<string, unknown>
    if (typeof entry.series !== 'string' || !seriesPattern.test(entry.series)) throw new Error('серия кодового имени должна иметь формат X.Y')
    if (typeof entry.name !== 'string' || entry.name.length > 64 || !/^[A-Za-z]+(?:[ -][A-Za-z]+)*$/u.test(entry.name)) throw new Error('кодовое имя должно быть коротким английским названием морского животного')
    if (series.has(entry.series)) throw new Error(`повторяется серия ${entry.series}`)
    const normalized = entry.name.toLowerCase().replace(/[ -]/gu, ' ')
    if (names.has(normalized)) throw new Error(`повторяется кодовое имя ${entry.name}`)
    series.add(entry.series)
    names.add(normalized)
    return { series: entry.series, name: entry.name }
  })
}

/** Реестр дополняется: прежние назначения и зарезервированные имена остаются неизменными. */
export function validateReleaseCodenames(value: unknown, previous: unknown = []): ReleaseCodename[] {
  const entries = parseRegistry(value)
  for (const old of parseRegistry(previous)) {
    const current = entries.find((entry) => entry.series === old.series)
    if (!current) throw new Error(`нельзя удалять кодовое имя серии ${old.series}`)
    if (current.name !== old.name) throw new Error(`нельзя менять кодовое имя серии ${old.series}: ${old.name}`)
  }
  return entries
}
