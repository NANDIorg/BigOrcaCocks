/**
 * Склонение по-русски: plural(3, 'агент', 'агента', 'агентов'). Только для строк, ещё не переведённых в i18n;
 * в новом коде — plural-сообщение словаря (`{ one, few, many }` в ru, `{ one, other }` в en) и `t(key, { count })`,
 * формы выбирает `Intl.PluralRules` текущего языка (`pluralCategory` в i18n/index.ts).
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
