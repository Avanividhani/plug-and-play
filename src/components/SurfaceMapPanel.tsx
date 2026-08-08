import { useCallback, useEffect, useRef, useState } from 'react'
import type { DetectedSurface, NormPoint } from '../lib/surfaceDetect'
import { addEditPoint, moveCorner, removeEditPoint } from '../lib/surfaceDetect'
import { rectToQuad } from '../lib/seeMatch'
import {
  DRAW_SHAPES,
  shapeFromBounds,
  shapeIcon,
  shapeLabel,
  type DrawShapeId,
} from '../lib/drawShapes'
import type { FaceKind, FaceRegion } from '../lib/faceRegions'
import {
  clientToVideoNorm,
  getContainedVideoBox,
  videoNormToWrap,
} from '../lib/videoLayout'
import type { MediaItem } from '../lib/types'

type CalibStep = 'need-match' | 'outline-light' | 'draw-target'
export type WorkMode = 'faces' | 'content'

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>
  stream: MediaStream | null
  cameraLabel: string | null
  surfaces: DetectedSurface[]
  selectedId: string | null
  onSelect: (id: string) => void
  onChangeSurface: (surface: DetectedSurface) => void
  /** Move a single projector warp point (fine-tune light without changing camera outline) */
  onMoveProjCorner?: (surfaceId: string, cornerIndex: number, delta: NormPoint) => void
  onDeleteSurface?: (id: string) => void
  onClearTargets?: () => void
  mediaItems?: MediaItem[]
  onAssignMedia?: (surfaceId: string, mediaId: string) => void
  onDrawRect: (corners: NormPoint[], label: string) => void
  onScan: () => void
  onApply: () => void
  onAlign: () => void
  onFlashWhite: () => void
  aligning: boolean
  aligned: boolean
  calibStep: CalibStep
  clickCorners?: { x: number; y: number }[]
  onProbeCornerClick?: (norm: NormPoint) => void
  projOffset: { x: number; y: number }
  onNudge: (dx: number, dy: number) => void
  onResetNudge: () => void
  scanning: boolean
  canApply: boolean
  error: string | null
  alignProgress?: string | null
  footprint?: { x: number; y: number }[] | null
  calibDots?: { x: number; y: number }[]
  calibExpect?: { x: number; y: number } | null
  /** Preview zoom (1–3). Clicks stay mapped to the real camera frame. */
  cameraZoom?: number
  /** Faces = outline named regions; Content = draw projection targets */
  workMode?: WorkMode
  onWorkMode?: (mode: WorkMode) => void
  faces?: FaceRegion[]
  onSaveFace?: (outline: NormPoint[], kind: FaceKind) => void
  onDeleteFace?: (id: string) => void
  onRenameFace?: (id: string, name: string) => void
  onSetFaceKind?: (id: string, kind: FaceKind) => void
  activeProjectorLabel?: string | null
}

const COLORS = ['#3dd6c6', '#5b8def', '#f0a060', '#e85d6a', '#c4a8ff', '#5ed68a']
const FACE_COLORS = ['#e8c547', '#7ec8e3', '#e07a5f', '#81b29a', '#f2cc8f', '#3d405b']

