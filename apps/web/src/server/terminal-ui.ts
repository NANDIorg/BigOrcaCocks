import input from '@inquirer/input'
import select from '@inquirer/select'
import wrapAnsi from 'wrap-ansi'
import stringWidth from 'string-width'
import { stdout } from 'node:process'
import { styleText } from 'node:util'
import { readPassword } from './password.ts'
import type { WizardChoice, WizardIO } from './wizard.ts'

/** Только оформление и ввод: запись настроек и системные действия остаются в host. */
export function createTerminalUi(output: NodeJS.WriteStream = stdout) {
  const styled = (format: 'bold' | 'dim' | 'inverse', text: string) =>
    output.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
      ? styleText(format, text, { validateStream: false }) : text
  const bold = (text: string) => styled('bold', text)
  const dim = (text: string) => styled('dim', text)
  const width = () => Math.max(12, Math.min(74, (output.columns || 80) - 4))
  const write = (value: string) => {
    const lines = wrapAnsi(value.trimEnd(), width() - 2, { hard: true, trim: false }).split('\n')
    output.write(lines.map(line => line ? `  ${line}` : '').join('\n') + '\n')
  }
  const panel = (title: string, body: string[], footnote?: string) => {
    const size = width()
    output.write(`\n  ${dim(`╭${'─'.repeat(size)}╮`)}\n`)
    for (const [index, text] of [title, '', ...body].entries()) {
      for (const line of wrapAnsi(text, size - 4, { hard: true }).split('\n')) {
        const padding = ' '.repeat(Math.max(0, size - 4 - stringWidth(line)))
        output.write(`  ${dim('│')}  ${index === 0 ? bold(line) : line}${padding}  ${dim('│')}\n`)
      }
    }
    output.write(`  ${dim(`╰${'─'.repeat(size)}╯`)}\n`)
    if (footnote) write(dim(footnote))
    output.write('\n')
  }
  const theme = {
    prefix: { idle: '  ○', done: '  ✓' },
    style: { message: bold, answer: (text: string) => text, error: bold, help: dim,
      defaultAnswer: dim, highlight: (text: string) => styled('inverse', text), key: bold,
      description: dim, disabled: dim,
      keysHelpTip: () => dim('↑ ↓ выбор   Enter продолжить   Ctrl+C отмена') },
    icon: { cursor: '›' }, indexMode: 'number' as const,
  }
  const promptTitle = (prompt: string, fallback?: string) => {
    const withoutDefault = fallback ? prompt.replace(/\s*\[[^\]]*\](?=:?\s*$)/, '') : prompt
    return withoutDefault.replace(/:\s*$/, '').trim()
  }
  const prompt = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation() }
    catch (error) {
      if (error instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(error.name)) throw new Error('Настройка отменена. Существующие аккаунты и конфигурация сохранены.')
      throw error
    }
  }
  const choose = (message: string, choices: WizardChoice[], fallback: string) => prompt(() => select({ message: promptTitle(message, fallback),
    choices: choices.map(choice => ({ value: choice.value, name: choice.label, description: choice.hint })),
    default: fallback, loop: false, theme }, { output }))
  const io: WizardIO = {
    write,
    ask: (message, fallback) => prompt(() => input({ message: promptTitle(message, fallback), default: fallback || undefined, theme }, { output })),
    select: choose,
    intro: () => panel('O R C A   /   W E B', ['Установка на ваш сервер', 'Доступ → Проекты → Защита → Настройка → Проверка'], 'Enter принимает предложенное значение. Ctrl+C отменяет ввод.'),
    step: (current, total, title) => panel(`${String(current).padStart(2, '0')} / ${String(total).padStart(2, '0')}    ${title}`,
      [`${'■ '.repeat(current)}${'□ '.repeat(total - current)}`.trim()]),
    summary: rows => panel('План установки', rows.flatMap(([label, value]) => [dim(label), bold(value), ''])),
  }
  return { ...io, panel, select: choose,
    heading: (title: string) => write(`\n${bold(title)}\n`),
    entry: (title: string, description: string) => write(`  ${bold(title)}\n    ${dim(description)}\n`),
    password: (message: string) => readPassword(`  ○ ${bold(message)}`),
    success: (title: string, rows: string[]) => panel(`✓  ${title}`, rows),
    failure: (message: string) => panel(/отмен/i.test(message) ? 'Настройка отменена' : '×  Не удалось завершить', [message]),
  }
}
