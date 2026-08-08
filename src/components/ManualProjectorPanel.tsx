import { useMemo, useState } from 'react'
import type { NormPoint } from '../lib/surfaceDetect'
import type { MediaItem } from '../lib/types'
import { DRAW_SHAPES, shapeFromBounds, shapeLabel, type DrawShapeId } from '../lib/drawShapes'

type ManualTarget = {
  id: string
  label: string
  corners: NormPoint[]
  mediaId?: string | null
}

type Props = {
  projectorLabel: string
  projectorSize: { width: number; height: number }
  corners: NormPoint[]
  onChangeCorner: (index: number, point: NormPoint) => void
  onSave: () => void
  selectedMedia?: MediaItem | null
  onProjectNow: () => void
  targets: ManualTarget[]
  selectedTargetId: string | null
  onSelectTarget: (id: string) => void
  onDeleteTarget: (id: string) => void
  onAddTarget: (corners: NormPoint[], label: string) => void
}

function clamp01(v: number) {
  return Math.max(0.001, Math.min(0.999, v))
}

export function ManualProjectorPanel({
  projectorLabel,
  projectorSize,
  corners,
  onChangeCorner,
  onSave,
  selectedMedia,
  onProjectNow,
  targets,
  selectedTargetId,
  onSelectTarget,
  onDeleteTarget,
  onAddTarget,
}: Props) {
  const polygon = useMemo(
    () => corners.map((c) => `${(c.x * 100).toFixed(2)}%,${(c.y * 100).toFixed(2)}%`).join(' '),
    [corners],
  )
  const [mode, setMode] = useState<'calibrate' | 'draw'>('calibrate')
  const [drawShape, setDrawShape] = useState<DrawShapeId>('rect')
  const [drawStart, setDrawStart] = useState<NormPoint | null>(null)
  const [drawCurr, setDrawCurr] = useState<NormPoint | null>(null)
  const [polyPoints, setPolyPoints] = useState<NormPoint[]>([])

  const draftPoly =
    drawStart && drawCurr && DRAW_SHAPES.find((s) => s.id === drawShape)?.mode === 'drag'
      ? shapeFromBounds(drawShape, drawStart.x, drawStart.y, drawCurr.x, drawCurr.y)
      : null

  return (
    <div className="card">
      <h2>{projectorLabel} · Manual calibration</h2>
      <p className="sub">
        Drag the 4 corners here while watching the real projected rectangle on the wall. This path
        uses no camera.
      </p>
      <p className="empty-hint" style={{ marginTop: 0 }}>
        {projectorLabel} · {projectorSize.width}×{projectorSize.height}
      </p>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button
          className={`btn ${mode === 'calibrate' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('calibrate')}
        >
          Corner pin
        </button>
        <button
          className={`btn ${mode === 'draw' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('draw')}
        >
          Draw targets
        </button>
      </div>

      <div
        className="manual-quad-editor"
        onPointerDown={(e) => {
          if (mode !== 'draw') return
          const el = e.currentTarget
          const rect = el.getBoundingClientRect()
          const norm = {
            x: clamp01((e.clientX - rect.left) / rect.width),
            y: clamp01((e.clientY - rect.top) / rect.height),
          }
          const shapeDef = DRAW_SHAPES.find((s) => s.id === drawShape)
          if (shapeDef?.mode === 'click') {
            if (e.detail >= 2 && polyPoints.length >= 3) {
              onAddTarget(polyPoints, `${shapeLabel(drawShape)} ${targets.length + 1}`)
              setPolyPoints([])
              return
            }
            setPolyPoints((prev) => [...prev, norm])
            return
          }
          const start = norm
          let current = norm
          setDrawStart(norm)
          setDrawCurr(norm)
          const move = (ev: PointerEvent) => {
            const p = {
              x: clamp01((ev.clientX - rect.left) / rect.width),
              y: clamp01((ev.clientY - rect.top) / rect.height),
            }
            current = p
            setDrawCurr(p)
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            const pts = shapeFromBounds(drawShape, start.x, start.y, current.x, current.y)
            if (pts && pts.length >= 3) {
              onAddTarget(pts, `${shapeLabel(drawShape)} ${targets.length + 1}`)
            }
            setDrawStart(null)
            setDrawCurr(null)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polygon points={polygon} />
          {corners.map((c, i) => (
            <g key={i}>
              <circle cx={c.x * 100} cy={c.y * 100} r={2.4} />
              <text x={c.x * 100} y={c.y * 100 - 3}>
                {i + 1}
              </text>
            </g>
          ))}
          {targets.map((t) => (
            <polygon
              key={t.id}
              points={t.corners.map((c) => `${c.x * 100},${c.y * 100}`).join(' ')}
              className={t.id === selectedTargetId ? 'manual-target selected' : 'manual-target'}
            />
          ))}
          {polyPoints.length > 0 && (
            <polyline
              points={polyPoints.map((c) => `${c.x * 100},${c.y * 100}`).join(' ')}
              className="manual-target draft"
            />
          )}
          {draftPoly && (
            <polygon
              points={draftPoly.map((c) => `${c.x * 100},${c.y * 100}`).join(' ')}
              className="manual-target draft"
            />
          )}
        </svg>
        {mode === 'calibrate' &&
          corners.map((c, i) => (
          <div
            key={`h-${i}`}
            className="manual-handle"
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
            onPointerDown={(e) => {
              e.preventDefault()
              const el = e.currentTarget.parentElement
              if (!el) return
              const rect = el.getBoundingClientRect()
              const move = (ev: PointerEvent) => {
                const x = clamp01((ev.clientX - rect.left) / rect.width)
                const y = clamp01((ev.clientY - rect.top) / rect.height)
                onChangeCorner(i, { x, y })
              }
              const up = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
              move(e.nativeEvent)
            }}
          />
        ))}
      </div>

      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" onClick={onSave}>
          Save calibration
        </button>
        <button className="btn btn-ghost" onClick={onProjectNow}>
          Project now
        </button>
      </div>
      {mode === 'draw' && (
        <>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <select
              value={drawShape}
              onChange={(e) => setDrawShape(e.target.value as DrawShapeId)}
              style={{
                width: 190,
                padding: '7px 10px',
                borderRadius: 6,
                background: '#12151a',
                color: 'var(--text)',
                border: '1px solid var(--line)',
              }}
            >
              {DRAW_SHAPES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {DRAW_SHAPES.find((s) => s.id === drawShape)?.mode === 'click' && (
              <>
                <button
                  className="btn btn-primary"
                  disabled={polyPoints.length < 3}
                  onClick={() => {
                    onAddTarget(polyPoints, `${shapeLabel(drawShape)} ${targets.length + 1}`)
                    setPolyPoints([])
                  }}
                >
                  Close freeform ({polyPoints.length})
                </button>
                <button className="btn btn-ghost" onClick={() => setPolyPoints((p) => p.slice(0, -1))}>
                  Undo
                </button>
                <button className="btn btn-ghost" onClick={() => setPolyPoints([])}>
                  Clear
                </button>
              </>
            )}
          </div>
          <div className="device-list" style={{ marginTop: 10 }}>
            {targets.length === 0 && <p className="empty-hint">No targets yet. Draw on the canvas above.</p>}
            {targets.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  className={`device-row ${t.id === selectedTargetId ? 'connected' : ''}`}
                  style={{ width: '100%', textAlign: 'left', padding: 8 }}
                  onClick={() => onSelectTarget(t.id)}
                >
                  <div className="device-meta">
                    <strong>{t.label}</strong>
                    <span>{t.corners.length} pts</span>
                  </div>
                  {t.id === selectedTargetId && <span className="device-badge">Projected</span>}
                </button>
                <button className="btn btn-ghost" onClick={() => onDeleteTarget(t.id)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="empty-hint" style={{ marginTop: 8 }}>
        Content: {selectedMedia?.name ?? 'none selected'}
      </p>
    </div>
  )
}