export function SurfaceMapPanel({
  videoRef,
  stream,
  cameraLabel,
  surfaces,
  selectedId,
  onSelect,
  onChangeSurface,
  onMoveProjCorner,
  onDeleteSurface,
  onClearTargets,
  mediaItems = [],
  onAssignMedia,
  onDrawRect,
  onScan,
  onApply,
  onAlign,
  onFlashWhite,
  aligning,
  aligned,
  calibStep,
  projOffset,
  onNudge,
  onResetNudge,
  scanning,
  canApply,
  error,
  alignProgress,
  footprint,
  calibDots = [],
  calibExpect = null,
  cameraZoom = 1,
  workMode = 'content',
  onWorkMode,
  faces = [],
  onSaveFace,
  onDeleteFace,
  onRenameFace,
  onSetFaceKind,
  activeProjectorLabel = null,
}: Props) {
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dragCorner, setDragCorner] = useState<number | null>(null)
  const [drawStart, setDrawStart] = useState<NormPoint | null>(null)
  const [drawCurr, setDrawCurr] = useState<NormPoint | null>(null)
  /** Shape chosen from dropdown — freeform uses click-to-place corners */
  const [drawShape, setDrawShape] = useState<DrawShapeId>('rect')
  const drawShapeDef = DRAW_SHAPES.find((s) => s.id === drawShape) ?? DRAW_SHAPES[0]
  const isFacesMode = workMode === 'faces'
  const isFreeform = isFacesMode || drawShapeDef.mode === 'click'
  /** New face: flat plane vs curved grid */
  const [newFaceKind, setNewFaceKind] = useState<FaceKind>('curved')
  /** shape = edit camera outline; warp = fine-tune where light lands per point */
  const [pointEdit, setPointEdit] = useState<'shape' | 'warp'>('shape')
  const [polyPoints, setPolyPoints] = useState<NormPoint[]>([])
  const [nudgeStep, setNudgeStep] = useState(0.008)
  const lastNormRef = useRef<NormPoint | null>(null)
  const selected = surfaces.find((s) => s.id === selectedId) ?? null

  useEffect(() => {
    const video = videoRef.current
    const wrap = wrapRef.current
    if (!video || !stream) return
    video.srcObject = stream
    void video.play().catch(() => {})

    const syncSize = () => {
      if (!wrap || !video.videoWidth || !video.videoHeight) return
      const ar = video.videoWidth / video.videoHeight
      wrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`
      const maxH = Math.max(200, window.innerHeight - 220)
      const maxW = wrap.parentElement?.clientWidth || window.innerWidth
      const wFromH = maxH * ar
      wrap.style.width = `${Math.min(maxW, wFromH)}px`
    }
    window.addEventListener('resize', syncSize)
    video.addEventListener('loadedmetadata', syncSize)
    video.addEventListener('resize', syncSize)
    syncSize()
    return () => {
      video.removeEventListener('loadedmetadata', syncSize)
      video.removeEventListener('resize', syncSize)
      window.removeEventListener('resize', syncSize)
    }
  }, [stream, videoRef])

  const layoutBox = useCallback(() => {
    const wrap = wrapRef.current
    const video = videoRef.current
    if (!wrap) return null
    const rect = wrap.getBoundingClientRect()
    return {
      rect,
      box: getContainedVideoBox(
        rect.width,
        rect.height,
        video?.videoWidth || 1280,
        video?.videoHeight || 720,
      ),
    }
  }, [videoRef])

  const toNorm = useCallback(
    (clientX: number, clientY: number): NormPoint | null => {
      const layout = layoutBox()
      if (!layout) return null
      const { rect } = layout
      const z = Math.max(1, cameraZoom)
      // Undo CSS scale around center so clicks hit the same camera pixels
      const lx = clientX - rect.left
      const ly = clientY - rect.top
      const cx = rect.width / 2
      const cy = rect.height / 2
      const ux = (lx - cx) / z + cx
      const uy = (ly - cy) / z + cy
      return clientToVideoNorm(rect.left + ux, rect.top + uy, rect, layout.box)
    },
    [layoutBox, cameraZoom],
  )

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const canvas = overlayRef.current
      const wrap = wrapRef.current
      const video = videoRef.current
      if (canvas && wrap) {
        const rect = wrap.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        const cw = Math.max(1, Math.round(rect.width * dpr))
        const ch = Math.max(1, Math.round(rect.height * dpr))
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw
          canvas.height = ch
          canvas.style.width = `${rect.width}px`
          canvas.style.height = `${rect.height}px`
        }
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, rect.width, rect.height)
          const box = getContainedVideoBox(
            rect.width,
            rect.height,
            video?.videoWidth || 1280,
            video?.videoHeight || 720,
          )
          const pt = (c: { x: number; y: number }) => videoNormToWrap(c.x, c.y, box)

          if (footprint && footprint.length >= 3) {
            ctx.beginPath()
            footprint.forEach((c, i) => {
              const p = pt(c)
              if (i === 0) ctx.moveTo(p.x, p.y)
              else ctx.lineTo(p.x, p.y)
            })
            ctx.closePath()
            ctx.strokeStyle = 'rgba(255, 220, 50, 0.55)'
            ctx.lineWidth = 1.5
            ctx.setLineDash([5, 5])
            ctx.stroke()
            ctx.setLineDash([])
          }

          if (calibStep === 'need-match' || calibStep === 'outline-light') {
            calibDots.forEach((c) => {
              const p = pt(c)
              ctx.beginPath()
              ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
              ctx.fillStyle = 'rgba(255, 220, 50, 0.55)'
              ctx.fill()
            })
            if (calibExpect) {
              const p = pt(calibExpect)
              ctx.strokeStyle = 'rgba(61, 214, 198, 0.75)'
              ctx.lineWidth = 1.5
              ctx.beginPath()
              ctx.moveTo(p.x - 10, p.y)
              ctx.lineTo(p.x + 10, p.y)
              ctx.moveTo(p.x, p.y - 10)
              ctx.lineTo(p.x, p.y + 10)
              ctx.stroke()
            }
          }

          faces.forEach((face, fi) => {
            const color = FACE_COLORS[fi % FACE_COLORS.length]
            const pts = face.outline.map(pt)
            if (pts.length < 2) return
            ctx.beginPath()
            pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
            ctx.closePath()
            ctx.strokeStyle = color
            ctx.lineWidth = isFacesMode ? 2.5 : 1.5
            ctx.globalAlpha = isFacesMode ? 0.95 : 0.45
            ctx.setLineDash(isFacesMode ? [] : [6, 4])
            ctx.stroke()
            ctx.setLineDash([])
            ctx.globalAlpha = 0.12
            ctx.fillStyle = color
            ctx.fill()
            ctx.globalAlpha = 1
            const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
            const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
            ctx.fillStyle = color
            ctx.font = 'bold 11px IBM Plex Sans, sans-serif'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(face.name, cx, cy)
          })

          if (!isFacesMode) {
            surfaces.forEach((surf, si) => {
              if (
                surf.label === 'Beam outline' ||
                surf.label === 'Probe lock' ||
                surf.label === 'Light outline' ||
                surf.label === 'Verify center'
              ) {
                return
              }
              const color = COLORS[si % COLORS.length]
              const active = surf.id === selectedId
              const pts = surf.corners.map(pt)

              ctx.beginPath()
              pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
              ctx.closePath()
              ctx.strokeStyle = color
              ctx.lineWidth = active ? 2.25 : 1.25
              ctx.globalAlpha = active ? 0.95 : 0.55
              ctx.setLineDash(active ? [] : [5, 4])
              ctx.stroke()
              ctx.setLineDash([])
              ctx.globalAlpha = 1

              if (active) {
                pts.forEach((p, i) => {
                  const r = pointEdit === 'warp' ? 8 : 7
                  ctx.beginPath()
                  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
                  ctx.fillStyle = pointEdit === 'warp' ? '#f0a060' : color
                  ctx.fill()
                  ctx.strokeStyle = '#0a0c0f'
                  ctx.lineWidth = 1.5
                  ctx.stroke()
                  ctx.fillStyle = '#0a0c0f'
                  ctx.font = 'bold 9px IBM Plex Sans, sans-serif'
                  ctx.textAlign = 'center'
                  ctx.textBaseline = 'middle'
                  ctx.fillText(String(i + 1), p.x, p.y)
                })
              }
            })
          }

          if (polyPoints.length > 0 && (calibStep === 'draw-target' || isFacesMode)) {
            ctx.beginPath()
            polyPoints.forEach((c, i) => {
              const p = pt(c)
              if (i === 0) ctx.moveTo(p.x, p.y)
              else ctx.lineTo(p.x, p.y)
            })
            ctx.strokeStyle = 'rgba(61, 214, 198, 0.9)'
            ctx.lineWidth = 1.5
            ctx.setLineDash([4, 3])
            ctx.stroke()
            ctx.setLineDash([])
            polyPoints.forEach((c, i) => {
              const p = pt(c)
              ctx.beginPath()
              ctx.arc(p.x, p.y, 6, 0, Math.PI * 2)
              ctx.fillStyle = '#3dd6c6'
              ctx.fill()
              ctx.fillStyle = '#0a0c0f'
              ctx.font = 'bold 9px IBM Plex Sans, sans-serif'
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillText(String(i + 1), p.x, p.y)
            })
          }

          if (drawStart && drawCurr) {
            const teaching = calibStep === 'outline-light'
            const preview =
              teaching || drawShape === 'rect'
                ? rectToQuad(drawStart.x, drawStart.y, drawCurr.x, drawCurr.y)
                : shapeFromBounds(drawShape, drawStart.x, drawStart.y, drawCurr.x, drawCurr.y)
            if (preview && preview.length >= 3) {
              ctx.beginPath()
              preview.forEach((c, i) => {
                const p = pt(c)
                if (i === 0) ctx.moveTo(p.x, p.y)
                else ctx.lineTo(p.x, p.y)
              })
              ctx.closePath()
              ctx.strokeStyle = teaching ? 'rgba(255, 220, 50, 0.9)' : 'rgba(61, 214, 198, 0.9)'
              ctx.lineWidth = 2
              ctx.setLineDash([])
              ctx.stroke()
            }
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [
    surfaces,
    selectedId,
    footprint,
    drawStart,
    drawCurr,
    calibStep,
    videoRef,
    polyPoints,
    calibDots,
    calibExpect,
    pointEdit,
    drawShape,
    faces,
    isFacesMode,
  ])

  const hitCorner = (norm: NormPoint, surface: DetectedSurface): number | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    const thresh = 16 / Math.min(wrap.clientWidth, wrap.clientHeight)
    for (let i = 0; i < surface.corners.length; i++) {
      const c = surface.corners[i]
      if (Math.hypot(c.x - norm.x, c.y - norm.y) < thresh) return i
    }
    return null
  }

  const finishPolygon = () => {
    if (polyPoints.length < 3) return
    if (isFacesMode && onSaveFace) {
      onSaveFace(polyPoints, newFaceKind)
      setPolyPoints([])
      return
    }
    onDrawRect(polyPoints, shapeLabel('freeform'))
    setPolyPoints([])
  }

  const undoLastPoint = () => {
    setPolyPoints((prev) => prev.slice(0, -1))
  }

  const removeDraftPointAt = (norm: NormPoint): boolean => {
    const wrap = wrapRef.current
    if (!wrap || polyPoints.length === 0) return false
    // Tight hit — only the point itself, not nearby clicks (hourglass / dense outlines)
    const thresh = 6 / Math.min(wrap.clientWidth, wrap.clientHeight)
    let best = -1
    let bestD = thresh
    for (let i = 0; i < polyPoints.length; i++) {
      const c = polyPoints[i]
      const d = Math.hypot(c.x - norm.x, c.y - norm.y)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) return false
    setPolyPoints((prev) => prev.filter((_, i) => i !== best))
    return true
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (polyPoints.length === 0) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        undoLastPoint()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setPolyPoints([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [polyPoints.length])

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const norm = toNorm(e.clientX, e.clientY)
    if (!norm) return

    if (isFacesMode) {
      if (calibStep === 'need-match') return
      // Right-click = undo last point
      if (e.button === 2) {
        undoLastPoint()
        return
      }
      // Click dead-center on first point → close face (tight so dense draws don't auto-close)
      if (polyPoints.length >= 3) {
        const first = polyPoints[0]
        const wrap = wrapRef.current
        const thresh = wrap ? 7 / Math.min(wrap.clientWidth, wrap.clientHeight) : 0.008
        if (Math.hypot(norm.x - first.x, norm.y - first.y) < thresh) {
          finishPolygon()
          return
        }
      }
      // Only erase if the click lands on the point marker itself
      if (removeDraftPointAt(norm)) return
      if (e.detail >= 2 && polyPoints.length >= 3) {
        finishPolygon()
        return
      }
      setPolyPoints((prev) => [...prev, norm])
      return
    }

    if (calibStep === 'draw-target' && selected && selected.label !== 'Beam outline') {
      const corner = hitCorner(norm, selected)
      if (corner !== null) {
        setDragCorner(corner)
        lastNormRef.current = norm
        wrapRef.current?.setPointerCapture(e.pointerId)
        return
      }
    }

    if (calibStep === 'need-match') return

    if (calibStep === 'draw-target' && isFreeform) {
      if (e.button === 2) {
        undoLastPoint()
        return
      }
      if (removeDraftPointAt(norm)) return
      if (e.detail >= 2 && polyPoints.length >= 3) {
        finishPolygon()
        return
      }
      setPolyPoints((prev) => [...prev, norm])
      return
    }

    setDrawStart(norm)
    setDrawCurr(norm)
    setDragCorner(null)
    wrapRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const norm = toNorm(e.clientX, e.clientY)
    if (!norm) return

    if (drawStart) {
      setDrawCurr(norm)
      return
    }
    if (dragCorner === null || !selected) return

    if (pointEdit === 'warp' && onMoveProjCorner) {
      const prev = lastNormRef.current
      if (prev) {
        onMoveProjCorner(selected.id, dragCorner, {
          x: norm.x - prev.x,
          y: norm.y - prev.y,
        })
      }
      lastNormRef.current = norm
      return
    }

    onChangeSurface(moveCorner(selected, dragCorner, norm))
    lastNormRef.current = norm
  }

  const onPointerUp = () => {
    if (drawStart && drawCurr) {
      if (calibStep === 'outline-light') {
        const q = rectToQuad(drawStart.x, drawStart.y, drawCurr.x, drawCurr.y)
        const w = Math.abs(q[1].x - q[0].x)
        const h = Math.abs(q[2].y - q[1].y)
        if (w > 0.03 && h > 0.03) onDrawRect(q, 'Beam outline')
      } else if (calibStep === 'draw-target' && !isFreeform) {
        const pts = shapeFromBounds(drawShape, drawStart.x, drawStart.y, drawCurr.x, drawCurr.y)
        if (pts && pts.length >= 3) {
          onDrawRect(pts, shapeLabel(drawShape))
        }
      }
    }
    setDrawStart(null)
    setDrawCurr(null)
    setDragCorner(null)
    lastNormRef.current = null
  }

  return (
    <div className="card surface-map-card">
      <h2>Camera & surfaces</h2>
      <p className="sub">
        Three easy steps: calibrate, outline where light should go, then generate or upload content.
      </p>
      {activeProjectorLabel && (
        <p className="empty-hint" style={{ marginTop: -4, marginBottom: 8 }}>
          Controls currently target: <strong>{activeProjectorLabel}</strong>
        </p>
      )}

      <ol className="workflow-steps" aria-label="Workflow">
        <li className={calibStep !== 'need-match' ? 'done' : aligning ? 'active' : ''}>
          <span className="step-num">1</span>
          <span className="step-label">Calibrate</span>
        </li>
        <li
          className={
            faces.length > 0 || (!isFacesMode && calibStep === 'draw-target')
              ? 'done'
              : isFacesMode
                ? 'active'
                : ''
          }
        >
          <span className="step-num">2</span>
          <span className="step-label">Outline</span>
        </li>
        <li className={!isFacesMode && calibStep === 'draw-target' && faces.length > 0 ? 'active' : ''}>
          <span className="step-num">3</span>
          <span className="step-label">Look</span>
        </li>
      </ol>

      <div className="surface-toolbar">
        <button className="btn btn-primary" onClick={onAlign} disabled={aligning}>
          {aligning ? alignProgress || 'Calibrating…' : '1 · Auto-calibrate'}
        </button>
        <button className="btn btn-ghost" onClick={onFlashWhite} disabled={aligning}>
          Flash white
        </button>
        <span className="toolbar-sep" />
        {onWorkMode && (
          <div className="work-mode-toggle" role="group" aria-label="What are you doing">
            <button
              type="button"
              className={`btn ${isFacesMode ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: 12, padding: '4px 10px' }}
              disabled={calibStep === 'need-match'}
              onClick={() => {
                onWorkMode('faces')
                setPolyPoints([])
                setDrawStart(null)
                setDrawCurr(null)
              }}
            >
              2 · Outline object
            </button>
            <button
              type="button"
              className={`btn ${!isFacesMode ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: 12, padding: '4px 10px' }}
              disabled={calibStep === 'need-match'}
              onClick={() => {
                onWorkMode('content')
                setPolyPoints([])
                setDrawStart(null)
                setDrawCurr(null)
              }}
            >
              Edit shapes
            </button>
          </div>
        )}
        <span className="toolbar-sep" />
        {isFacesMode ? (
          <>
            <label className="shape-select-wrap">
              <span className="shape-select-label">Kind</span>
              <select
                className="shape-select"
                value={newFaceKind}
                onChange={(e) => setNewFaceKind(e.target.value as FaceKind)}
              >
                <option value="flat">Flat</option>
                <option value="curved">Curved</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={polyPoints.length < 3}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                finishPolygon()
              }}
            >
              Close face ({polyPoints.length})
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={polyPoints.length === 0}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                undoLastPoint()
              }}
            >
              Undo point
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={polyPoints.length === 0}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setPolyPoints([])
              }}
            >
              Clear points
            </button>
          </>
        ) : (
          <>
            <label className="shape-select-wrap">
              <span className="shape-select-label">Shape</span>
              <select
                className="shape-select"
                value={drawShape}
                disabled={calibStep === 'need-match'}
                onChange={(e) => {
                  const id = e.target.value as DrawShapeId
                  setDrawShape(id)
                  setPolyPoints([])
                  setDrawStart(null)
                  setDrawCurr(null)
                }}
              >
                {DRAW_SHAPES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {isFreeform && calibStep === 'draw-target' && (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={polyPoints.length < 3}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    finishPolygon()
                  }}
                >
                  Close shape ({polyPoints.length})
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={polyPoints.length === 0}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    undoLastPoint()
                  }}
                >
                  Undo point
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (polyPoints.length > 0) {
                      setPolyPoints([])
                      return
                    }
                    onClearTargets?.()
                  }}
                >
                  {polyPoints.length > 0 ? 'Clear points' : 'Clear targets'}
                </button>
              </>
            )}
            {calibStep === 'draw-target' &&
              surfaces.some((s) => s.label !== 'Beam outline') &&
              !isFreeform && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onClearTargets?.()
                  }}
                >
                  Clear targets
                </button>
              )}
          </>
        )}
      </div>

      <p className="step-hint">
        {alignProgress ||
          (calibStep === 'need-match'
            ? 'Step 1 — Auto-calibrate (~40s, dim lights, camera on the beam).'
            : calibStep === 'outline-light'
              ? 'Drag ON the bright white light only — not the whole camera.'
              : isFacesMode
                ? 'Step 2 — Click around the object. Undo / Backspace if needed. Close outline when done — it stays lit.'
                : isFreeform
                  ? 'Click corners for a freeform shape, or switch to Outline object for mapped faces.'
                  : `Drag a ${shapeLabel(drawShape).toLowerCase()} — or use Outline object for 3D surfaces.`)}
      </p>

      <div className="surface-layout">
        <div
          className="preview-box surface-stage"
          ref={wrapRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => {
            e.preventDefault()
            if (polyPoints.length > 0) undoLastPoint()
          }}
          style={{ cursor: 'crosshair' }}
        >
          <div
            className="surface-zoom"
            style={{
              transform: `scale(${Math.max(1, cameraZoom)})`,
              transformOrigin: 'center center',
            }}
          >
            <video ref={videoRef} muted playsInline />
            <canvas ref={overlayRef} className="surface-overlay" />
          </div>
          <span className="preview-label">{cameraLabel ?? 'No camera'}</span>
        </div>

        <aside className="surface-side">
          {isFacesMode ? (
            <>
              <h3 className="panel-title">Step 2 · Your outlines</h3>
              <p className="empty-hint" style={{ marginTop: 0 }}>
                Wrong point? Undo or click it. After Close, scroll down to step 3 to generate a look.
              </p>
              <div className="device-list">
                {faces.length === 0 && (
                  <p className="empty-hint">No faces yet — click corners on the camera.</p>
                )}
                {faces.map((f, i) => (
                  <div key={f.id} className="face-row">
                    <div
                      className="device-row"
                      style={{
                        textAlign: 'left',
                        width: '100%',
                        flex: 1,
                        borderLeft: `3px solid ${FACE_COLORS[i % FACE_COLORS.length]}`,
                      }}
                    >
                      <div
                        className="device-icon"
                        style={{
                          background: `${FACE_COLORS[i % FACE_COLORS.length]}22`,
                          color: FACE_COLORS[i % FACE_COLORS.length],
                        }}
                      >
                        {f.kind === 'curved' ? '⌒' : '▭'}
                      </div>
                      <div className="device-meta" style={{ flex: 1, minWidth: 0 }}>
                        <input
                          className="face-name-input"
                          value={f.name}
                          onChange={(e) => onRenameFace?.(f.id, e.target.value)}
                          aria-label="Face name"
                        />
                        <span>
                          {f.outline.length} pts · {f.kind} · {f.sampleCount} samples
                          {f.H ? '' : ' · weak fit'}
                        </span>
                        <div className="btn-row" style={{ marginTop: 4 }}>
                          <button
                            type="button"
                            className={`btn ${f.kind === 'flat' ? 'btn-primary' : 'btn-ghost'}`}
                            style={{ fontSize: 11, padding: '2px 6px' }}
                            onClick={() => onSetFaceKind?.(f.id, 'flat')}
                          >
                            Flat
                          </button>
                          <button
                            type="button"
                            className={`btn ${f.kind === 'curved' ? 'btn-primary' : 'btn-ghost'}`}
                            style={{ fontSize: 11, padding: '2px 6px' }}
                            onClick={() => onSetFaceKind?.(f.id, 'curved')}
                          >
                            Curved
                          </button>
                        </div>
                      </div>
                    </div>
                    {onDeleteFace && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        title="Delete this face and its projection"
                        onClick={() => onDeleteFace(f.id)}
                        style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <h3 className="panel-title">Step 2 · Your shapes</h3>
              <p className="empty-hint" style={{ marginTop: 0 }}>
                Select one, then use step 3 below to generate AI onto it.
              </p>
              {surfaces.some((s) => s.label !== 'Beam outline') && onClearTargets && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginBottom: 8, fontSize: 12, padding: '4px 10px' }}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onClearTargets()
                  }}
                >
                  Clear all targets
                </button>
              )}
              <div className="device-list">
                {surfaces.filter((s) => s.label !== 'Beam outline').length === 0 && (
                  <p className="empty-hint">Your shapes will list here after you draw.</p>
                )}
                {surfaces
                  .filter((s) => s.label !== 'Beam outline')
                  .map((s, i) => {
                    const mediaName = mediaItems.find((m) => m.id === s.mediaId)?.name
                    return (
                      <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                        <button
                          type="button"
                          className={`device-row ${s.id === selectedId ? 'connected' : ''}`}
                          onClick={() => onSelect(s.id)}
                          style={{ textAlign: 'left', width: '100%', flex: 1 }}
                        >
                          <div
                            className="device-icon"
                            style={{
                              background: `${COLORS[i % COLORS.length]}22`,
                              color: COLORS[i % COLORS.length],
                            }}
                          >
                            {shapeIcon(s.label)}
                          </div>
                          <div className="device-meta">
                            <strong>{s.label}</strong>
                            <span>
                              {s.corners.length} pts
                              {mediaName ? ` · ${mediaName}` : ' · no content'}
                            </span>
                          </div>
                          {s.id === selectedId && <span className="device-badge">Selected</span>}
                        </button>
                        {onDeleteSurface && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            title="Delete this shape"
                            onClick={() => onDeleteSurface(s.id)}
                            style={{ padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )
                  })}
              </div>
            </>
          )}

          {!isFacesMode && selected && selected.label !== 'Beam outline' && (
            <div style={{ marginTop: 12 }}>
              <h3 className="panel-title">Edit points</h3>
              <p className="empty-hint" style={{ marginTop: 0, marginBottom: 8 }}>
                Drag numbered handles on the camera. Add points for curved objects.
              </p>
              <div className="btn-row" style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className={`btn ${pointEdit === 'shape' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={() => setPointEdit('shape')}
                >
                  Outline
                </button>
                <button
                  type="button"
                  className={`btn ${pointEdit === 'warp' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={() => setPointEdit('warp')}
                  disabled={!onMoveProjCorner}
                >
                  Fine-tune light
                </button>
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => onChangeSurface(addEditPoint(selected))}
                >
                  + Add point
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: 12 }}
                  disabled={selected.corners.length <= 3}
                  onClick={() =>
                    onChangeSurface(removeEditPoint(selected, selected.corners.length - 1))
                  }
                >
                  − Remove last
                </button>
              </div>
            </div>
          )}

          {!isFacesMode && selected && selected.label !== 'Beam outline' && onAssignMedia && mediaItems.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 className="panel-title">Content on this target</h3>
              <select
                value={selected.mediaId ?? ''}
                onChange={(e) => {
                  if (e.target.value) onAssignMedia(selected.id, e.target.value)
                }}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: '#12151a',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                }}
              >
                <option value="" disabled>
                  Choose content…
                </option>
                {mediaItems.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {!isFacesMode && selected && selected.label !== 'Beam outline' && (
            <div style={{ marginTop: 12 }}>
              <h3 className="panel-title">Nudge</h3>
              <div className="btn-row" style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className={`btn ${nudgeStep <= 0.005 ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setNudgeStep(0.004)}
                  style={{ fontSize: 12, padding: '4px 8px' }}
                >
                  Fine
                </button>
                <button
                  type="button"
                  className={`btn ${nudgeStep > 0.005 ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setNudgeStep(0.015)}
                  style={{ fontSize: 12, padding: '4px 8px' }}
                >
                  Coarse
                </button>
              </div>
              <div className="nudge-pad">
                <button type="button" className="btn btn-ghost nudge-btn" onClick={() => onNudge(0, -nudgeStep)}>
                  ↑
                </button>
                <div className="nudge-mid">
                  <button type="button" className="btn btn-ghost nudge-btn" onClick={() => onNudge(-nudgeStep, 0)}>
                    ←
                  </button>
                  <button type="button" className="btn btn-ghost nudge-btn" onClick={onResetNudge}>
                    ·
                  </button>
                  <button type="button" className="btn btn-ghost nudge-btn" onClick={() => onNudge(nudgeStep, 0)}>
                    →
                  </button>
                </div>
                <button type="button" className="btn btn-ghost nudge-btn" onClick={() => onNudge(0, nudgeStep)}>
                  ↓
                </button>
              </div>
              <p className="empty-hint" style={{ marginTop: 6 }}>
                Offset {projOffset.x.toFixed(3)}, {projOffset.y.toFixed(3)}
              </p>
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 14 }}
            onClick={onApply}
            disabled={!canApply || !aligned}
          >
            Re-project
          </button>
          <button
            className="btn btn-ghost"
            style={{ width: '100%', marginTop: 8 }}
            onClick={onScan}
            disabled={scanning}
          >
            {scanning ? 'Scanning…' : 'Scan scene'}
          </button>
          {error && <p className="error-text">{error}</p>}
        </aside>
      </div>
    </div>
  )
}
