import type React from 'react'
import { useEffect, useState } from 'react'
import { useT } from '../i18n'

/** Заголовок раздела «О проекте»: название, пояснение и действия справа. */
export function SectionHead({ title, hint, children }: {
  title: string
  hint?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="sec-head">
      <div className="sec-head-text">
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </div>
      {children}
    </div>
  )
}

/** Переключатель вкл/выкл (кнопка с role="switch"). */
export function Switch({ on, disabled, title, onChange }: {
  on: boolean
  disabled?: boolean
  title?: string
  onChange(on: boolean): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch ${on ? 'on' : ''}`}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
    />
  )
}

/** Кнопка «Скопировать» с подтверждением «Скопировано». */
export function CopyButton({ text }: { text: string }): React.JSX.Element {
  const t = useT()
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 1500)
    return () => window.clearTimeout(timer)
  }, [state])
  return (
    <button
      type="button"
      className="copy-btn"
      disabled={!text}
      onClick={() => navigator.clipboard.writeText(text).then(() => setState('ok'), () => setState('fail'))}
    >
      {state === 'ok' ? t('config.about.copied') : state === 'fail' ? t('config.about.copyFailed') : t('config.about.copy')}
    </button>
  )
}

/**
 * Переведённая фраза с командой или путём в `<code>` (или `<b>`): `{name}` в тексте заменяется на выделенное
 * `value`. Порядок слов в языках разный, поэтому фразу не собираем из кусков вокруг кода.
 */
export function withCode(text: string, value: string, name = 'cmd', Tag: 'code' | 'b' = 'code'): React.ReactNode {
  const [before, ...rest] = text.split(`{${name}}`)
  if (!rest.length) return text
  return <>{before}<Tag>{value}</Tag>{rest.join(value)}</>
}

// Склонение живёт в .ts-модуле, чтобы его могли импортировать модули логики с тестами под node --test.
export { plural } from '../plural'

/** Пункт меню разделов (слева в «О проекте» и «Настройках»). */
export interface NavEntry<S extends string> {
  id: S
  label: string
  icon: () => React.JSX.Element
  /** Счётчик справа; не показывается, пока данные не загружены (showCount). */
  count?: string
  tone?: 'warn' | 'live'
  title?: string
}

export function NavItem<S extends string>({ item, current, showCount = true, onGo }: {
  item: NavEntry<S>
  current: S
  showCount?: boolean
  onGo(id: S): void
}): React.JSX.Element {
  const on = current === item.id
  return (
    <button
      type="button"
      className={`about-nav-item ${on ? 'on' : ''}`}
      aria-current={on ? 'page' : undefined}
      title={item.title}
      onClick={() => onGo(item.id)}
    >
      <item.icon />
      <span className="about-nav-label">{item.label}</span>
      {showCount && item.count && (
        <span className={`about-nav-count ${item.tone ?? ''}`} title={item.count}>{item.count}</span>
      )}
    </button>
  )
}

/** Выбранный раздел меню из localStorage; неизвестное значение — fallback. */
export function storedSection<S extends string>(key: string, all: readonly S[], fallback: S): S {
  try {
    const v = localStorage.getItem(key) as S | null
    return v && all.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function storeSection(key: string, s: string): void {
  try {
    localStorage.setItem(key, s)
  } catch {
    // localStorage недоступен — раздел просто не переживёт перезапуск
  }
}
