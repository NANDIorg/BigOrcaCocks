import type React from 'react'
import { Markdown } from './Markdown'

interface Props {
  answer: string
  /** Суть ответа одной строкой (`done --summary`). */
  summary?: string
  /** Подпись под ответом: что с ним дальше (принять в «Нужен ваш ответ», примет координатор). */
  note?: string
}

/**
 * Ответ задачи-ответа: суть и markdown. Принять / уточнить — запрос к человеку (HumanRequest kind=answer)
 * в блоке «Нужен ваш ответ» модалки или во Входящих, здесь только чтение.
 */
export function AnswerBlock({ answer, summary, note }: Props): React.JSX.Element {
  return (
    <div className="answer">
      {summary && <div className="answer-summary">{summary}</div>}
      <Markdown text={answer} className="answer-body" />
      {note && <div className="muted">{note}</div>}
    </div>
  )
}
