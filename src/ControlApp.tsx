import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DevicePanel } from './components/DevicePanel'
import { CalibrationPanel } from './components/CalibrationPanel'
import { ContentPanel } from './components/ContentPanel'
import { EdgeBlendPanel } from './components/EdgeBlendPanel'
import { SurfaceMapPanel } from './components/SurfaceMapPanel'
import { ManualProjectorPanel } from './components/ManualProjectorPanel'
import { useDisplays } from './hooks/useDisplays'
import { useCamera } from './hooks/useCamera'
import { useAudioDevices } from './hooks/useAudioDevices'
import { friendlyDisplayName, isVrPhantomDisplay } from './lib/displayNames'
import { DEFAULT_BLEND, type BlendConfig } from './lib/blending'
import {
  runAutoCalibration,
  applyHomography,
  captureAveragedFrame,
  captureFrame,
  type CalibrationProgress,
  type CalibrationResult,
} from './lib/calibration'
import {
  detectSurfacesFromVideo,
  presetSurfaces,
  surfaceToHomography,
  type DetectedSurface,
} from './lib/surfaceDetect'
import {
  cameraCornersToProjector,
  type CamProjAlign,
} from './lib/camProjAlign'
import {
  alignFromFootprint,
  alignFromProbe,
  detectLitBounds,
  detectProbeBlob,
  detectProjectorFootprint,
  litCoverageInsideQuad,
  PROBE_QUAD,
  quadBounds,
  type Quad,
} from './lib/seeMatch'
import {
  buildCamToProjMap,
  buildPatternSequence,
  clipPolygonToGrayFootprint,
  footprintFromGrayMap,
  hullToAlignQuad,
  mapPolygonPointwiseThroughGray,
  mapRegionThroughGray,
  pickBestGrayMap,
  unionFootprints,
  type CamToProjMap,
} from './lib/graycode'
import {
  buildFaceFromOutline,
  findFaceForPolygon,
  mapPolygonThroughFace,
  refitFaceRegion,
  type FaceKind,
  type FaceRegion,
} from './lib/faceRegions'
import type { WorkMode } from './components/SurfaceMapPanel'
import {
  loadOpenCV,
  opencvScanSurfaces,
  warmOpenCV,
} from './lib/opencvVision'
import type { AppEvent, CalStatus, MediaItem, Toast } from './lib/types'
import type { DisplayInfo } from '../electron/preload'
import {
  loadManualProjectorCalibration,
  save_manual_projector_calibration,
} from './lib/manualProjectorCalibration'

type CameraWorkspaceState = {
  surfaces: DetectedSurface[]
  selectedSurfaceId: string | null
  faces: FaceRegion[]
  workMode: WorkMode
  projOffset: { x: number; y: number }
  align: CamProjAlign | null
  hasGrayMap: boolean
  footprint: { x: number; y: number }[] | null
  calibStep: 'need-match' | 'outline-light' | 'draw-target'
  clickCorners: { x: number; y: number }[]
  refined: Record<string, { x: number; y: number }[]>
}

