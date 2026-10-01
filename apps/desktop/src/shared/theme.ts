/** Общий набор токенов для renderer, окон main и терминалов. */
const graphiteColors = {
  page: '#252422',
  frame: '#2b2a28',
  side: '#302f2c',
  'side-2': '#363530',
  card: '#3a3935',
  'card-hover': '#42413c',
  chip: '#5a5850',
  line: '#eeebe31c',
  'overlay-ink': '#ffffff',
  'code-bg': '#1e1d1b',
  'tooltip-bg': '#1f1e1c',
  'preview-bg': '#1f1e1c',
  text: '#eeebe3',
  muted: '#b2afa5',
  subtle: '#d2cfc5',
  accent: '#b4c9bd',
  'accent-2': '#98b3a4',
  'accent-hover': '#cad9cf',
  'on-accent': '#252422',
  'col-backlog': '#848279',
  'col-ready': '#a5b5c4',
  'col-progress': '#d8a36a',
  'col-input': '#dfc58f',
  'col-review': '#bea8c1',
  'col-done': '#99bfa6',
  danger: '#e9998e',
  notification: '#ef4444',
  'scrollbar-thumb': '#5a5850',
  'scrollbar-track': '#00000000',
  'wf-accept': '#99bfa6',
  'term-bg': '#1f1e1c',
  'term-text': '#eeebe3',
  'term-cursor': '#b4c9bd',
  'term-muted': '#b2afa5',
  s1: '#a5b5c4',
  s2: '#9eb6a2',
  s3: '#ccaa87',
  s4: '#b6a3ba',
  s5: '#d6c291',
  's-other': '#98968d',
  's-unknown': '#77746b'
} as const

export const APP_THEMES = ['graphite', 'slate', 'forest', 'paper'] as const
export type AppTheme = typeof APP_THEMES[number]
export type ThemeColors = { readonly [Key in keyof typeof graphiteColors]: string }
export interface ThemeDefinition {
  readonly id: AppTheme
  readonly colorScheme: 'dark' | 'light'
  readonly colors: ThemeColors
}

export const DEFAULT_APP_THEME: AppTheme = 'graphite'

/** Семантика и геометрия общие; спокойные темы меняют только поверхности и согласованные акценты. */
export const appThemes: Record<AppTheme, ThemeDefinition> = {
  graphite: { id: 'graphite', colorScheme: 'dark', colors: graphiteColors },
  slate: { id: 'slate', colorScheme: 'dark', colors: {
    ...graphiteColors,
    page: '#23282d', frame: '#292f35', side: '#2d343a', 'side-2': '#333b42',
    card: '#313a41', 'card-hover': '#394148', chip: '#53616d', line: '#e6edf31c',
    text: '#e6edf3', muted: '#b3bec8', subtle: '#ccd5dd',
    accent: '#afc4d7', 'accent-2': '#96b0c7', 'accent-hover': '#c6d6e4', 'on-accent': '#23282d',
    'scrollbar-thumb': '#53616d', 'term-bg': '#1b2025', 'term-text': '#e6edf3', 'term-cursor': '#afc4d7', 'term-muted': '#b3bec8',
    'code-bg': '#1c2024', 'tooltip-bg': '#1b2025', 'preview-bg': '#1b2025'
  } },
  forest: { id: 'forest', colorScheme: 'dark', colors: {
    ...graphiteColors,
    page: '#232923', frame: '#2a3029', side: '#30362d', 'side-2': '#353d32',
    card: '#343b30', 'card-hover': '#3b4236', chip: '#596451', line: '#ebeee21c',
    text: '#ebeee2', muted: '#b9c1ae', subtle: '#d3d9c9',
    accent: '#c1cca5', 'accent-2': '#a5b68b', 'accent-hover': '#d5dec0', 'on-accent': '#232923',
    'scrollbar-thumb': '#596451', 'term-bg': '#1c211c', 'term-text': '#ebeee2', 'term-cursor': '#c1cca5', 'term-muted': '#b9c1ae',
    'code-bg': '#1c211c', 'tooltip-bg': '#1c211c', 'preview-bg': '#1c211c'
  } },
  paper: { id: 'paper', colorScheme: 'light', colors: {
    page: '#f4f3ef', frame: '#ebece6', side: '#e7e9e2', 'side-2': '#dfe3da',
    card: '#ffffff', 'card-hover': '#edf0e9', chip: '#b4bcb0', line: '#25302726',
    'overlay-ink': '#29332c', 'code-bg': '#e7e9e2', 'tooltip-bg': '#ffffff', 'preview-bg': '#ebece6',
    text: '#29332c', muted: '#5b675e', subtle: '#455249',
    accent: '#466355', 'accent-2': '#395346', 'accent-hover': '#395346', 'on-accent': '#ffffff',
    'col-backlog': '#647062', 'col-ready': '#49657b', 'col-progress': '#85582e',
    'col-input': '#76602f', 'col-review': '#76536f', 'col-done': '#46664f', danger: '#a4433a', notification: '#ef4444',
    'scrollbar-thumb': '#9aa693', 'scrollbar-track': '#00000000', 'wf-accept': '#46664f',
    'term-bg': '#20251f', 'term-text': '#e7ecdf', 'term-cursor': '#bfd1af', 'term-muted': '#b2beab',
    s1: '#49657b', s2: '#46664f', s3: '#85582e', s4: '#76536f', s5: '#76602f',
    's-other': '#657061', 's-unknown': '#7b8577'
  } }
}

export function isAppTheme(value: unknown): value is AppTheme {
  return APP_THEMES.some(theme => theme === value)
}

/** Усиливаем только семантические цвета; поверхности, текст, логотип и терминал сохраняют исходные оттенки. */
const saturatedStatusColors = {
  'col-ready': '#80bfff', 'col-progress': '#ffb45c', 'col-input': '#f4d35e',
  'col-review': '#d0a3ff', 'col-done': '#72d99d', danger: '#ff9b92',
  'wf-accept': '#72d99d', s1: '#80bfff', s2: '#72d99d', s3: '#ffb45c', s4: '#d0a3ff', s5: '#f4d35e'
} as const satisfies Partial<ThemeColors>

const saturatedColors: Record<AppTheme, Partial<ThemeColors>> = {
  graphite: { ...saturatedStatusColors, accent: '#79dfad', 'accent-2': '#59cb95', 'accent-hover': '#a0edc7' },
  slate: { ...saturatedStatusColors, accent: '#80c6ff', 'accent-2': '#65b4ed', 'accent-hover': '#addbff' },
  forest: { ...saturatedStatusColors, accent: '#c2e66b', 'accent-2': '#aed04f', 'accent-hover': '#d5ee9a' },
  paper: {
    accent: '#276443', 'accent-2': '#185337', 'accent-hover': '#185337',
    'col-ready': '#245d96', 'col-progress': '#995006', 'col-input': '#805b07',
    'col-review': '#814095', 'col-done': '#17683c', danger: '#b32c21',
    'wf-accept': '#17683c', s1: '#245d96', s2: '#17683c', s3: '#995006', s4: '#814095', s5: '#805b07'
  }
}

export function getAppTheme(value: unknown, highSaturation = false): ThemeDefinition {
  const theme = appThemes[isAppTheme(value) ? value : DEFAULT_APP_THEME]
  return highSaturation ? { ...theme, colors: { ...theme.colors, ...saturatedColors[theme.id] } } : theme
}

/** Дефолтный адаптер для старых потребителей; выбранная тема всегда берётся через getAppTheme. */
export const appColors: ThemeColors = graphiteColors

export const appFontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
