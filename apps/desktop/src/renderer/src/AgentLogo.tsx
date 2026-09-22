import type React from 'react'
import { AGENT_TITLES, isAgentKind, type AgentKind } from '@orca-board/core'
import claude from './logos/claude.svg?raw'
import codex from './logos/codex.svg?raw'
import gemini from './logos/gemini.svg?raw'
import copilot from './logos/copilot.svg?raw'
import cursor from './logos/cursor.svg?raw'
import amp from './logos/amp.svg?raw'
import opencode from './logos/opencode.svg?raw'
import goose from './logos/goose.svg?raw'
import shell from './logos/shell.svg?raw'

/** Внутренности svg-файла без обёртки `<svg>` и `<title>`: рисуем их в своём `<svg>` с currentColor. */
function inner(svg: string): string {
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .trim()
}

const LOGOS: Record<AgentKind, string> = {
  claude: inner(claude),
  codex: inner(codex),
  gemini: inner(gemini),
  copilot: inner(copilot),
  cursor: inner(cursor),
  amp: inner(amp),
  opencode: inner(opencode),
  goose: inner(goose),
  shell: inner(shell)
}

/** Брендовые цвета; у монохромных логотипов — белый. */
const COLORS: Record<AgentKind, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  gemini: '#4e8df5',
  cursor: '#fff',
  copilot: '#fff',
  amp: '#ff5543',
  opencode: '#fff',
  goose: '#f6b93b',
  shell: '#9ea1ad'
}

interface Props {
  /** Id агента; неизвестный рисуется как `shell`. */
  agent: AgentKind | string
  size?: number
  className?: string
}

/** Логотип агента: inline SVG 24×24, окрашенный в брендовый цвет. */
export function AgentLogo({ agent, size = 28, className }: Props): React.JSX.Element {
  const kind: AgentKind = isAgentKind(agent) ? agent : 'shell'
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      role="img"
      aria-label={AGENT_TITLES[kind]}
      className={className}
      style={{ color: COLORS[kind], flexShrink: 0, display: 'block' }}
      dangerouslySetInnerHTML={{ __html: LOGOS[kind] }}
    />
  )
}
