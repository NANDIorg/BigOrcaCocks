import type React from 'react'
import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface Props {
  ptyId: string
}

/** xterm.js, привязанный к одному PTY в main. Живёт, пока открыта панель. */
export function Terminal({ ptyId }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const term = new XTerm({
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: { background: '#000000' },
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    window.orca.pty.resize(ptyId, term.cols, term.rows)

    const offData = window.orca.pty.onData(ptyId, (d) => term.write(d))
    const offExit = window.orca.pty.onExit(ptyId, (code) =>
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
    )
    const onInput = term.onData((d) => window.orca.pty.write(ptyId, d))

    const ro = new ResizeObserver(() => {
      fit.fit()
      window.orca.pty.resize(ptyId, term.cols, term.rows)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      onInput.dispose()
      offData()
      offExit()
      term.dispose()
    }
  }, [ptyId])

  return <div ref={ref} />
}
