import type React from 'react'
import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface Props {
  ptyId: string
  visible: boolean
}

/** xterm.js на один PTY. Скрытый терминал остаётся смонтированным, чтобы не терять историю. */
export function Terminal({ ptyId, visible }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const fitRef = useRef<{ term: XTerm; fit: FitAddon } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = new XTerm({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: { background: '#1b1c21' },
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fitRef.current = { term, fit }

    const doFit = (): void => {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return
      fit.fit()
      window.orca.pty.resize(ptyId, term.cols, term.rows)
    }
    doFit()

    const offData = window.orca.pty.onData(ptyId, (d) => term.write(d))
    const offExit = window.orca.pty.onExit(ptyId, (code) =>
      term.write(`\r\n\x1b[90m[процесс завершился с кодом ${code}]\x1b[0m\r\n`)
    )
    const onInput = term.onData((d) => window.orca.pty.write(ptyId, d))
    const ro = new ResizeObserver(doFit)
    ro.observe(el)

    return () => {
      ro.disconnect()
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
      fitRef.current = null
    }
  }, [ptyId])

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        const cur = fitRef.current
        if (cur && ref.current && ref.current.offsetWidth > 0) {
          cur.fit.fit()
          window.orca.pty.resize(ptyId, cur.term.cols, cur.term.rows)
          cur.term.focus()
        }
      })
    }
  }, [visible, ptyId])

  return <div ref={ref} />
}
