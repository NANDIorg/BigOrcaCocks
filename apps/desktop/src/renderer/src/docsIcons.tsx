import type React from 'react'

/** Мелкие (14px) иконки окна «Документы» — как в макете docs/mockups/docs-viewer/concept-a.html. */
const s = { className: 'docs-i', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const DocIcon = {
  file: (): React.JSX.Element => <svg {...s}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>,
  doc: (): React.JSX.Element => <svg {...s}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>,
  folder: (): React.JSX.Element => <svg {...s}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  folderOpen: (): React.JSX.Element => <svg {...s}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" /><path d="M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.8 11a1 1 0 0 0-1-1.3H8.4a2 2 0 0 0-1.9 1.4L4 19" /></svg>,
  link: (): React.JSX.Element => <svg {...s}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>,
  image: (): React.JSX.Element => <svg {...s}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" /></svg>,
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
  branch: (): React.JSX.Element => <svg {...s}><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-6 3-10 6" /></svg>,
  // Виды файлов (docView.ts → `DocIconName`) и действия просмотрщика — docs/design/docs-files/variant-1.html.
  code: (): React.JSX.Element => <svg {...s}><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" /></svg>,
  config: (): React.JSX.Element => <svg {...s}><path d="M8 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" /></svg>,
  text: (): React.JSX.Element => <svg {...s}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 12h6M9 15h6M9 18h3" /></svg>,
  html: (): React.JSX.Element => <svg {...s}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M10 13l-2 2 2 2M14 13l2 2-2 2" /></svg>,
  pdf: (): React.JSX.Element => <svg {...s}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M8.5 17v-4h1.5a1.3 1.3 0 0 1 0 2.6H8.5M13 13v4h1a2 2 0 0 0 0-4z" /></svg>,
  binary: (): React.JSX.Element => <svg {...s}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8.5 9v6M15.5 9v6M11 9h2v6h-2z" /></svg>,
  env: (): React.JSX.Element => <svg {...s}><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3M17 6l3 3M15 8l2 2" /></svg>,
  lock: (): React.JSX.Element => <svg {...s}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>,
  copy: (): React.JSX.Element => <svg {...s}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>,
  more: (): React.JSX.Element => <svg {...s}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>,
  eye: (): React.JSX.Element => <svg {...s}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  fit: (): React.JSX.Element => <svg {...s}><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /></svg>,
  findIn: (): React.JSX.Element => <svg {...s}><path d="M4 6h12M4 11h7M4 16h5" /><circle cx="16" cy="15" r="3.2" /><path d="M18.4 17.4 21 20" /></svg>,
  warn: (): React.JSX.Element => <svg {...s}><path d="M12 4 2.8 19a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5z" /><path d="M12 10v4M12 17h.01" /></svg>
}
