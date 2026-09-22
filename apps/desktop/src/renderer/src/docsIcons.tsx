import type React from 'react'

/** Мелкие (14px) иконки окна «Документы» — как в макете docs/mockups/docs-viewer/concept-a.html. */
const s = { className: 'docs-i', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const DocIcon = {
  file: (): React.JSX.Element => <svg {...s}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>,
  doc: (): React.JSX.Element => <svg {...s}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>,
  folder: (): React.JSX.Element => <svg {...s}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  reveal: (): React.JSX.Element => <svg {...s}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5" /></svg>,
  chev: (): React.JSX.Element => <svg {...s} className="docs-i docs-chev"><path d="M9 6l6 6-6 6" /></svg>,
  back: (): React.JSX.Element => <svg {...s}><path d="M15 18l-6-6 6-6" /></svg>,
  forward: (): React.JSX.Element => <svg {...s}><path d="M9 6l6 6-6 6" /></svg>,
  up: (): React.JSX.Element => <svg {...s}><path d="M6 15l6-6 6 6" /></svg>,
  down: (): React.JSX.Element => <svg {...s}><path d="M6 9l6 6 6-6" /></svg>,
  toc: (): React.JSX.Element => <svg {...s}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>,
  external: (): React.JSX.Element => <svg {...s}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
  search: (): React.JSX.Element => <svg {...s}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>,
  refresh: (): React.JSX.Element => <svg {...s}><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" /><path d="M21 3v5h-5" /></svg>,
  close: (): React.JSX.Element => <svg {...s}><path d="M18 6L6 18M6 6l12 12" /></svg>,
  clock: (): React.JSX.Element => <svg {...s}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  branch: (): React.JSX.Element => <svg {...s}><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-6 3-10 6" /></svg>
}
