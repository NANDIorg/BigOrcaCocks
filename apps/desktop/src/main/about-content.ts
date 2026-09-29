import { mtIn, type MainLocale } from './i18n'
import { PROJECT_URL } from './app-menu'
import { appColors, appFontFamily } from '../shared/theme'

interface AboutContent {
  locale: MainLocale
  version: string
  iconPng: Uint8Array
}

const ISSUE_URL = `${PROJECT_URL}/issues/new`

/** Даже подмена ссылки в DOM не даёт этой небольшой поверхности открыть произвольный адрес. */
export function aboutExternalUrl(url: string): string | null {
  return url === PROJECT_URL || url === ISSUE_URL ? url : null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

/** Статический документ без preload и скриптов: для двух ссылок достаточно нативного поведения HTML. */
export function buildAboutHtml({ locale, version, iconPng }: AboutContent): string {
  const t = (key: Parameters<typeof mtIn>[1], params?: Parameters<typeof mtIn>[2]): string => escapeHtml(mtIn(locale, key, params))
  const description = mtIn(locale, 'menu.aboutCredits').split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('')
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'"
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">
  <title>${t('menu.about')}</title>
  <style>
    :root {
      ${Object.entries(appColors).map(([name, value]) => `--${name}: ${value};`).join('\n      ')}
      --font-sans: ${appFontFamily};
      color-scheme: dark;
      --border: var(--chip);
      font-family: var(--font-sans);
      color: var(--text);
      background: var(--page);
      scrollbar-color: var(--border) var(--page);
      scrollbar-width: thin;
    }
    * { box-sizing: border-box; }
    body { margin: 0; user-select: none; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--page); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--muted); }
    .titlebar { height: 38px; app-region: drag; }
    main {
      display: flex;
      flex-direction: column;
      align-items: center;
      max-width: 480px;
      margin: 0 auto;
      padding: 14px 34px 30px;
      text-align: center;
    }
    .logo { width: 92px; height: 92px; display: block; margin-bottom: 19px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; font-weight: 650; letter-spacing: -0.8px; }
    .version { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .description { max-width: 350px; margin-top: 21px; font-size: 14px; line-height: 1.55; }
    .description p { margin: 0; }
    .description p + p { margin-top: 6px; color: var(--muted); }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 100%; margin-top: 25px; }
    .action {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      text-decoration: none;
      font-size: 12px;
      line-height: 1.4;
      font-weight: 600;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .action:hover { background: var(--side-2); border-color: var(--muted); }
    .action:active { background: var(--card); }
    .action-primary { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
    .action-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .action-primary:active { background: var(--accent-2); border-color: var(--accent-2); }
    .action:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
    .author { margin: 23px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    @media (max-width: 390px) {
      main { padding-inline: 24px; }
      .actions { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { .action { transition: none; } }
    @media (forced-colors: active) {
      :root { color: CanvasText; background: Canvas; scrollbar-color: auto; }
      .version, .description p + p, .author { color: CanvasText; }
      .action { color: LinkText; background: Canvas; border-color: ButtonText; }
      .action:focus-visible { outline-color: Highlight; }
    }
  </style>
</head>
<body>
  <div class="titlebar" aria-hidden="true"></div>
  <main aria-labelledby="app-name">
    <img class="logo" src="data:image/png;base64,${Buffer.from(iconPng).toString('base64')}" alt="" width="92" height="92">
    <h1 id="app-name">orca-board</h1>
    <p class="version">${t('about.version', { version })}</p>
    <div class="description">${description}</div>
    <nav class="actions" aria-label="${t('about.links')}">
      <a class="action action-primary" href="${PROJECT_URL}" target="_blank" rel="noreferrer" autofocus><span>${t('about.project')}</span></a>
      <a class="action" href="${ISSUE_URL}" target="_blank" rel="noreferrer"><span>${t('about.reportIssue')}</span></a>
    </nav>
    <p class="author">${t('about.author', { author: 'nandi' })}</p>
  </main>
</body>
</html>`
}
