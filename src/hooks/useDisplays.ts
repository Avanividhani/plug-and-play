import { useCallback, useEffect, useRef, useState } from 'react'
import type { DisplayInfo, DisplayChangeEvent } from '../../electron/preload'

type Options = {
  onEvent?: (kind: DisplayChangeEvent['kind'], display: DisplayInfo | null, displays: DisplayInfo[]) => void
}

export function useDisplays({ onEvent }: Options = {}) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [ready, setReady] = useState(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const refresh = useCallback(async () => {
    if (!window.lumen) return
    const list = await window.lumen.listDisplays()
    setDisplays(list)
    setReady(true)
  }, [])

  useEffect(() => {
    refresh()
    if (!window.lumen) return
    const off = window.lumen.on('devices:display-change', (payload) => {
      const ev = payload as DisplayChangeEvent
      setDisplays(ev.displays)
      onEventRef.current?.(ev.kind, ev.display, ev.displays)
    })
    return () => {
      off()
    }
  }, [refresh])

  return { displays, ready, refresh }
}
