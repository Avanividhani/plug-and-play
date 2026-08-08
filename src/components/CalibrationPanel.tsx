import { useEffect, useRef } from 'react'
import type { CalibrationResult, CalibrationProgress } from '../lib/calibration'
import type { CalStatus } from '../lib/types'

type Props = {
  videoRef: React.RefObject<HTMLVideoElement | null>
  stream: MediaStream | null
  cameraLabel: string | null
  status: CalStatus
  progress: CalibrationProgress | null
  results: CalibrationResult[]
  onStart: () => void
  onShowPattern: () => void
  canCalibrate: boolean
  error: string | null
  /** When true, skip the camera preview (shared with Surface mapping panel) */
  hidePreview?: boolean
}

const STEPS = [
  { id: 'warmup', label: 'Lock camera & projectors' },
  { id: 'pattern', label: 'Project calibration markers' },
  { id: 'capture', label: 'Capture with USB camera' },
  { id: 'detect', label: 'Detect surface geometry' },
  { id: 'solve', label: 'Solve auto-mapping' },
  { id: 'done', label: 'Apply warp' },
]

export function CalibrationPanel({
  videoRef,
  stream,
  cameraLabel,
  status,
  progress,
  results,
  onStart,
  onShowPattern,
  canCalibrate,
  error,
  hidePreview = false,
}: Props) {
  const overlayRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (hidePreview) return
    const video = videoRef.current
    if (!video || !stream) return
    video.srcObject = stream
    video.play().catch(() => {})
  }, [stream, videoRef, hidePreview])

  useEffect(() => {
    if (hidePreview) return
    const canvas = overlayRef.current
    const video = videoRef.current
    if (!canvas || !video || !results.length) return
    const draw = () => {
      if (!video.videoWidth) return
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const latest = results[results.length - 1]
      ctx.strokeStyle = '#3dd6c6'
      ctx.lineWidth = 3
      ctx.beginPath()
      latest.cameraCorners.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      })
      ctx.closePath()
      ctx.stroke()
      latest.cameraCorners.forEach((p, i) => {
        ctx.fillStyle = '#3dd6c6'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.font = 'bold 12px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(i + 1), p.x, p.y)
      })
    }
    draw()
    const id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [results, videoRef, hidePreview])

  const activeStep = progress?.step ?? (status === 'done' ? 'done' : '')
  const stepIndex = STEPS.findIndex((s) => s.id === activeStep)

  const controls = (
    <div>
      <div className="step-list">
        {STEPS.map((s, i) => {
          const done = status === 'done' || (stepIndex >= 0 && i < stepIndex)
          const active = s.id === activeStep && status === 'running'
          return (
            <div key={s.id} className={`step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
              <span className="step-num">{done ? '✓' : i + 1}</span>
              {s.label}
            </div>
          )
        })}
      </div>
      {progress && status === 'running' && (
        <>
          <div className="progress-bar">
            <div style={{ width: `${Math.round(progress.progress * 100)}%` }} />
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>{progress.message}</p>
        </>
      )}
      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
      {status === 'done' && results.length > 0 && (
        <p style={{ color: 'var(--ok)', fontSize: 13 }}>
          Mapped {results.length} projector{results.length > 1 ? 's' : ''} · RMS{' '}
          {results.map((r) => r.rmsError.toFixed(1)).join(' / ')} px
        </p>
      )}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn btn-ghost" onClick={onShowPattern}>
          Show markers
        </button>
        <button className="btn btn-primary" onClick={onStart} disabled={!canCalibrate || status === 'running'}>
          {status === 'running' ? 'Calibrating…' : 'Run auto calibration'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="card">
      <h2>Auto calibration</h2>
      <p className="sub">
        Optional marker-based path. Prefer Surface mapping above for selecting bed / portal / wall from the camera view.
      </p>

      {hidePreview ? (
        controls
      ) : (
        <div className="preview-grid">
          <div className="preview-box">
            <video ref={videoRef} muted playsInline />
            <canvas
              ref={overlayRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            />
            <span className="preview-label">{cameraLabel ?? 'No camera'} · calibration view</span>
          </div>
          {controls}
        </div>
      )}
    </div>
  )
}
