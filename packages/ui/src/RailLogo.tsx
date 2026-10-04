import type React from 'react'
import { useEffect, useState } from 'react'
import logo from '../assets/orcaTemplate.svg?raw'

/** Blob позволяет маске работать и в готовом приложении, загруженном через file://. */
export function RailLogo(): React.JSX.Element {
  const [maskUrl, setMaskUrl] = useState<string>()
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([logo], { type: 'image/svg+xml' }))
    setMaskUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [])

  return (
    <span
      className="app-logo"
      role="img"
      aria-label="orca-board"
      style={maskUrl ? { maskImage: `url("${maskUrl}")` } : undefined}
    />
  )
}
