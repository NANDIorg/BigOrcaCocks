import { useEffect, useState } from 'react'

/** Текущее время, обновляемое по таймеру: компонент перерисовывается раз в intervalMs. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
