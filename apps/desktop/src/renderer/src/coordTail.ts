// Последний вывод координатора для вкладки «Координатор»: только чтение, без второго xterm. Хвост берём из реестра
// терминалов (`terminals.list()` → `tail`, main уже отдаёт его без ANSI) и дописываем живым `pty.onData`. `resize`
// не зовём: размер PTY принадлежит настоящему терминалу во вкладке «Терминалы».

/** Сколько последних строк показываем. */
export const COORD_TAIL_LINES = 40

/** Сколько символов сырого вывода держим в памяти: с запасом на очистку от служебных кодов и повторы. */
export const COORD_TAIL_CHARS = 24_000

/**
 * Управляющие последовательности: CSI (`ESC [ … final`), OSC (`ESC ] … BEL | ESC \`), одиночные `ESC x` и
 * `ESC ( B`-подобные выбор набора символов. Курсор вправо (`ESC [ n C`) TUI-агенты используют вместо пробелов,
 * поэтому CSI-C превращаем в пробел до общей очистки — иначе слова слипаются.
 */
const CURSOR_RIGHT = /\x1b\[\d*C/g
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g
const ESC_OTHER = /\x1b[()][0-9A-Za-z]|\x1b[@-Z\\^_=>78]/g
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** Убрать ANSI-последовательности и прочие управляющие символы; `\n` и `\r` остаются. */
export function stripAnsi(text: string): string {
  return text.replace(CURSOR_RIGHT, ' ').replace(OSC, '').replace(CSI, '').replace(ESC_OTHER, '').replace(CONTROLS, '')
}

/**
 * Позиционирование курсора в TUI (Claude Code рисует экран именно им, а не пробелами и переводами строк): «в колонку n»
 * (`ESC[nG`) и «вправо» — между словами, «вниз», «в позицию» (`ESC[n;mH`) — на другой строке. Без замены слова слипаются
 * («Привет\x1b[10Gмир» → «Приветмир»). Колонка 1 — возврат каретки. Настоящую раскладку экрана это не восстанавливает
 * (для неё нужен эмулятор терминала, а он был бы вторым xterm), но текст остаётся читаемым.
 */
const CURSOR_COLUMN = /\x1b\[(\d*)G/g
const CURSOR_LINE = /\x1b\[\d*(?:;\d*)?[BEHfF]/g

function layoutToText(text: string): string {
  return text
    .replace(CURSOR_COLUMN, (_m, n: string) => (n === '' || n === '1' ? '\r' : ' '))
    .replace(CURSOR_LINE, '\n')
}

/**
 * Строки для показа. `\r\n` — обычный перевод строки; одиночный `\r` возвращает каретку, и новый текст затирает
 * прежний (прогресс, спиннеры), поэтому берём то, что после последнего `\r` строки. Подряд идущие пустые и
 * одинаковые строки схлопываем: перерисовки TUI иначе забивают весь хвост копиями одного кадра.
 * Пустые строки по краям отбрасываем; в итоге — не больше `limit` последних.
 */
export function tailLines(raw: string, limit = COORD_TAIL_LINES): string[] {
  const lines: string[] = []
  for (const source of stripAnsi(layoutToText(raw)).replace(/\r\n/g, '\n').split('\n')) {
    const line = (source.includes('\r') ? (source.split('\r').filter((p) => p.trim() !== '').pop() ?? '') : source).trimEnd()
    const prev = lines[lines.length - 1]
    if (prev !== undefined && line === prev) continue
    lines.push(line)
  }
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-limit)
}

/** Хвост живого PTY из ответа `terminals.list()`; терминала нет (или список не пришёл) — undefined. */
export function tailFromRegistry(list: readonly { ptyId: string; tail?: string }[] | undefined, ptyId: string): string | undefined {
  return list?.find((t) => t.ptyId === ptyId)?.tail
}

/**
 * Склеить хвост из реестра с кусками `onData`, пришедшими, пока `list()` ещё ехал. Часть этих кусков уже
 * могла попасть в хвост (main дописывает его до отправки в окно), поэтому кусок, которым хвост уже заканчивается,
 * пропускаем. Совпадение сравниваем по очищенному тексту: `ptyTail` в main выкидывает `\r`.
 */
export function mergeTail(base: string, chunks: readonly string[]): string {
  // Хвост из main очищен от CSI целиком (без замены на пробелы) — сравниваем в том же виде.
  const comparable = (s: string): string => s.replace(OSC, '').replace(CSI, '').replace(ESC_OTHER, '').replace(CONTROLS, '').replace(/\r/g, '')
  let out = base
  for (const chunk of chunks) {
    const c = comparable(chunk)
    if (c !== '' && comparable(out).endsWith(c)) continue
    out += chunk
  }
  return out.slice(-COORD_TAIL_CHARS)
}

/** Дописать живой кусок к накопленному сырому выводу, не давая ему расти бесконечно. */
export function appendTail(raw: string, chunk: string): string {
  return (raw + chunk).slice(-COORD_TAIL_CHARS)
}
