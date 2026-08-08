import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CameraDevice,
  enumerateCameras,
  openCamera,
  pickBestCamera,
  watchDeviceChanges,
} from '../lib/camera'

export function useCamera() {
  const [cameras, setCameras] = useState<CameraDevice[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  const refresh = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      const list = await enumerateCameras()
      setCameras(list)
      const best = pickBestCamera(list)
      setSelectedId((prev) => {
        if (prev && list.some((c) => c.deviceId === prev)) return prev
        return best?.deviceId ?? null
      })
      return list
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Camera enumeration failed')
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  const start = useCallback(
    async (deviceId?: string) => {
      let id = deviceId ?? selectedId
      if (!id) {
        // Enumerate fresh and pick best
        try {
          const list = await enumerateCameras()
          setCameras(list)
          const best = pickBestCamera(list)
          id = best?.deviceId ?? list[0]?.deviceId ?? null
          if (id) setSelectedId(id)
        } catch {
          /* fall through */
        }
      }
      if (!id) {
        setError('No camera found. Plug in the Logitech USB camera.')
        return null
      }
      stop()
      try {
        const s = await openCamera(id)
        streamRef.current = s
        setStream(s)
        setSelectedId(id)
        setError(null)
        return s
      } catch (e) {
        // Try every other camera
        const list = cameras.length ? cameras : await enumerateCameras()
        for (const cam of list) {
          if (cam.deviceId === id) continue
          try {
            const s = await openCamera(cam.deviceId)
            streamRef.current = s
            setStream(s)
            setSelectedId(cam.deviceId)
            setError(null)
            return s
          } catch {
            /* try next */
          }
        }
        setError(e instanceof Error ? e.message : 'Failed to open camera — check Windows privacy settings for Camera')
        return null
      }
    },
    [selectedId, stop, cameras],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const list = await refresh()
      if (cancelled || !list.length) return
      const best = pickBestCamera(list) ?? list[0]
      if (best) await start(best.deviceId)
    })()
    const unsub = watchDeviceChanges(() => {
      refresh()
    })
    return () => {
      cancelled = true
      unsub()
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = cameras.find((c) => c.deviceId === selectedId) ?? null

  return {
    cameras,
    selected,
    selectedId,
    setSelectedId,
    stream,
    error,
    scanning,
    refresh,
    start,
    stop,
  }
}
