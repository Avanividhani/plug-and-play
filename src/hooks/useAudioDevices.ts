import { useCallback, useEffect, useRef, useState } from 'react'
import { enumerateAudioDevices, type AudioDevice, watchDeviceChanges } from '../lib/camera'

export function useAudioDevices() {
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [scanning, setScanning] = useState(false)
  const [showAllAudio, setShowAllAudioState] = useState(false)
  const showAllRef = useRef(false)

  const refresh = useCallback(async (includeAll?: boolean) => {
    const withAll = includeAll ?? showAllRef.current
    setScanning(true)
    try {
      const list = await enumerateAudioDevices({ includeAll: withAll })
      setAudioDevices(list)
      return list
    } catch {
      setAudioDevices([])
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  const setShowAllAudio = useCallback(
    (show: boolean) => {
      showAllRef.current = show
      setShowAllAudioState(show)
      void refresh(show)
    },
    [refresh],
  )

  useEffect(() => {
    void refresh()
    return watchDeviceChanges(() => {
      void refresh()
    })
  }, [refresh])

  return { audioDevices, scanning, refresh, showAllAudio, setShowAllAudio }
}
