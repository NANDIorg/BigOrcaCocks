import type React from 'react'
import { useEffect, useState } from 'react'

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
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = window.setTimeout(() => setState('idle'), 1500)
    return () => window.clearTimeout(t)
  }, [state])
  return (
    <button
      type="button"
      className="copy-btn"
      disabled={!text}
      onClick={() => navigator.clipboard.writeText(text).then(() => setState('ok'), () => setState('fail'))}
    >
      {state === 'ok' ? 'Скопировано' : state === 'fail' ? 'Не удалось' : 'Скопировать'}
    </button>
  )
}

/** Склонение по числу: plural(3, 'агент', 'агента', 'агентов'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

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