export function ControlApp() {
  const [events, setEvents] = useState<AppEvent[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [activeProjectorIds, setActiveProjectorIds] = useState<Set<number>>(new Set())
  const [blend, setBlend] = useState<BlendConfig>(DEFAULT_BLEND)
  const [media, setMedia] = useState<MediaItem[]>([])
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null)
  const [calStatus, setCalStatus] = useState<CalStatus>('idle')
  const [calProgress, setCalProgress] = useState<CalibrationProgress | null>(null)
  const [calResults, setCalResults] = useState<CalibrationResult[]>([])
  const [calError, setCalError] = useState<string | null>(null)
  const [surfaces, setSurfaces] = useState<DetectedSurface[]>([])
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [surfaceError, setSurfaceError] = useState<string | null>(null)
  const [align, setAlign] = useState<CamProjAlign | null>(null)
  const [aligning, setAligning] = useState(false)
  const [alignProgress, setAlignProgress] = useState<string | null>(null)
  const [hasGrayMap, setHasGrayMap] = useState(false)
  const [footprint, setFootprint] = useState<{ x: number; y: number }[] | null>(null)
  /** Detected calib dots in camera (for overlay) */
  const [calibDots, setCalibDots] = useState<{ x: number; y: number }[]>([])
  /** Where a known projector point SHOULD appear in camera (green cross) */
  const [calibExpect, setCalibExpect] = useState<{ x: number; y: number } | null>(null)
  /** outline-light = drag around the real white blob; draw-target = drag where you want content */
  const [calibStep, setCalibStep] = useState<'need-match' | 'outline-light' | 'draw-target'>('need-match')
  const [clickCorners, setClickCorners] = useState<{ x: number; y: number }[]>([])
  const [projOffset, setProjOffset] = useState({ x: 0, y: 0 })
  const [cameraZoom, setCameraZoom] = useState(1)
  const [faces, setFaces] = useState<FaceRegion[]>([])
  const [workMode, setWorkMode] = useState<WorkMode>('content')
  const [projectorModeByDisplayId, setProjectorModeByDisplayId] = useState<
    Record<number, 'camera' | 'manual'>
  >({})
  const [activeCameraControlDisplayId, setActiveCameraControlDisplayId] = useState<number | null>(null)
  const [manualCornersByDisplayId, setManualCornersByDisplayId] = useState<
    Record<number, { x: number; y: number }[]>
  >({})
  const [manualTargetsByDisplayId, setManualTargetsByDisplayId] = useState<
    Record<
      number,
      { id: string; label: string; corners: { x: number; y: number }[]; mediaId?: string | null }[]
    >
  >({})
  const [selectedManualTargetByDisplayId, setSelectedManualTargetByDisplayId] = useState<
    Record<number, string | null>
  >({})
  const [manualMediaByDisplayId, setManualMediaByDisplayId] = useState<Record<number, MediaItem[]>>({})
  const [selectedManualMediaByDisplayId, setSelectedManualMediaByDisplayId] = useState<
    Record<number, string | null>
  >({})
  const [cameraWorkspaceByDisplayId, setCameraWorkspaceByDisplayId] = useState<
    Record<number, CameraWorkspaceState>
  >({})
  const friendlyProjectorName = friendlyDisplayName
  const videoRef = useRef<HTMLVideoElement>(null)
  const alignRef = useRef<CamProjAlign | null>(null)
  const offsetRef = useRef(projOffset)
  const refinedProjRef = useRef<Record<string, { x: number; y: number }[]>>({})
  const grayMapRef = useRef<CamToProjMap | null>(null)
  /** Per-projector gray maps (dual soft-edge). Index = projector logical index. */
  const grayMapsRef = useRef<(CamToProjMap | null)[]>([])
  const facesRef = useRef<FaceRegion[]>([])
  const calibStepRef = useRef(calibStep)
  const blackFrameRef = useRef<ImageData | null>(null)
  const whiteFrameRef = useRef<ImageData | null>(null)
  const prevActiveCameraControlRef = useRef<number | null>(null)
  const hydratingCameraWorkspaceRef = useRef(false)
  alignRef.current = align
  offsetRef.current = projOffset
  calibStepRef.current = calibStep
  facesRef.current = faces

  const pushEvent = useCallback((kind: AppEvent['kind'], message: string) => {
    setEvents((prev) =>
      [{ id: `${Date.now()}-${Math.random()}`, at: Date.now(), kind, message }, ...prev].slice(0, 40),
    )
  }, [])

  const pushToast = useCallback((kind: Toast['kind'], message: string) => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts((prev) => [...prev, { id, kind, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200)
  }, [])

  const { displays } = useDisplays({
    onEvent: (kind, display) => {
      const name = display?.label || 'Display'
      if (kind === 'added') {
        pushEvent('connect', `Projector connected — ${name}`)
        pushToast('connect', `Projector connected: ${name}`)
      } else if (kind === 'removed') {
        pushEvent('disconnect', `Projector disconnected — ${name}`)
        pushToast('disconnect', `Projector disconnected: ${name}`)
        if (display) {
          setActiveProjectorIds((prev) => {
            const next = new Set(prev)
            next.delete(display.id)
            return next
          })
        }
      } else {
        pushEvent('info', `Display metrics changed — ${name}`)
      }
    },
  })

  const camera = useCamera()
  const audio = useAudioDevices()

  useEffect(() => {
    if (!window.lumen) return
    const off = window.lumen.on('projector:closed', (payload) => {
      const { displayId } = payload as { displayId: number }
      setActiveProjectorIds((prev) => {
        const next = new Set(prev)
        next.delete(displayId)
        return next
      })
    })
    return () => {
      off()
    }
  }, [])

  // Warm OpenCV in background — used for sharp RANSAC plane fits on cube faces
  useEffect(() => {
    void warmOpenCV().catch(() => {
      /* optional — JS RANSAC still works */
    })
  }, [])

  useEffect(() => {
    if (camera.selected?.isLogitech || (camera.selected && !camera.selected.isBuiltin)) {
      camera.start(camera.selected.deviceId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.selectedId])

  const cameraIdsKey = camera.cameras.map((c) => c.deviceId).join('|')
  const prevCamerasRef = useRef<string>('')
  useEffect(() => {
    if (!prevCamerasRef.current) {
      prevCamerasRef.current = cameraIdsKey
      if (camera.cameras.some((c) => c.isLogitech)) {
        pushEvent('connect', `Logitech camera ready — ${camera.cameras.find((c) => c.isLogitech)!.label}`)
      }
      return
    }
    const prev = new Set(prevCamerasRef.current.split('|').filter(Boolean))
    const next = new Set(cameraIdsKey.split('|').filter(Boolean))
    for (const id of next) {
      if (!prev.has(id)) {
        const cam = camera.cameras.find((c) => c.deviceId === id)
        pushEvent('connect', `Camera connected — ${cam?.label ?? id}`)
        pushToast('connect', `Camera connected: ${cam?.label ?? 'USB camera'}`)
      }
    }
    for (const id of prev) {
      if (!next.has(id)) {
        pushEvent('disconnect', `Camera disconnected`)
        pushToast('disconnect', 'Camera disconnected')
      }
    }
    prevCamerasRef.current = cameraIdsKey
  }, [cameraIdsKey, camera.cameras, pushEvent, pushToast])

  const projectors = useMemo(
    () =>
      displays.filter(
        (d) => !d.isPrimary && !isVrPhantomDisplay(d.label, d.model, d.manufacturer),
      ),
    [displays],
  )
  const displayCount = useMemo(
    () => displays.filter((d) => !isVrPhantomDisplay(d.label, d.model, d.manufacturer)).length,
    [displays],
  )

  const defaultManualCorners = useCallback(
    () => [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ],
    [],
  )

  const projectorModeForIndex = useCallback(
    (projIndex: number): 'camera' | 'manual' => {
      const d = projectors[projIndex]
      if (!d) return 'camera'
      return projectorModeByDisplayId[d.id] ?? 'camera'
    },
    [projectors, projectorModeByDisplayId],
  )

  useEffect(() => {
    const cameraDisplays = (projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)).filter(
      (d) => (projectorModeByDisplayId[d.id] ?? 'camera') === 'camera',
    )
    if (!cameraDisplays.length) {
      if (activeCameraControlDisplayId !== null) setActiveCameraControlDisplayId(null)
      return
    }
    if (!activeCameraControlDisplayId || !cameraDisplays.some((d) => d.id === activeCameraControlDisplayId)) {
      setActiveCameraControlDisplayId(cameraDisplays[0].id)
    }
  }, [projectors, displays, projectorModeByDisplayId, activeCameraControlDisplayId])

  useEffect(() => {
    const prevId = prevActiveCameraControlRef.current
    if (prevId && prevId !== activeCameraControlDisplayId) {
      setCameraWorkspaceByDisplayId((prev) => ({
        ...prev,
        [prevId]: {
          surfaces,
          selectedSurfaceId,
          faces,
          workMode,
          projOffset,
          align,
          hasGrayMap,
          footprint,
          calibStep,
          clickCorners,
          refined: { ...refinedProjRef.current },
        },
      }))
    }
    if (!activeCameraControlDisplayId) {
      prevActiveCameraControlRef.current = null
      return
    }
    const ws = cameraWorkspaceByDisplayId[activeCameraControlDisplayId]
    if (ws) {
      hydratingCameraWorkspaceRef.current = true
      setSurfaces(ws.surfaces)
      setSelectedSurfaceId(ws.selectedSurfaceId)
      setFaces(ws.faces)
      setWorkMode(ws.workMode)
      setProjOffset(ws.projOffset)
      offsetRef.current = ws.projOffset
      setAlign(ws.align)
      alignRef.current = ws.align
      setHasGrayMap(ws.hasGrayMap)
      setFootprint(ws.footprint)
      setCalibStep(ws.calibStep)
      setClickCorners(ws.clickCorners)
      refinedProjRef.current = { ...ws.refined }
      setTimeout(() => {
        hydratingCameraWorkspaceRef.current = false
      }, 0)
    }
    prevActiveCameraControlRef.current = activeCameraControlDisplayId
  }, [activeCameraControlDisplayId])

  useEffect(() => {
    if (!activeCameraControlDisplayId || hydratingCameraWorkspaceRef.current) return
    setCameraWorkspaceByDisplayId((prev) => ({
      ...prev,
      [activeCameraControlDisplayId]: {
        surfaces,
        selectedSurfaceId,
        faces,
        workMode,
        projOffset,
        align,
        hasGrayMap,
        footprint,
        calibStep,
        clickCorners,
        refined: { ...refinedProjRef.current },
      },
    }))
  }, [
    activeCameraControlDisplayId,
    surfaces,
    selectedSurfaceId,
    faces,
    workMode,
    projOffset,
    align,
    hasGrayMap,
    footprint,
    calibStep,
    clickCorners,
  ])

  const sideForIndex = (index: number, cfg: BlendConfig = blend): 'left' | 'right' => {
    if (!cfg.swapSides) return index === 0 ? 'left' : 'right'
    return index === 0 ? 'right' : 'left'
  }

  const openProjector = async (display: DisplayInfo, index: number) => {
    if (!window.lumen) return
    await window.lumen.openProjector(display.id, index)
    const modeForDisplay = projectorModeByDisplayId[display.id] ?? 'camera'
    const liveCountAfter = activeProjectorIds.has(display.id)
      ? activeProjectorIds.size
      : activeProjectorIds.size + 1
    const cameraLiveAfter = (() => {
      const next = new Set(activeProjectorIds)
      next.add(display.id)
      const targets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
      let n = 0
      targets.forEach((d) => {
        if (!next.has(d.id)) return
        const mode = d.id === display.id ? modeForDisplay : projectorModeByDisplayId[d.id] ?? 'camera'
        if (mode === 'camera') n++
      })
      return n
    })()
    setActiveProjectorIds((prev) => new Set(prev).add(display.id))
    const blendCfg =
      cameraLiveAfter >= 2 ? { ...blend, enabled: true } : blend
    if (cameraLiveAfter >= 2 && !blend.enabled) {
      setBlend(blendCfg)
    }
    pushEvent('info', `Opened projector output on ${friendlyProjectorName(display.label, index)}`)
    if (cameraLiveAfter >= 2) {
      pushToast(
        'connect',
        '2 projectors live — overlap beams, set each to native resolution / no keystone if possible, then Auto-calibrate',
      )
    }
    await window.lumen.sendToProjector(index, 'projector:config', {
      blend: blendCfg,
      side: sideForIndex(index, blendCfg),
      projectorIndex: index,
    })

    if ((projectorModeByDisplayId[display.id] ?? 'camera') === 'manual') {
      const saved = loadManualProjectorCalibration(display.id)
      if (saved?.draggedCornersPx?.length === 4) {
        setManualCornersByDisplayId((prev) => ({
          ...prev,
          [display.id]: saved.draggedCornersPx.map((p) => ({
            x: Math.max(0.001, Math.min(0.999, p.x / Math.max(1, saved.outputSize.width))),
            y: Math.max(0.001, Math.min(0.999, p.y / Math.max(1, saved.outputSize.height))),
          })),
        }))
      } else {
        setManualCornersByDisplayId((prev) => ({
          ...prev,
          [display.id]: prev[display.id] ?? defaultManualCorners(),
        }))
      }
    }
  }

  const closeProjector = async (displayId: number) => {
    if (!window.lumen) return
    await window.lumen.closeProjector(displayId)
    setActiveProjectorIds((prev) => {
      const next = new Set(prev)
      next.delete(displayId)
      return next
    })
  }

  useEffect(() => {
    if (!window.lumen || activeProjectorIds.size === 0) return
    projectors.forEach((d, i) => {
      if (activeProjectorIds.has(d.id)) {
        window.lumen.sendToProjector(i, 'projector:config', {
          blend,
          side: sideForIndex(i, blend),
          projectorIndex: i,
        })
      }
    })
  }, [blend, activeProjectorIds, projectors])

  /** Camera draw → projector shape. Prefer owning face H; else planar gray map. */
  const mapCamSelectionToProj = useCallback(
    (corners: { x: number; y: number }[]) => {
      const applyOffset = (pts: { x: number; y: number }[]) =>
        pts.map((p) => ({
          x: Math.max(0.002, Math.min(0.998, p.x + offsetRef.current.x)),
          y: Math.max(0.002, Math.min(0.998, p.y + offsetRef.current.y)),
        }))
      const areaOk = (pts: { x: number; y: number }[]) => {
        if (pts.length < 3) return false
        let a = 0
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]
          const q = pts[(i + 1) % pts.length]
          a += p.x * q.y - q.x * p.y
        }
        return Math.abs(a) * 0.5 > 1e-5
      }

      const faceList = facesRef.current
      if (faceList.length > 0) {
        const face = findFaceForPolygon(faceList, corners)
        if (face) {
          const faceMap =
            grayMapsRef.current[face.projectorIndex] ?? grayMapRef.current
          const mapped =
            mapPolygonThroughFace(face, corners, faceMap) ??
            (faceMap ? mapPolygonPointwiseThroughGray(corners, faceMap) : null)
          if (mapped && mapped.length >= 3 && areaOk(mapped)) {
            return applyOffset(mapped)
          }
        }
      }
      const maps = [...grayMapsRef.current, grayMapRef.current]
      const map = pickBestGrayMap(corners, maps)
      if (map && map.valid >= 50) {
        const mapped = mapRegionThroughGray(corners, map)
        if (mapped && mapped.length >= 3 && areaOk(mapped)) {
          return applyOffset(mapped)
        }
      }
      return cameraCornersToProjector(corners, alignRef.current, offsetRef.current)
    },
    [],
  )

  const isCollapsedQuad = (corners: { x: number; y: number }[]) => {
    if (corners.length !== 4) return false
    const a =
      Math.abs(
        (corners[1].x - corners[0].x) * (corners[2].y - corners[0].y) -
          (corners[2].x - corners[0].x) * (corners[1].y - corners[0].y),
      ) * 0.5
    const b =
      Math.abs(
        (corners[2].x - corners[0].x) * (corners[3].y - corners[0].y) -
          (corners[3].x - corners[0].x) * (corners[2].y - corners[0].y),
      ) * 0.5
    return a < 0.00012 || b < 0.00012
  }

  /** Map camera region through one projector's map (intersection with that beam only). */
  const mapCamToProjectorIndex = useCallback(
    (corners: { x: number; y: number }[], projIndex: number) => {
      const applyOffset = (pts: { x: number; y: number }[]) =>
        pts.map((p) => ({
          x: Math.max(0.002, Math.min(0.998, p.x + offsetRef.current.x)),
          y: Math.max(0.002, Math.min(0.998, p.y + offsetRef.current.y)),
        }))

      const faceList = facesRef.current
      if (faceList.length > 0) {
        const face = findFaceForPolygon(faceList, corners)
        if (face) {
          if (face.projectorIndex === projIndex) {
            const faceMap = grayMapsRef.current[projIndex] ?? grayMapRef.current
            const mapped =
              mapPolygonThroughFace(face, corners, faceMap) ??
              (faceMap ? mapPolygonPointwiseThroughGray(corners, faceMap) : null)
            if (mapped && mapped.length >= 3) return applyOffset(mapped)
            // Face fit weak — fall through to this beam's gray map
          } else {
            // Owned by another beam: keep this projector blank for soft-edge
            return []
          }
        }
      }
      const map = grayMapsRef.current[projIndex]
      if (!map || map.valid < 50) {
        // Single-beam setups often only populate grayMapRef — use it when indices match
        const fallback = grayMapRef.current
        if (fallback && fallback.valid >= 50 && grayMapsRef.current.every((m) => !m)) {
          const mapped = mapRegionThroughGray(corners, fallback)
          if (mapped && mapped.length >= 3) return applyOffset(mapped)
        }
        return []
      }
      const clipped = clipPolygonToGrayFootprint(corners, map) ?? corners
      const mapped = mapRegionThroughGray(clipped, map)
      if (mapped && mapped.length >= 3) {
        return applyOffset(mapped)
      }
      const mappedFull = mapRegionThroughGray(corners, map)
      if (mappedFull && mappedFull.length >= 3) {
        return applyOffset(mappedFull)
      }
      return []
    },
    [],
  )

  const contentPayloadFor = useCallback(
    (mediaId: string | null | undefined, hint?: MediaItem | null) => {
      const item =
        (hint && (!mediaId || hint.id === mediaId) ? hint : null) ??
        (mediaId ? media.find((m) => m.id === mediaId) : null) ??
        media.find((m) => m.id === 'test-white-solid') ??
        media.find((m) => m.recipe?.mode === 'white') ??
        media[0]
      if (!item) {
        return {
          type: 'ai' as const,
          url: '',
          recipe: {
            palette: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
            mode: 'white' as const,
            speed: 1,
            density: 1,
            seed: 1,
          },
          name: 'White',
        }
      }
      return {
        type: item.type,
        url: item.url,
        recipe: item.recipe ?? null,
        name: item.name,
      }
    },
    [media],
  )

  const contentPayloadForManual = useCallback(
    (displayId: number, mediaId?: string | null, hint?: MediaItem | null) => {
      const manualMedia = manualMediaByDisplayId[displayId] ?? []
      const selectedMediaId = selectedManualMediaByDisplayId[displayId] ?? null
      const item =
        (hint && (!mediaId || hint.id === mediaId) ? hint : null) ??
        (mediaId ? manualMedia.find((m) => m.id === mediaId) : null) ??
        (selectedMediaId ? manualMedia.find((m) => m.id === selectedMediaId) : null) ??
        manualMedia.find((m) => m.id === 'test-white-solid') ??
        manualMedia.find((m) => m.recipe?.mode === 'white') ??
        manualMedia[0]
      if (!item) {
        return {
          type: 'ai' as const,
          url: '',
          recipe: {
            palette: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
            mode: 'white' as const,
            speed: 1,
            density: 1,
            seed: 1,
          },
          name: 'White',
        }
      }
      return {
        type: item.type,
        url: item.url,
        recipe: item.recipe ?? null,
        name: item.name,
      }
    },
    [manualMediaByDisplayId, selectedManualMediaByDisplayId],
  )

  /** Open camera-mode projector indices (ignores active-camera filter). */
  const openCameraProjectorIndices = useCallback(() => {
    const targets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
    const indices: number[] = []
    targets.forEach((d, i) => {
      if (!activeProjectorIds.has(d.id)) return
      if ((projectorModeByDisplayId[d.id] ?? 'camera') !== 'camera') return
      indices.push(i)
    })
    return indices
  }, [projectors, displays, activeProjectorIds, projectorModeByDisplayId])

  /** Live logical projector indices for the active camera workspace. */
  const liveProjectorIndices = useCallback(() => {
    const all = openCameraProjectorIndices()
    if (!activeCameraControlDisplayId) return all
    const targets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
    const filtered = all.filter((i) => targets[i]?.id === activeCameraControlDisplayId)
    // Prefer the active camera display, but never return empty when other camera projectors are open.
    return filtered.length > 0 ? filtered : all
  }, [
    openCameraProjectorIndices,
    activeCameraControlDisplayId,
    projectors,
    displays,
  ])

  /** Any open projector indices that can receive content (camera first, then all open). */
  const contentReceiverIndices = useCallback(() => {
    let indices = liveProjectorIndices()
    if (indices.length > 0) return indices
    indices = openCameraProjectorIndices()
    if (indices.length > 0) return indices
    const targets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
    const fallback: number[] = []
    targets.forEach((d, i) => {
      if (activeProjectorIds.has(d.id)) fallback.push(i)
    })
    return fallback
  }, [
    liveProjectorIndices,
    openCameraProjectorIndices,
    projectors,
    displays,
    activeProjectorIds,
  ])

  const manualProjectorEntries = useCallback(() => {
    const targets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
    return targets
      .map((d, i) => ({ display: d, index: i }))
      .filter(
        (x) =>
          activeProjectorIds.has(x.display.id) &&
          (projectorModeByDisplayId[x.display.id] ?? 'camera') === 'manual',
      )
  }, [projectors, displays, activeProjectorIds, projectorModeByDisplayId])

  const projectManualQuadToProjector = useCallback(
    async (displayId: number, mediaHint?: MediaItem | null) => {
      if (!window.lumen) return { ok: false as const, error: 'No lumen API' }
      const projectorTargets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
      const index = projectorTargets.findIndex((d) => d.id === displayId)
      if (index < 0) return { ok: false as const, error: 'Display not found' }
      const display = projectorTargets[index]
      const calibrationCorners = manualCornersByDisplayId[displayId] ?? defaultManualCorners()
      const manualTargets = manualTargetsByDisplayId[displayId] ?? []
      const layers =
        manualTargets.length > 0
          ? manualTargets.map((t) => ({
              id: t.id,
              label: t.label,
              corners: t.corners,
              content: contentPayloadForManual(displayId, t.mediaId, mediaHint),
            }))
          : [
              {
                id: `manual-${displayId}`,
                label: `Manual ${friendlyProjectorName(display.label, index)}`,
                corners: calibrationCorners,
                content: contentPayloadForManual(displayId, mediaHint?.id ?? null, mediaHint),
              },
            ]
      const sent = await window.lumen.sendToProjector(index, 'projector:layers', { layers })
      await window.lumen.sendToProjector(index, 'projector:mode', { mode: 'content' })
      if (!sent || (sent as { ok?: boolean }).ok === false) {
        return { ok: false as const, error: 'Projector window not open' }
      }
      return { ok: true as const }
    },
    [
      projectors,
      displays,
      manualCornersByDisplayId,
      defaultManualCorners,
      manualTargetsByDisplayId,
      contentPayloadForManual,
      friendlyProjectorName,
    ],
  )

  /**
   * Push every target shape with its own content.
   * Dual: each projector gets the draw∩its-beam mapped through ITS gray map.
   * Optional mediaHint ensures a just-created item is used before React state flushes.
   */
  const broadcastAllLayers = useCallback(
    async (list?: DetectedSurface[], mediaHint?: MediaItem | null) => {
      if (!window.lumen) return { ok: false as const, sent: 0, error: 'No lumen API' }
      const targets = (list ?? surfaces).filter((s) => s.label !== 'Beam outline')
      const indices = contentReceiverIndices()
      if (indices.length === 0) {
        console.warn('[broadcast] no open projectors to receive layers')
        return { ok: false as const, sent: 0, error: 'No open projector to receive content' }
      }

      let sent = 0
      if (indices.length === 1) {
        const layers = targets.map((s) => {
          let corners = refinedProjRef.current[s.id]
          // Keep locked warps — never remap a neighbor just because another shape was drawn
          const needsRemap =
            !corners ||
            corners.length < 3 ||
            (s.corners.length === 4 &&
              corners.length === 4 &&
              isCollapsedQuad(corners))
          if (needsRemap) {
            corners = mapCamSelectionToProj(s.corners)
            if (corners.length >= 3) refinedProjRef.current[s.id] = corners
          }
          return {
            id: s.id,
            label: s.label,
            corners: corners && corners.length >= 3 ? corners : mapCamSelectionToProj(s.corners),
            content: contentPayloadFor(s.mediaId, mediaHint),
          }
        })
        const r = await window.lumen.sendToProjector(indices[0], 'projector:layers', { layers })
        await window.lumen.sendToProjector(indices[0], 'projector:mode', { mode: 'content' })
        if (r && (r as { ok?: boolean }).ok !== false) sent = 1
        return sent > 0
          ? { ok: true as const, sent }
          : { ok: false as const, sent: 0, error: 'Projector window not open' }
      }

      // Dual+: reuse per-beam caches; only map shapes that are missing (don't wipe neighbors)
      for (const i of indices) {
        const layers = targets.map((s) => {
          const key = `${s.id}::${i}`
          let corners = refinedProjRef.current[key]
          if (!corners || corners.length < 3) {
            corners = mapCamToProjectorIndex(s.corners, i)
            if (corners.length >= 3) refinedProjRef.current[key] = corners
          }
          return {
            id: s.id,
            label: s.label,
            corners: corners ?? [],
            content: contentPayloadFor(s.mediaId, mediaHint),
          }
        })
        const r = await window.lumen.sendToProjector(i, 'projector:layers', { layers })
        await window.lumen.sendToProjector(i, 'projector:mode', { mode: 'content' })
        if (r && (r as { ok?: boolean }).ok !== false) sent++
      }
      return sent > 0
        ? { ok: true as const, sent }
        : { ok: false as const, sent: 0, error: 'Projector window not open' }
    },
    [
      surfaces,
      mapCamSelectionToProj,
      mapCamToProjectorIndex,
      contentPayloadFor,
      contentReceiverIndices,
    ],
  )

  const broadcastSurfaceWarp = useCallback(
    async (surface: DetectedSurface, openIds?: Set<number>) => {
      if (!window.lumen) return
      const active = openIds ?? activeProjectorIds
      const projCorners =
        refinedProjRef.current[surface.id] ?? mapCamSelectionToProj(surface.corners)
      refinedProjRef.current[surface.id] = projCorners

      const payload = {
        projectorIndex: 0,
        label: surface.label,
        corners: projCorners,
        ...surfaceToHomography(projCorners, 1920, 1080),
      }

      await window.lumen.broadcast('projector:surface', payload)

      for (let i = 0; i < projectors.length; i++) {
        const d = projectors[i]
        if (!active.has(d.id)) continue
        const { homography, inverseHomography } = surfaceToHomography(
          projCorners,
          d.size.width,
          d.size.height,
        )
        await window.lumen.sendToProjector(i, 'projector:surface', {
          projectorIndex: i,
          label: surface.label,
          corners: projCorners,
          homography,
          inverseHomography,
        })
      }
    },
    [projectors, activeProjectorIds, mapCamSelectionToProj],
  )

  // Live-update all layers while user drags corners or nudges
  useEffect(() => {
    const surface = surfaces.find((s) => s.id === selectedSurfaceId)
    if (!surface || surface.label === 'Beam outline') return
    if (!alignRef.current && !grayMapRef.current && !grayMapsRef.current.some((m) => m && m.valid >= 50))
      return
    if (activeProjectorIds.size === 0 && projectors.length > 0) return
    const t = window.setTimeout(() => {
      void broadcastAllLayers()
    }, 60)
    return () => clearTimeout(t)
  }, [
    surfaces,
    selectedSurfaceId,
    activeProjectorIds,
    broadcastAllLayers,
    align,
    projOffset,
    projectors.length,
  ])

  // Independent manual projector path (no camera): update live as corners/content change.
  useEffect(() => {
    const entries = manualProjectorEntries()
    if (!entries.length) return
    for (const e of entries) {
      void projectManualQuadToProjector(e.display.id)
    }
  }, [manualProjectorEntries, projectManualQuadToProjector])

  const ensureProjectorsOpen = async () => {
    const targets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
    if (targets.length === 0) throw new Error('No displays found.')
    const opened = new Set(activeProjectorIds)
    for (let i = 0; i < targets.length; i++) {
      if (!opened.has(targets[i].id)) {
        await openProjector(targets[i], i)
        opened.add(targets[i].id)
      }
    }
    if (projectors.length === 0) {
      pushToast('info', 'No extended projector — opened a TEST window on this PC')
      pushEvent('warn', 'Windows Extend not detected. Using a test window. Drag it / check the wall.')
    }
    return opened
  }

  /** Step 1 that must work: solid white, no warp, no camera math. */
  const flashFullWhite = async () => {
    setSurfaceError(null)
    try {
      await ensureProjectorsOpen()
      await window.lumen.broadcast('projector:mode', { mode: 'white' })
      pushToast('connect', 'FULL WHITE sent — look at the projector / test window')
      pushEvent('info', 'Full white (no mapping). If the wall is white, the link works.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed'
      setSurfaceError(msg)
      pushEvent('danger', msg)
    }
  }

  /** Project a white patch already in projector-normalized coords. */
  const projectRawProjectorQuad = async (projCorners: Quad, label: string, openIds?: Set<number>) => {
    const active = openIds ?? activeProjectorIds
    const sane = projCorners.map((p) => ({
      x: Math.max(0.01, Math.min(0.99, p.x)),
      y: Math.max(0.01, Math.min(0.99, p.y)),
    })) as Quad
    const payload = {
      projectorIndex: 0,
      label,
      corners: sane,
      ...surfaceToHomography(sane, 1920, 1080),
    }
    await window.lumen.broadcast('projector:surface', payload)
    for (let i = 0; i < projectors.length; i++) {
      const d = projectors[i]
      if (!active.has(d.id)) continue
      await window.lumen.sendToProjector(i, 'projector:surface', {
        projectorIndex: i,
        label,
        corners: sane,
        ...surfaceToHomography(sane, d.size.width, d.size.height),
      })
    }
    await window.lumen.broadcast('projector:content', {
      type: 'ai',
      url: '',
      recipe: {
        palette: ['#ffffff', '#ffffff', '#ffffff', '#ffffff'],
        mode: 'white',
        speed: 1,
        density: 1,
        seed: 1,
      },
      name: label,
    })
    await new Promise((r) => setTimeout(r, 30))
    await window.lumen.broadcast('projector:mode', { mode: 'content' })
  }

  const runAlign = async (opened?: Set<number>, targetDisplayId?: number | null) => {
    setAligning(true)
    setSurfaceError(null)
    setAlignProgress('Starting…')
    setAlign(null)
    alignRef.current = null
    refinedProjRef.current = {}
    grayMapRef.current = null
    grayMapsRef.current = []
    setFaces([])
    setHasGrayMap(false)
    setFootprint(null)
    setCalibDots([])
    setCalibExpect(null)
    setSurfaces([])
    setSelectedSurfaceId(null)
    setProjOffset({ x: 0, y: 0 })
    offsetRef.current = { x: 0, y: 0 }
    setClickCorners([])
    blackFrameRef.current = null
    whiteFrameRef.current = null
    try {
      const s = await camera.start(camera.selectedId ?? undefined)
      if (!s) {
        throw new Error(
          camera.error ||
            'Could not open camera. Windows → Settings → Privacy → Camera → allow desktop apps.',
        )
      }

      const openSet = opened ?? (await ensureProjectorsOpen())
      const video = videoRef.current
      if (!video) throw new Error('Camera preview missing')
      video.srcObject = s
      await video.play().catch(() => {})
      for (let i = 0; i < 40 && !video.videoWidth; i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (!video.videoWidth) throw new Error('Camera has no image yet — wait a second and retry')

      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

      // Live projector indices (logical 0 = left, 1 = right, …)
      const liveIndices: number[] = []
      const targets = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
      targets.forEach((d, i) => {
        if (!openSet.has(d.id)) return
        if ((projectorModeByDisplayId[d.id] ?? 'camera') !== 'camera') return
        if (targetDisplayId && d.id !== targetDisplayId) return
        liveIndices.push(i)
      })
      if (liveIndices.length === 0) {
        throw new Error('No camera-calibration projector open')
      }

      const blackAll = async () => {
        for (const i of liveIndices) {
          await window.lumen.sendToProjector(i, 'projector:mode', { mode: 'black' })
        }
      }

      const showGrayOn = async (
        projIndex: number,
        payload:
          | { kind: 'black' }
          | { kind: 'white' }
          | { kind: 'pattern'; axis: 'x' | 'y'; bit: number; invert: boolean },
        patternW: number,
        patternH: number,
      ) => {
        for (const i of liveIndices) {
          if (i !== projIndex) {
            await window.lumen.sendToProjector(i, 'projector:mode', { mode: 'black' })
          }
        }
        const msg = { ...payload, patternW, patternH, projectorIndex: projIndex }
        await window.lumen.sendToProjector(projIndex, 'projector:graycode', msg)
        await window.lumen.sendToProjector(projIndex, 'projector:mode', { mode: 'graycode' })
      }

      const maps: (CamToProjMap | null)[] = []
      const footprints: (ReturnType<typeof footprintFromGrayMap>)[] = []
      let totalValid = 0

      const settle = liveIndices.length > 1 ? 650 : 480
      const settleBit = liveIndices.length > 1 ? 480 : 400

      for (let pi = 0; pi < liveIndices.length; pi++) {
        const projIndex = liveIndices[pi]
        const projDisplay = targets[projIndex]
        const dw = projDisplay?.size.width || 1920
        const dh = projDisplay?.size.height || 1080
        // Higher pattern res is noisier; 512 = reliable bits + sharp enough for objects
        const projW = 512
        const projH = Math.max(288, Math.min(512, Math.round((512 * dh) / dw)))
        const steps = buildPatternSequence(projW, projH)
        const captures = new Map<string, ImageData>()
        const total = steps.length + 2
        const name = friendlyProjectorName(projDisplay?.label, projIndex)
        const label =
          liveIndices.length > 1
            ? `${name} (${dw}×${dh})`
            : ''

        const grab = () => captureAveragedFrame(video, 3, 35)

        setAlignProgress(
          liveIndices.length > 1
            ? `${label} · Black…`
            : `1/${total} Black…`,
        )
        await blackAll()
        await wait(liveIndices.length > 1 ? 450 : 300)
        await showGrayOn(projIndex, { kind: 'black' }, projW, projH)
        await wait(settle)
        const black = await grab()
        if (pi === 0) blackFrameRef.current = black

        setAlignProgress(
          liveIndices.length > 1 ? `${label} · White…` : `2/${total} White…`,
        )
        await showGrayOn(projIndex, { kind: 'white' }, projW, projH)
        await wait(settle + 250)
        const white = await grab()
        if (pi === 0) whiteFrameRef.current = white

        for (let si = 0; si < steps.length; si++) {
          const step = steps[si]
          setAlignProgress(
            liveIndices.length > 1
              ? `${label} · ${step.axis.toUpperCase()} bit ${step.bit}${step.invert ? 'i' : ''}…`
              : `${si + 3}/${total} Mapping ${step.axis.toUpperCase()} bit ${step.bit}${step.invert ? 'i' : ''}…`,
          )
          await showGrayOn(
            projIndex,
            {
              kind: 'pattern',
              axis: step.axis,
              bit: step.bit,
              invert: step.invert,
            },
            projW,
            projH,
          )
          await wait(settleBit)
          await grab() // discard first after AE
          await wait(50)
          captures.set(step.key, await grab())
        }

        setAlignProgress(
          liveIndices.length > 1 ? `${label} · Decoding…` : 'Decoding map…',
        )
        const map = buildCamToProjMap(captures, projW, projH, 1)
        if (map.valid < 120) {
          throw new Error(
            liveIndices.length > 1
              ? `${name}: only ${map.valid} matches — dim room lights, set projector to native aspect (Acer: 4:3 / XGA), disable keystone, aim camera at that beam, retry.`
              : `Only ${map.valid} matches — dim the lights, aim Logitech at the projector beam, retry Auto-calibrate.`,
          )
        }
        while (maps.length <= projIndex) maps.push(null)
        maps[projIndex] = map
        totalValid += map.valid
        footprints.push(footprintFromGrayMap(map))
        pushEvent(
          'info',
          `Calibrated ${name}: ${map.valid} pts · desktop ${dw}×${dh} · pattern ${projW}×${projH}`,
        )
      }

      grayMapsRef.current = maps
      const primaryMap = maps.find((m) => m && m.valid >= 120) ?? null
      grayMapRef.current = primaryMap
      setHasGrayMap(!!primaryMap)

      const fpUnion = unionFootprints(footprints)
      if (!fpUnion || fpUnion.length < 3) {
        throw new Error('Could not find projector coverage in the camera. Aim at the lit wall and retry.')
      }
      const fpQuad = hullToAlignQuad(fpUnion)
      const result = alignFromFootprint(fpQuad)
      setAlign(result)
      alignRef.current = result
      refinedProjRef.current = {}
      setCalibDots([])
      setCalibExpect(null)
      setFootprint(fpUnion)
      setCalibStep('draw-target')
      setFaces([])
      // Default to outline first after calibration for a draw-first UX.
      setWorkMode('faces')
      setSurfaces([
        {
          id: `surf-beam-${Date.now()}`,
          label: 'Beam outline',
          corners: fpUnion,
          area: quadBounds(fpQuad).w * quadBounds(fpQuad).h,
          confidence: 1,
          source: 'auto',
        },
      ])
      setSelectedSurfaceId(null)

      await blackAll()
      const dualNote =
        liveIndices.length > 1
          ? ` Dual (mixed OK): ${liveIndices.length} projectors. If sides feel reversed use Edge blending → Swap left/right. Dim the brighter lamp with Left/Right gain.`
          : ''
      pushToast('connect', `Map ready (${totalValid} pts). Draw content — or outline Faces first.`)
      pushEvent(
        'info',
        `Gray-code locked ${totalValid} correspondences. Optional: Faces mode for per-surface maps.${dualNote}`,
      )
      return
    } catch (e) {
      // Fall through to probe fallback below if gray-code throws
      const msg = e instanceof Error ? e.message : 'Gray-code failed'
      pushEvent('warn', `${msg} — trying probe fallback…`)

      try {
        const video = videoRef.current
        if (!video?.videoWidth) throw new Error('No camera')
        const openSet = await ensureProjectorsOpen()
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

        setAlignProgress('Fallback probe…')
        await window.lumen.broadcast('projector:mode', { mode: 'black' })
        await wait(600)
        const black = captureFrame(video)
        blackFrameRef.current = black
        await projectRawProjectorQuad(PROBE_QUAD, 'Probe', openSet)
        await wait(850)
        const probeFrame = captureFrame(video)
        const probe = detectProbeBlob(black, probeFrame)
        const probeBox = probe.ok ? quadBounds(probe.quad) : null
        const probeSane =
          !!probeBox &&
          probeBox.w >= 0.08 &&
          probeBox.h >= 0.08 &&
          probeBox.w <= 0.72 &&
          probeBox.h <= 0.72

        if (probe.ok && probeSane) {
          const result = alignFromProbe(probe.quad, PROBE_QUAD)
          setAlign(result)
          alignRef.current = result
          setFootprint(probe.quad)
          setCalibStep('draw-target')
          setSurfaces([
            {
              id: `surf-beam-${Date.now()}`,
              label: 'Beam outline',
              corners: probe.quad,
              area: probeBox!.w * probeBox!.h,
              confidence: 1,
              source: 'auto',
            },
          ])
          await window.lumen.broadcast('projector:mode', { mode: 'black' })
          pushToast('connect', 'Probe fallback ready — draw inside yellow.')
          return
        }

        setFootprint(null)
        setCalibStep('outline-light')
        await window.lumen.broadcast('projector:mode', { mode: 'white' })
        pushToast('info', 'Drag ON the bright white beam only')
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : msg
        setSurfaceError(msg2)
        pushEvent('danger', msg2)
        pushToast('disconnect', msg2)
        setCalibStep('need-match')
        try {
          await window.lumen.broadcast('projector:mode', { mode: 'white' })
        } catch {
          /* ignore */
        }
      }
    } finally {
      setAligning(false)
      setAlignProgress(null)
    }
  }

  /** Commit beam outline only if it actually covers the lit projector area. */
  const finishBeamLock = async (camBlob: Quad) => {
    const b = quadBounds(camBlob)
    const area = b.w * b.h
    if (b.w < 0.1 || b.h < 0.08 || area < 0.03) {
      pushToast('disconnect', 'Too small — cover the WHOLE white beam')
      setCalibStep('outline-light')
      return
    }
    // Full-camera yellow = broken map (what you were seeing)
    if (b.w > 0.72 || b.h > 0.72 || area > 0.4) {
      pushToast('disconnect', 'Too big — outline ONLY the bright white, not the whole camera')
      setCalibStep('outline-light')
      await window.lumen.broadcast('projector:mode', { mode: 'white' })
      return
    }
    if (b.w / b.h > 3 || b.h / b.w > 3) {
      pushToast('disconnect', 'Too skinny — outline the whole white rectangle')
      setCalibStep('outline-light')
      return
    }

    const black = blackFrameRef.current
    const white = whiteFrameRef.current
    if (black && white) {
      const cover = litCoverageInsideQuad(black, white, camBlob)
      if (cover < 0.4) {
        const found = detectProjectorFootprint(black, white)
        if (found.ok && litCoverageInsideQuad(black, white, found.quad) >= 0.45) {
          // User missed — snap to real beam
          camBlob = found.quad
          pushEvent('warn', 'Your drag missed the white — snapped yellow onto the real beam.')
        } else {
          setFootprint(found.ok ? found.quad : camBlob)
          setCalibStep('outline-light')
          pushToast('disconnect', 'Yellow must cover the bright white. Drag on the WHITE.')
          await window.lumen.broadcast('projector:mode', { mode: 'white' })
          return
        }
      }
    }

    const result = alignFromFootprint(camBlob)
    setAlign(result)
    alignRef.current = result
    setFootprint(camBlob)
    setClickCorners([])
    setCalibStep('draw-target')

    const finalArea = quadBounds(camBlob).w * quadBounds(camBlob).h
    const beamSurf: DetectedSurface = {
      id: `surf-beam-${Date.now()}`,
      label: 'Beam outline',
      corners: camBlob,
      area: finalArea,
      confidence: 1,
      source: 'manual',
    }
    setSurfaces([beamSurf])
    setSelectedSurfaceId(null)

    // Black so you can see the room; yellow marks the beam
    await window.lumen.broadcast('projector:mode', { mode: 'black' })

    pushToast('connect', 'Ready — draw where you want light.')
    pushEvent('info', 'Beam locked. Draw on the camera; white stays on that spot.')
  }

  const lockProbeFromDrag = async (camBlob: Quad) => {
    setSurfaceError(null)
    try {
      await finishBeamLock(camBlob)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Lock failed'
      setSurfaceError(msg)
      pushEvent('danger', msg)
    }
  }

  /** Update projector shape only (no mode blink). */
  const pushProjectorCorners = async (
    surf: DetectedSurface,
    projCorners: { x: number; y: number }[],
    openIds?: Set<number>,
  ) => {
    if (!window.lumen) return
    const opened = openIds ?? activeProjectorIds
    refinedProjRef.current[surf.id] = projCorners
    const payload = {
      projectorIndex: 0,
      label: surf.label,
      corners: projCorners,
      ...surfaceToHomography(projCorners, 1920, 1080),
    }
    await window.lumen.broadcast('projector:surface', payload)
    for (let i = 0; i < projectors.length; i++) {
      const d = projectors[i]
      if (!opened.has(d.id)) continue
      await window.lumen.sendToProjector(i, 'projector:surface', {
        projectorIndex: i,
        label: surf.label,
        corners: projCorners,
        ...surfaceToHomography(projCorners, d.size.width, d.size.height),
      })
    }
  }

  /** Project content for one surface, then refresh all layers. */
  const projectWhiteOn = async (
    surf: DetectedSurface,
    openIds?: Set<number>,
    cornersOverride?: { x: number; y: number }[],
  ) => {
    const opened = openIds ?? (await ensureProjectorsOpen())
    const projCorners =
      cornersOverride ??
      refinedProjRef.current[surf.id] ??
      mapCamSelectionToProj(surf.corners)
    refinedProjRef.current[surf.id] = projCorners
    void opened
    await broadcastAllLayers()
  }

  /**
   * Make wall white match the camera draw (fallback when no gray map).
   * Only nudges THIS shape's warp — never remaps neighbors.
   */
  const snapOnceToDraw = async (surf: DetectedSurface, list?: DetectedSurface[]) => {
    const video = videoRef.current
    const alignNow = alignRef.current
    const black = blackFrameRef.current
    if (!video?.videoWidth || !alignNow || !black) return

    const expect = quadBounds(surf.corners)
    let proj =
      refinedProjRef.current[surf.id] ?? mapCamSelectionToProj(surf.corners)
    const fullList = list ?? surfaces

    for (let iter = 0; iter < 5; iter++) {
      refinedProjRef.current[surf.id] = proj
      // Broadcast all layers (keeps neighbors) — do not use single-surface IPC
      await broadcastAllLayers(fullList)
      await new Promise((r) => setTimeout(r, 320))
      const frame = captureFrame(video)
      let seen = detectLitBounds(black, frame, {
        cx: expect.cx,
        cy: expect.cy,
        radius: 0.14 + iter * 0.04,
      })
      if (!seen.ok) break

      const miss = Math.hypot(expect.cx - seen.cx, expect.cy - seen.cy)
      const scaleX = expect.w / Math.max(seen.w, 0.008)
      const scaleY = expect.h / Math.max(seen.h, 0.008)
      const sizeOk = Math.abs(scaleX - 1) < 0.06 && Math.abs(scaleY - 1) < 0.06

      if (miss < 0.01 && sizeOk) break
      if (miss > 0.4 && iter > 1) break

      const pSeen = applyHomography(alignNow.camToProj, { x: seen.cx, y: seen.cy })
      const pWant = applyHomography(alignNow.camToProj, { x: expect.cx, y: expect.cy })
      const dx = Math.max(-0.18, Math.min(0.18, pWant.x - pSeen.x))
      const dy = Math.max(-0.18, Math.min(0.18, pWant.y - pSeen.y))
      const sx = Math.max(0.72, Math.min(1.45, 1 + (scaleX - 1) * 0.85))
      const sy = Math.max(0.72, Math.min(1.45, 1 + (scaleY - 1) * 0.85))
      const pb = quadBounds(proj)
      proj = proj.map((p) => ({
        x: Math.max(0.002, Math.min(0.998, pb.cx + (p.x - pb.cx) * sx + dx)),
        y: Math.max(0.002, Math.min(0.998, pb.cy + (p.y - pb.cy) * sy + dy)),
      }))
    }

    refinedProjRef.current[surf.id] = proj
    await broadcastAllLayers(fullList)
  }

  const scanScene = async () => {
    setSurfaceError(null)
    setScanning(true)
    try {
      if (!camera.stream) {
        const s = await camera.start()
        if (!s) throw new Error('Could not open Logitech / USB camera')
      }
      if (camera.selected?.isBuiltin) {
        throw new Error('Select your Logitech USB camera — not the laptop webcam.')
      }
      const video = videoRef.current
      if (video) {
        video.srcObject = camera.stream ?? video.srcObject
        await video.play().catch(() => {})
        for (let i = 0; i < 20 && !video.videoWidth; i++) {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      await new Promise((r) => setTimeout(r, 150))

      let surfacesFound: DetectedSurface[] = []
      try {
        if (videoRef.current?.videoWidth) {
          await loadOpenCV()
          const frame = captureFrame(videoRef.current)
          const ocv = await opencvScanSurfaces(frame)
          surfacesFound = ocv.map((s) => ({
            id: `surf-ocv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            label: s.label,
            corners: s.corners,
            area: s.confidence,
            confidence: s.confidence,
            source: 'auto' as const,
          }))
        }
      } catch {
        /* fall through */
      }
      if (!surfacesFound.length) {
        surfacesFound = videoRef.current
          ? detectSurfacesFromVideo(videoRef.current)
          : presetSurfaces()
      }
      if (!surfacesFound.length) surfacesFound = presetSurfaces()

      setSurfaces(surfacesFound)
      setSelectedSurfaceId(surfacesFound[0].id)
      pushEvent('info', `OpenCV scan — ${surfacesFound.length} areas. Click the camera to pick exactly where.`)
      pushToast('info', 'Click the surface you want, or pick from the list')
    } catch (e) {
      const fallback = presetSurfaces()
      setSurfaces(fallback)
      setSelectedSurfaceId(fallback[0].id)
      setSurfaceError(null)
      pushEvent('warn', e instanceof Error ? e.message : 'Using default areas')
      pushToast('info', 'Using default areas — click or drag to fit')
    } finally {
      setScanning(false)
    }
  }

  /** First drag after Match = outline beam. Later = target rect or polygon. */
  const projectDrawnRect = async (corners: { x: number; y: number }[], label: string) => {
    setSurfaceError(null)
    try {
      if (calibStepRef.current === 'need-match') {
        pushToast('info', 'Click Match beam first')
        return
      }

      if (calibStepRef.current === 'outline-light') {
        if (corners.length < 4) {
          pushToast('info', 'Outline the beam with a rectangle drag')
          return
        }
        await lockProbeFromDrag(corners as Quad)
        return
      }

      if (
        !alignRef.current &&
        !grayMapRef.current &&
        !grayMapsRef.current.some((m) => m && m.valid >= 50)
      ) {
        pushToast('info', 'Run Auto-calibrate first')
        return
      }
      if (
        !(grayMapRef.current && grayMapRef.current.valid >= 80) &&
        !grayMapsRef.current.some((m) => m && m.valid >= 80)
      ) {
        const markers = alignRef.current?.camMarkers
        if (markers && markers.length >= 4) {
          const b = quadBounds(markers as Quad)
          if (b.w > 0.72 || b.h > 0.72 || b.w * b.h > 0.4) {
            pushToast('disconnect', 'Yellow is the whole camera — Auto-calibrate again')
            pushEvent('danger', 'Bad lock (full-frame). Recalibrate so yellow sits on the white beam only.')
            setCalibStep('need-match')
            return
          }
        }
      }
      if (corners.length < 3) {
        pushToast('info', 'Need at least 3 points for a shape')
        return
      }

      const opened = await ensureProjectorsOpen()
      const xs = corners.map((c) => c.x)
      const ys = corners.map((c) => c.y)
      const existingTargets = surfaces.filter((s) => s.label !== 'Beam outline')
      const n = existingTargets.length + 1
      const baseName =
        label === 'Beam outline'
          ? 'Beam outline'
          : label.replace(/\s+\d+$/, '').trim() || 'Target'
      const surf: DetectedSurface = {
        id: `surf-draw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: baseName === 'Beam outline' ? baseName : `${baseName} ${n}`,
        corners,
        area: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)),
        confidence: 1,
        source: 'manual',
        mediaId:
          selectedMediaId ??
          media.find((m) => m.id === 'test-white-solid')?.id ??
          media[0]?.id ??
          null,
      }
      const nextList = (() => {
        const beam = surfaces.filter((s) => s.label === 'Beam outline')
        return [...beam, ...existingTargets, surf]
      })()
      setSurfaces(nextList)
      setSelectedSurfaceId(surf.id)
      clearRefinedForSurface(surf.id)
      // Don't reset global offset — other targets keep their nudge

      await ensureProjectorsOpen()
      void opened
      // Fresh planar remap for this draw (drop any stale dense silhouette)
      refinedProjRef.current[surf.id] = mapCamSelectionToProj(surf.corners)
      const hasMap =
        (grayMapRef.current && grayMapRef.current.valid >= 80) ||
        grayMapsRef.current.some((m) => m && m.valid >= 80)
      if (!hasMap) {
        pushToast('info', 'Aligning…')
        await projectWhiteOn(surf)
        // Snap only this shape; pass full list so neighbors stay on screen
        await snapOnceToDraw(surf, nextList)
      } else {
        await broadcastAllLayers(nextList)
      }
      pushToast('connect', `${surf.label} added — assign content from the Content panel`)
      pushEvent('info', `Draw more shapes anytime. Each can play different content.`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not project'
      setSurfaceError(msg)
      pushEvent('danger', msg)
      try {
        await window.lumen.broadcast('projector:mode', { mode: 'white' })
      } catch {
        /* ignore */
      }
    }
  }

  /** Optional: 4-click corners of the white probe. */
  const onProbeCornerClick = async (norm: { x: number; y: number }) => {
    if (calibStepRef.current !== 'outline-light') return
    const next = [...clickCorners, norm]
    setClickCorners(next)
    if (next.length < 4) {
      pushToast('info', `Corner ${next.length}/4 — keep clicking around the white`)
      return
    }
    await lockProbeFromDrag(next as Quad)
  }

  const applySurface = async () => {
    setSurfaceError(null)
    try {
      if (
        !alignRef.current &&
        !grayMapRef.current &&
        !grayMapsRef.current.some((m) => m && m.valid >= 50)
      ) {
        pushToast('info', 'Run Auto-calibrate first')
        return
      }
      await broadcastAllLayers()
      pushToast('info', 'All targets re-projected')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not project'
      setSurfaceError(msg)
      pushEvent('danger', msg)
    }
  }

  const showPattern = async () => {
    if (!window.lumen) return
    if (activeProjectorIds.size === 0 && projectors[0]) {
      await openProjector(projectors[0], 0)
    }
    await window.lumen.broadcast('projector:mode', { mode: 'markers' })
    pushEvent('info', 'Calibration markers projected')
  }

  const runCalibration = async () => {
    setCalError(null)
    setCalStatus('running')
    setCalProgress({ step: 'warmup', progress: 0.05, message: 'Preparing…' })

    try {
      if (!camera.stream) {
        const s = await camera.start()
        if (!s) throw new Error('Could not open Logitech / USB camera')
      }
      if (camera.selected?.isBuiltin) {
        throw new Error('Please select your Logitech USB camera — laptop webcam is not used for calibration.')
      }
      if (projectors.length === 0) {
        throw new Error('No projector display detected. Connect a projector and extend your desktop.')
      }

      const opened = new Set(activeProjectorIds)
      for (let i = 0; i < projectors.length; i++) {
        if (!opened.has(projectors[i].id)) {
          await openProjector(projectors[i], i)
          opened.add(projectors[i].id)
        }
      }

      await window.lumen.broadcast('projector:mode', { mode: 'markers' })
      setCalProgress({ step: 'pattern', progress: 0.2, message: 'Projecting markers…' })
      await new Promise((r) => setTimeout(r, 700))

      const video = videoRef.current
      if (!video) throw new Error('Camera preview not ready')

      const results: CalibrationResult[] = []
      const targets = projectors.filter((d) => opened.has(d.id))

      for (let i = 0; i < targets.length; i++) {
        const d = targets[i]
        await window.lumen.sendToProjector(i, 'projector:mode', { mode: 'markers' })
        if (targets.length > 1) {
          for (let j = 0; j < targets.length; j++) {
            if (j !== i) await window.lumen.sendToProjector(j, 'projector:mode', { mode: 'black' })
          }
          await new Promise((r) => setTimeout(r, 400))
        }

        const result = await runAutoCalibration({
          video,
          projectorIndex: i,
          projectorWidth: d.size.width,
          projectorHeight: d.size.height,
          onProgress: setCalProgress,
        })
        results.push(result)
        await window.lumen.sendToProjector(i, 'projector:calibration', result)
      }

      setCalResults(results)
      setCalStatus('done')
      pushEvent('info', `Auto calibration complete for ${results.length} projector(s)`)
      pushToast('info', 'Auto calibration complete')
      await window.lumen.broadcast('projector:mode', { mode: 'content' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Calibration failed'
      setCalError(msg)
      setCalStatus('error')
      pushEvent('danger', msg)
    }
  }

  const projectSelected = async () => {
    const item = media.find((m) => m.id === selectedMediaId)
    if (!item || !window.lumen) return
    if (
      item.type === 'video' &&
      !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/m\//i.test(item.url || '')
    ) {
      pushToast(
        'info',
        'This video is not on the local media server (need http://127.0.0.1…/m/…). Re-upload after restart.',
      )
      pushEvent('warn', `Bad video URL: ${String(item.url || '').slice(0, 80)}`)
      return
    }
    try {
      await ensureProjectorsOpen()
    } catch (e) {
      pushEvent('danger', e instanceof Error ? e.message : 'No projector')
      pushToast('info', e instanceof Error ? e.message : 'No projector')
      return
    }
    const surface = surfaces.find((s) => s.id === selectedSurfaceId && s.label !== 'Beam outline')
    if (!surface) {
      pushToast('info', 'Select a target shape first, then Project')
      return
    }
    const updated = { ...surface, mediaId: item.id }
    const next = surfaces.map((s) => (s.id === updated.id ? updated : s))
    setSurfaces(next)
    const result = await broadcastAllLayers(next, item)
    if (!result.ok) {
      pushToast('info', result.error || 'Project failed — open a projector output first')
      pushEvent('danger', result.error || 'broadcast failed')
      return
    }
    pushEvent('info', `“${item.name}” → ${surface.label}`)
    pushToast('connect', `${item.name} on ${surface.label}`)
  }

  /** Assign a media item (possibly just created) onto the selected target and project. */
  const projectMediaOntoSelected = async (item: MediaItem) => {
    if (!window.lumen) return
    setMedia((prev) => (prev.some((m) => m.id === item.id) ? prev : [item, ...prev]))
    setSelectedMediaId(item.id)
    if (
      item.type === 'video' &&
      !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/m\//i.test(item.url || '')
    ) {
      pushToast(
        'info',
        'Video was saved but URL is not http://127.0.0.1…/m/… — cannot play on projector. Re-upload.',
      )
      pushEvent('warn', `Bad video URL: ${String(item.url || '').slice(0, 80)}`)
      return
    }
    try {
      await ensureProjectorsOpen()
    } catch (e) {
      pushEvent('danger', e instanceof Error ? e.message : 'No projector')
      pushToast('info', e instanceof Error ? e.message : 'No projector')
      return
    }
    const surface = surfaces.find((s) => s.id === selectedSurfaceId && s.label !== 'Beam outline')
    if (!surface) {
      pushToast('info', 'Select a target shape first')
      return
    }
    const updated = { ...surface, mediaId: item.id }
    const next = surfaces.map((s) => (s.id === updated.id ? updated : s))
    setSurfaces(next)
    // Pass item so recipe/url reach the projector before React media state flushes.
    const result = await broadcastAllLayers(next, item)
    if (!result.ok) {
      pushToast('info', result.error || 'Project failed — open a projector output first')
      pushEvent('danger', result.error || 'broadcast failed')
      return
    }
    pushEvent('info', `“${item.name}” → ${surface.label}`)
    pushToast('connect', `${item.name} on ${surface.label}`)
  }

  /** Remove user/AI media from the camera library and clear surface assignments. */
  const deleteMedia = (id: string) => {
    if (id.startsWith('test-white')) return
    setMedia((prev) => prev.filter((m) => m.id !== id))
    if (selectedMediaId === id) setSelectedMediaId(null)
    setSurfaces((prev) => {
      const next = prev.map((s) => (s.mediaId === id ? { ...s, mediaId: null } : s))
      void broadcastAllLayers(next)
      return next
    })
  }

  /** Remove media from a manual projector's library. */
  const deleteManualMedia = (displayId: number, id: string) => {
    if (id.startsWith('test-white')) return
    setManualMediaByDisplayId((prev) => {
      const cur = prev[displayId] ?? []
      return { ...prev, [displayId]: cur.filter((m) => m.id !== id) }
    })
    setSelectedManualMediaByDisplayId((prev) => ({
      ...prev,
      [displayId]: prev[displayId] === id ? null : prev[displayId],
    }))
    setManualTargetsByDisplayId((prev) => {
      const cur = prev[displayId] ?? []
      return {
        ...prev,
        [displayId]: cur.map((t) => (t.mediaId === id ? { ...t, mediaId: null } : t)),
      }
    })
    // After React applies the state updates above
    window.setTimeout(() => void projectManualQuadToProjector(displayId), 0)
  }

  const clearRefinedForSurface = (id: string) => {
    delete refinedProjRef.current[id]
    for (const k of Object.keys(refinedProjRef.current)) {
      if (k === id || k.startsWith(`${id}::`)) delete refinedProjRef.current[k]
    }
  }

  const nudgeRefinedKeys = (id: string, dx: number, dy: number) => {
    const keys = Object.keys(refinedProjRef.current).filter((k) => k === id || k.startsWith(`${id}::`))
    for (const k of keys) {
      refinedProjRef.current[k] = refinedProjRef.current[k].map((p) => ({
        x: Math.max(0.002, Math.min(0.998, p.x + dx)),
        y: Math.max(0.002, Math.min(0.998, p.y + dy)),
      }))
    }
  }

  const liveCount = activeProjectorIds.size
  const cameraLiveCount = liveProjectorIndices().length
  const manualEntriesNow = manualProjectorEntries()
  const cameraTargets = surfaces.filter((s) => s.label !== 'Beam outline')

  useEffect(() => {
    if (cameraTargets.length === 0) {
      if (selectedSurfaceId) setSelectedSurfaceId(null)
      return
    }
    if (!selectedSurfaceId || !cameraTargets.some((s) => s.id === selectedSurfaceId)) {
      setSelectedSurfaceId(cameraTargets[cameraTargets.length - 1].id)
    }
  }, [cameraTargets, selectedSurfaceId])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-name">Plug and Play</span>
          <span className="brand-tag">Auto projection mapping</span>
        </div>
        <div className="header-status">
          <span className={`status-dot ${liveCount > 0 || camera.stream ? 'live' : ''}`} />
          <span>
            Displays: {displayCount} · Cameras: {camera.cameras.length} · Audio:{' '}
            {audio.audioDevices.length}
            {liveCount > 0 ? ` · ${liveCount} live` : ''}
          </span>
          <span>
            Cam:{' '}
            {camera.selected?.isLogitech
              ? 'Logitech'
              : camera.selected && !camera.selected.isBuiltin
                ? 'USB'
                : camera.selected
                  ? 'built-in'
                  : 'none'}
          </span>
        </div>
      </header>

      <DevicePanel
        displays={displays}
        cameras={camera.cameras}
        audioDevices={audio.audioDevices}
        selectedCameraId={camera.selectedId}
        onSelectCamera={(id) => {
          camera.setSelectedId(id)
          camera.start(id)
        }}
        activeProjectorIds={activeProjectorIds}
        onOpenProjector={openProjector}
        onCloseProjector={closeProjector}
        events={events}
        cameraScanning={camera.scanning}
        onRefreshCameras={() => camera.refresh()}
        onRefreshAudio={() => audio.refresh()}
        audioScanning={audio.scanning}
        showVirtualCameras={camera.showVirtualCameras}
        onShowVirtualCamerasChange={camera.setShowVirtualCameras}
        showAllAudio={audio.showAllAudio}
        onShowAllAudioChange={audio.setShowAllAudio}
        cameraZoom={cameraZoom}
        onCameraZoom={setCameraZoom}
        projectorModeByDisplayId={projectorModeByDisplayId}
        onSetProjectorMode={(displayId, mode) => {
          setProjectorModeByDisplayId((prev) => ({ ...prev, [displayId]: mode }))
          if (mode === 'manual') {
            setManualCornersByDisplayId((prev) => ({
              ...prev,
              [displayId]: prev[displayId] ?? defaultManualCorners(),
            }))
            if (activeCameraControlDisplayId === displayId) {
              setActiveCameraControlDisplayId(null)
            }
          } else if (!activeCameraControlDisplayId) {
            setActiveCameraControlDisplayId(displayId)
          }
        }}
        activeCameraControlDisplayId={activeCameraControlDisplayId}
        onSetActiveCameraControlDisplayId={setActiveCameraControlDisplayId}
      />

      <main className="main-stage">
        <SurfaceMapPanel
          videoRef={videoRef}
          stream={camera.stream}
          cameraLabel={camera.selected?.label ?? null}
          surfaces={surfaces}
          selectedId={selectedSurfaceId}
          cameraZoom={cameraZoom}
          onSelect={(id) => {
            setSelectedSurfaceId(id)
          }}
          onChangeSurface={(updated) => {
            // Remap per projector on next broadcast (camera outline changed)
            clearRefinedForSurface(updated.id)
            setSurfaces((prevList) => prevList.map((s) => (s.id === updated.id ? updated : s)))
          }}
          onMoveProjCorner={(surfaceId, cornerIndex, delta) => {
            const indices = liveProjectorIndices()
            const applyDelta = (pts: { x: number; y: number }[]) => {
              // Dense 3D silhouettes have many pts — nudge the whole shape
              if (pts.length !== surfaces.find((s) => s.id === surfaceId)?.corners.length) {
                return pts.map((p) => ({
                  x: Math.max(0.002, Math.min(0.998, p.x + delta.x)),
                  y: Math.max(0.002, Math.min(0.998, p.y + delta.y)),
                }))
              }
              return pts.map((p, i) =>
                i === cornerIndex
                  ? {
                      x: Math.max(0.002, Math.min(0.998, p.x + delta.x)),
                      y: Math.max(0.002, Math.min(0.998, p.y + delta.y)),
                    }
                  : p,
              )
            }
            if (indices.length <= 1) {
              const pts = refinedProjRef.current[surfaceId]
              if (!pts || pts.length < 3) {
                const surf = surfaces.find((s) => s.id === surfaceId)
                if (!surf) return
                refinedProjRef.current[surfaceId] = mapCamSelectionToProj(surf.corners)
              }
              const cur = refinedProjRef.current[surfaceId]
              if (!cur || cur.length < 3) return
              refinedProjRef.current[surfaceId] = applyDelta(cur)
            } else {
              const surf = surfaces.find((s) => s.id === surfaceId)
              if (!surf) return
              for (const i of indices) {
                const key = `${surfaceId}::${i}`
                if (!refinedProjRef.current[key] || refinedProjRef.current[key].length < 3) {
                  const mapped = mapCamToProjectorIndex(surf.corners, i)
                  if (mapped.length >= 3) refinedProjRef.current[key] = mapped
                }
                const cur = refinedProjRef.current[key]
                if (!cur || cur.length < 3) continue
                refinedProjRef.current[key] = applyDelta(cur)
              }
            }
            setProjOffset((o) => ({ ...o }))
          }}
          onDeleteSurface={(id) => {
            clearRefinedForSurface(id)
            if (id.startsWith('surf-face-')) {
              const faceId = id.slice('surf-'.length)
              setFaces((prev) => prev.filter((f) => f.id !== faceId))
            }
            setSurfaces((prev) => {
              const next = prev.filter((s) => s.id !== id)
              void broadcastAllLayers(next)
              return next
            })
            if (selectedSurfaceId === id) setSelectedSurfaceId(null)
          }}
          onClearTargets={() => {
            const beam = surfaces.filter((s) => s.label === 'Beam outline')
            for (const s of surfaces) {
              if (s.label !== 'Beam outline') clearRefinedForSurface(s.id)
            }
            setSurfaces(beam)
            setFaces([])
            setSelectedSurfaceId(null)
            void broadcastAllLayers(beam)
            pushToast('info', 'Cleared all targets')
          }}
          mediaItems={media}
          onAssignMedia={(surfaceId, mediaId) => {
            const next = surfaces.map((s) =>
              s.id === surfaceId ? { ...s, mediaId } : s,
            )
            setSurfaces(next)
            void broadcastAllLayers(next)
          }}
          onDrawRect={(corners, label) => {
            void projectDrawnRect(corners, label)
          }}
          onScan={scanScene}
          onApply={applySurface}
          onAlign={() => {
            runAlign(undefined, activeCameraControlDisplayId).catch(() => {})
          }}
          onFlashWhite={flashFullWhite}
          aligning={aligning}
          aligned={!!align || hasGrayMap}
          calibStep={calibStep}
          clickCorners={clickCorners}
          onProbeCornerClick={(norm) => {
            void onProbeCornerClick(norm)
          }}
          projOffset={projOffset}
          onNudge={(dx, dy) => {
            const id = selectedSurfaceId
            if (id) nudgeRefinedKeys(id, dx, dy)
            setProjOffset((prev) => {
              const next = {
                x: Math.max(-0.45, Math.min(0.45, prev.x + dx)),
                y: Math.max(-0.45, Math.min(0.45, prev.y + dy)),
              }
              offsetRef.current = next
              return next
            })
          }}
          onResetNudge={() => {
            if (selectedSurfaceId) clearRefinedForSurface(selectedSurfaceId)
            offsetRef.current = { x: 0, y: 0 }
            setProjOffset({ x: 0, y: 0 })
          }}
          scanning={scanning}
          canApply={!!camera.selected && !camera.selected.isBuiltin}
          error={surfaceError || camera.error}
          alignProgress={alignProgress}
          footprint={footprint}
          calibDots={calibDots}
          calibExpect={calibExpect}
          workMode={workMode}
          onWorkMode={setWorkMode}
          faces={faces}
          onSaveFace={(outline, kind) => {
            const maps = [...grayMapsRef.current]
            if (grayMapRef.current && !maps.includes(grayMapRef.current)) {
              maps.push(grayMapRef.current)
            }
            const name = `Face ${faces.length + 1}`
            const face = buildFaceFromOutline(outline, maps, { name, kind })
            if (!face) {
              pushToast(
                'disconnect',
                'Not enough map samples inside that outline — redraw on the lit surface',
              )
              return
            }
            setFaces((prev) => [...prev, face])

            const faceMap =
              grayMapsRef.current[face.projectorIndex] ?? grayMapRef.current
            const projRaw =
              mapPolygonThroughFace(face, outline, faceMap) ??
              (faceMap ? mapPolygonPointwiseThroughGray(outline, faceMap) : null)
            const surfId = `surf-${face.id}`
            const xs = outline.map((c) => c.x)
            const ys = outline.map((c) => c.y)
            const surf: DetectedSurface = {
              id: surfId,
              label: face.name,
              corners: outline.map((p) => ({ x: p.x, y: p.y })),
              area:
                (Math.max(...xs) - Math.min(...xs)) *
                (Math.max(...ys) - Math.min(...ys)),
              confidence: 1,
              source: 'manual',
              mediaId:
                selectedMediaId ??
                media.find((m) => m.id === 'test-white-solid')?.id ??
                media.find((m) => m.recipe?.mode === 'white')?.id ??
                media[0]?.id ??
                null,
            }

            if (projRaw && projRaw.length >= 3) {
              refinedProjRef.current[surfId] = projRaw.map((p) => ({
                x: Math.max(0.002, Math.min(0.998, p.x + offsetRef.current.x)),
                y: Math.max(0.002, Math.min(0.998, p.y + offsetRef.current.y)),
              }))
            } else {
              refinedProjRef.current[surfId] = mapCamSelectionToProj(outline)
            }

            setSurfaces((prev) => {
              const beam = prev.filter((s) => s.label === 'Beam outline')
              const rest = prev.filter((s) => s.label !== 'Beam outline')
              return [...beam, ...rest, surf]
            })
            setSelectedSurfaceId(surfId)
            setWorkMode('content')

            pushToast(
              'connect',
              `${face.name} is lit — scroll to step 3 and generate a look onto it`,
            )
            pushEvent(
              'info',
              `Face "${face.name}" fitted (${face.sampleCount} pts) · target stays lit`,
            )

            void (async () => {
              try {
                await ensureProjectorsOpen()
                const nextList = [
                  ...surfaces.filter((s) => s.label === 'Beam outline'),
                  ...surfaces.filter((s) => s.label !== 'Beam outline'),
                  surf,
                ]
                await broadcastAllLayers(nextList)
              } catch {
                /* ignore */
              }
            })()
          }}
          onDeleteFace={(id) => {
            setFaces((prev) => prev.filter((f) => f.id !== id))
            const surfId = `surf-${id}`
            clearRefinedForSurface(surfId)
            setSurfaces((prev) => {
              const next = prev.filter((s) => s.id !== surfId)
              void broadcastAllLayers(next)
              return next
            })
            if (selectedSurfaceId === surfId) setSelectedSurfaceId(null)
          }}
          onRenameFace={(id, name) => {
            setFaces((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)))
            setSurfaces((prev) =>
              prev.map((s) => (s.id === `surf-${id}` ? { ...s, label: name } : s)),
            )
          }}
          onSetFaceKind={(id, kind: FaceKind) => {
            setFaces((prev) =>
              prev.map((f) => {
                if (f.id !== id) return f
                const map =
                  grayMapsRef.current[f.projectorIndex] ??
                  grayMapRef.current ??
                  pickBestGrayMap(f.outline, [...grayMapsRef.current, grayMapRef.current])
                if (!map) return { ...f, kind }
                return refitFaceRegion(f, map, kind) ?? { ...f, kind }
              }),
            )
          }}
          activeProjectorLabel={
            activeCameraControlDisplayId
              ? (() => {
                  const all = projectors.length > 0 ? projectors : displays.filter((d) => d.isPrimary)
                  const idx = all.findIndex((d) => d.id === activeCameraControlDisplayId)
                  if (idx < 0) return null
                  return friendlyProjectorName(all[idx].label, idx)
                })()
              : null
          }
        />

        {manualEntriesNow.map((manualEntry) => {
          const displayId = manualEntry.display.id
          const manualMedia = manualMediaByDisplayId[displayId] ?? []
          const selectedManualMediaId = selectedManualMediaByDisplayId[displayId] ?? null
          const selectedManualMedia =
            (selectedManualMediaId ? manualMedia.find((m) => m.id === selectedManualMediaId) : null) ?? null
          const manualTargets = manualTargetsByDisplayId[displayId] ?? []
          const selectedManualTargetId = selectedManualTargetByDisplayId[displayId] ?? null
          const selectedManualTargetLabel =
            (selectedManualTargetId
              ? manualTargets.find((t) => t.id === selectedManualTargetId)?.label
              : null) ??
            friendlyProjectorName(manualEntry.display.label, manualEntry.index) ??
            null
          return (
            <div key={`manual-controls-${displayId}`} style={{ display: 'grid', gap: 12 }}>
              <ManualProjectorPanel
                projectorLabel={friendlyProjectorName(manualEntry.display.label, manualEntry.index)}
                projectorSize={manualEntry.display.size}
                corners={manualCornersByDisplayId[displayId] ?? defaultManualCorners()}
                onChangeCorner={(cornerIndex, point) => {
                  setManualCornersByDisplayId((prev) => {
                    const cur = prev[displayId] ?? defaultManualCorners()
                    const next = cur.map((c, i) => (i === cornerIndex ? point : c))
                    return { ...prev, [displayId]: next }
                  })
                }}
                onSave={() => {
                  const cornersNorm = manualCornersByDisplayId[displayId] ?? defaultManualCorners()
                  const draggedCornersPx = cornersNorm.map((p) => ({
                    x: p.x * manualEntry.display.size.width,
                    y: p.y * manualEntry.display.size.height,
                  }))
                  const rec = save_manual_projector_calibration(
                    displayId,
                    manualEntry.index,
                    manualEntry.display.size,
                    draggedCornersPx,
                  )
                  void projectManualQuadToProjector(displayId)
                  pushToast(
                    'connect',
                    `Saved manual calibration for ${friendlyProjectorName(manualEntry.display.label, manualEntry.index)}`,
                  )
                  pushEvent('info', `Manual calibration saved (${rec.type}) for display ${displayId}`)
                }}
                selectedMedia={selectedManualMedia}
                onProjectNow={() => {
                  void projectManualQuadToProjector(displayId)
                }}
                targets={manualTargets}
                selectedTargetId={selectedManualTargetId}
                onSelectTarget={(id) => {
                  setSelectedManualTargetByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: id,
                  }))
                  void projectManualQuadToProjector(displayId)
                }}
                onDeleteTarget={(id) => {
                  setManualTargetsByDisplayId((prev) => {
                    const cur = prev[displayId] ?? []
                    const next = cur.filter((t) => t.id !== id)
                    return { ...prev, [displayId]: next }
                  })
                  setSelectedManualTargetByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: prev[displayId] === id ? null : prev[displayId],
                  }))
                  void projectManualQuadToProjector(displayId)
                }}
                onAddTarget={(targetCorners, label) => {
                  const id = `manual-target-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
                  const mediaId =
                    selectedManualMediaByDisplayId[displayId] ??
                    manualMedia.find((m) => m.id === 'test-white-solid')?.id ??
                    manualMedia[0]?.id ??
                    null
                  const target = { id, label, corners: targetCorners, mediaId }
                  setManualTargetsByDisplayId((prev) => {
                    const cur = prev[displayId] ?? []
                    return { ...prev, [displayId]: [...cur, target] }
                  })
                  setSelectedManualTargetByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: id,
                  }))
                  void projectManualQuadToProjector(displayId)
                }}
              />
              <ContentPanel
                items={manualMedia}
                selectedId={selectedManualMediaId}
                onSelect={(id) =>
                  setSelectedManualMediaByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: id,
                  }))
                }
                onAdd={(item) => {
                  setManualMediaByDisplayId((prev) => {
                    const cur = prev[displayId] ?? []
                    if (cur.some((m) => m.id === item.id)) return prev
                    return { ...prev, [displayId]: [item, ...cur] }
                  })
                  setSelectedManualMediaByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: item.id,
                  }))
                }}
                onDeleteMedia={(id) => deleteManualMedia(displayId, id)}
                onProject={() => {
                  void projectManualQuadToProjector(displayId)
                }}
                selectedTargetLabel={selectedManualTargetLabel}
                targetOptions={manualTargets.map((t) => ({
                  id: t.id,
                  label: t.label,
                  mediaId: t.mediaId ?? null,
                  mediaName:
                    (t.mediaId
                      ? manualMedia.find((m) => m.id === t.mediaId)?.name
                      : null) ?? null,
                }))}
                selectedTargetId={selectedManualTargetId}
                onSelectTarget={(id) => {
                  setSelectedManualTargetByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: id,
                  }))
                }}
                onDeleteTarget={(id) => {
                  setManualTargetsByDisplayId((prev) => {
                    const cur = prev[displayId] ?? []
                    return { ...prev, [displayId]: cur.filter((t) => t.id !== id) }
                  })
                  setSelectedManualTargetByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: prev[displayId] === id ? null : prev[displayId],
                  }))
                  void projectManualQuadToProjector(displayId)
                }}
                onAssignTargetMedia={(targetId, mediaId) => {
                  setManualTargetsByDisplayId((prev) => {
                    const cur = prev[displayId] ?? []
                    return {
                      ...prev,
                      [displayId]: cur.map((t) =>
                        t.id === targetId ? { ...t, mediaId } : t,
                      ),
                    }
                  })
                  setSelectedManualMediaByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: mediaId,
                  }))
                  setSelectedManualTargetByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: targetId,
                  }))
                  void projectManualQuadToProjector(displayId)
                }}
                onProjectMedia={(item) => {
                  setManualMediaByDisplayId((prev) => {
                    const cur = prev[displayId] ?? []
                    if (cur.some((m) => m.id === item.id)) return prev
                    return { ...prev, [displayId]: [item, ...cur] }
                  })
                  setSelectedManualMediaByDisplayId((prev) => ({
                    ...prev,
                    [displayId]: item.id,
                  }))
                  const targetId =
                    selectedManualTargetByDisplayId[displayId] ??
                    (manualTargets[manualTargets.length - 1]?.id ?? null)
                  if (targetId) {
                    setManualTargetsByDisplayId((prev) => {
                      const cur = prev[displayId] ?? []
                      return {
                        ...prev,
                        [displayId]: cur.map((t) =>
                          t.id === targetId ? { ...t, mediaId: item.id } : t,
                        ),
                      }
                    })
                  }
                  // Pass item immediately — React state hasn't flushed yet.
                  void projectManualQuadToProjector(displayId, item).then((r) => {
                    if (!r.ok) {
                      pushToast('info', r.error || 'Could not send media to projector')
                    } else if (
                      item.type === 'video' &&
                      !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/m\//i.test(item.url || '')
                    ) {
                      pushToast(
                        'info',
                        'Video URL is not a local http media link — projector may stay blank. Re-upload.',
                      )
                    }
                  })
                }}
              />
            </div>
          )
        })}

        <ContentPanel
          items={media}
          selectedId={selectedMediaId}
          onSelect={setSelectedMediaId}
          onAdd={(item) => {
            setMedia((prev) => [item, ...prev])
            setSelectedMediaId(item.id)
          }}
          onDeleteMedia={deleteMedia}
          onProject={projectSelected}
          targetOptions={cameraTargets.map((s) => ({
            id: s.id,
            label: s.label,
            mediaId: s.mediaId ?? null,
            mediaName: media.find((m) => m.id === s.mediaId)?.name ?? null,
          }))}
          selectedTargetId={selectedSurfaceId}
          onSelectTarget={setSelectedSurfaceId}
          selectedTargetLabel={
            cameraTargets.find((s) => s.id === selectedSurfaceId)?.label ??
            null
          }
          onDeleteTarget={(id) => {
            clearRefinedForSurface(id)
            if (id.startsWith('surf-face-')) {
              const faceId = id.slice('surf-'.length)
              setFaces((prev) => prev.filter((f) => f.id !== faceId))
            }
            setSurfaces((prev) => {
              const next = prev.filter((s) => s.id !== id)
              void broadcastAllLayers(next)
              return next
            })
            if (selectedSurfaceId === id) setSelectedSurfaceId(null)
          }}
          onAssignTargetMedia={(targetId, mediaId) => {
            const next = surfaces.map((s) =>
              s.id === targetId ? { ...s, mediaId } : s,
            )
            setSurfaces(next)
            setSelectedSurfaceId(targetId)
            setSelectedMediaId(mediaId)
            const hint = media.find((m) => m.id === mediaId) ?? null
            void broadcastAllLayers(next, hint)
          }}
          onProjectMedia={projectMediaOntoSelected}
        />

        <details className="advanced-details">
          <summary>Advanced · marker calibration (optional)</summary>
          <CalibrationPanel
            videoRef={videoRef}
            stream={camera.stream}
            cameraLabel={camera.selected?.label ?? null}
            status={calStatus}
            progress={calProgress}
            results={calResults}
            onStart={runCalibration}
            onShowPattern={showPattern}
            canCalibrate={!!camera.selected && !camera.selected.isBuiltin && projectors.length > 0}
            error={calError}
            hidePreview
          />
        </details>
      </main>

      <aside className="side-panel right">
        <div className="card">
          <h2>How it works</h2>
          <p className="sub">Three steps — no jargon.</p>
          <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.55 }}>
            <li>
              <strong>Calibrate</strong> — open the projector, then Auto-calibrate.
            </li>
            <li>
              <strong>Outline</strong> — click around the object (hourglass, wall, cube face…).
            </li>
            <li>
              <strong>Look</strong> — type what you want and Generate onto that shape.
            </li>
          </ol>
        </div>
        {cameraLiveCount >= 2 && (
          <EdgeBlendPanel
            config={blend}
            onChange={setBlend}
            projectorCount={cameraLiveCount}
          />
        )}
      </aside>

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
