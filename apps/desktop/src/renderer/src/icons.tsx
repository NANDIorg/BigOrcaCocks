import type React from 'react'
import type { WfNodeType } from '@orca-board/core'

const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const Icon = {
  menu: (): React.JSX.Element => <svg {...base}><path d="M4 7h16M4 12h16M4 17h16" /></svg>,
  board: (): React.JSX.Element => <svg {...base}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M15 4v16" /></svg>,
  layers: (): React.JSX.Element => <svg {...base}><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></svg>,
  users: (): React.JSX.Element => <svg {...base}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-5-6.3" /></svg>,
  bell: (): React.JSX.Element => <svg {...base}><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /></svg>,
  folder: (): React.JSX.Element => <svg {...base}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  folderPlus: (): React.JSX.Element => <svg {...base}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10.5v5M9.5 13h5" /></svg>,
  doc: (): React.JSX.Element => <svg {...base}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>,
  assistant: (): React.JSX.Element => <svg {...base}><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" /><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /><path d="M5 16v4M3 18h4" /></svg>,
  external: (): React.JSX.Element => <svg {...base}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
  gear: (): React.JSX.Element => <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  search: (): React.JSX.Element => <svg {...base}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>,
  plus: (): React.JSX.Element => <svg {...base}><path d="M12 5v14M5 12h14" /></svg>,
  terminal: (): React.JSX.Element => <svg {...base}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 9l3 3-3 3M12 15h5" /></svg>,
  trash: (): React.JSX.Element => <svg {...base}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  edit: (): React.JSX.Element => <svg {...base}><path d="M4 20h4l10-10-4-4L4 16v4z" /><path d="M13 7l4 4" /></svg>,
  play: (): React.JSX.Element => <svg {...base} width={14} height={14} fill="currentColor" stroke="none"><path d="M7 5v14l12-7z" /></svg>,
  grip: (): React.JSX.Element => <svg {...base}><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={3} /></svg>,
  star: (): React.JSX.Element => <svg {...base}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg>,
  check: (): React.JSX.Element => <svg {...base}><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M8 12l3 3 5-6" /></svg>,
  spinner: (): React.JSX.Element => <svg {...base}><path d="M12 3a9 9 0 1 0 9 9" /></svg>,
  question: (): React.JSX.Element => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5M12 17h.01" /></svg>,
  eye: (): React.JSX.Element => <svg {...base}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  done: (): React.JSX.Element => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></svg>,
  info: (): React.JSX.Element => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5h.01" /></svg>,
  cpu: (): React.JSX.Element => <svg {...base}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>,
  columns: (): React.JSX.Element => <svg {...base}><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></svg>,
  shield: (): React.JSX.Element => <svg {...base}><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  download: (): React.JSX.Element => <svg {...base}><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg>,
  refresh: (): React.JSX.Element => <svg {...base}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>,
  workflow: (): React.JSX.Element => <svg {...base}><rect x="3" y="4" width="7" height="5" rx="1.5" /><rect x="14" y="15" width="7" height="5" rx="1.5" /><path d="M10 6.5h2.5a2 2 0 0 1 2 2V13M14.5 13l-2-2M14.5 13l2-2" /><path d="M6.5 9v6.5a2 2 0 0 0 2 2H14" /></svg>,
  runs: (): React.JSX.Element => <svg {...base}><path d="M7 5v14l12-7z" /></svg>,
  close: (): React.JSX.Element => <svg {...base} width={14} height={14}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  more: (): React.JSX.Element => <svg {...base} width={14} height={14}><path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} /></svg>,
  chevron: (): React.JSX.Element => <svg {...base} width={14} height={14}><path d="M9 6l6 6-6 6" /></svg>
}

/** Иконки нод воркфлоу (WorkflowCanvas, инспектор) — по типу ноды. */
export const WfNodeIcon: Record<WfNodeType, () => React.JSX.Element> = {
  start: (): React.JSX.Element => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l5.5-3.5z" /></svg>,
  work: (): React.JSX.Element => <svg {...base}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></svg>,
  ask: (): React.JSX.Element => <svg {...base}><path d="M4 5h16v11H9l-5 4z" /><path d="M10 9.5a2 2 0 1 1 2.8 1.8c-.5.2-.8.6-.8 1.2M12 14.5h.01" /></svg>,
  gate: Icon.shield,
  human: (): React.JSX.Element => <svg {...base}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>,
  condition: (): React.JSX.Element => <svg {...base}><path d="M12 3l9 9-9 9-9-9z" /><path d="M10 10a2 2 0 1 1 2.8 1.8c-.5.2-.8.6-.8 1.2M12 16h.01" /></svg>,
  merge: (): React.JSX.Element => <svg {...base}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 7v10M6 7c0 4 4 5 10 5" /></svg>,
  end: (): React.JSX.Element => <svg {...base}><circle cx="12" cy="12" r="9" /><rect x="9" y="9" width="6" height="6" rx="1" /></svg>
}
