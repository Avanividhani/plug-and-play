import type { CameraDevice } from '../lib/camera'
import type { DisplayInfo } from '../../electron/preload'
import type { AppEvent } from '../lib/types'

type Props = {
  displays: DisplayInfo[]
  cameras: CameraDevice[]
  selectedCameraId: string | null
  onSelectCamera: (id: string) => void
  activeProjectorIds: Set<number>
  onOpenProjector: (display: DisplayInfo, index: number) => void
  onCloseProjector: (displayId: number) => void
  events: AppEvent[]
  cameraScanning: boolean
  onRefreshCameras: () => void
  cameraZoom?: number
  onCameraZoom?: (zoom: number) => void
  projectorModeByDisplayId?: Record<number, 'camera' | 'manual'>
  onSetProjectorMode?: (displayId: number, mode: 'camera' | 'manual') => void
  activeCameraControlDisplayId?: number | null
  onSetActiveCameraControlDisplayId?: (displayId: number) => void
}

function DisplayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 20h8M12 17v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8h3l2-2h6l2 2h3v11H4V8z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

export function DevicePanel({
  displays,
  cameras,
  selectedCameraId,
  onSelectCamera,
  activeProjectorIds,
  onOpenProjector,
  onCloseProjector,
  events,
  cameraScanning,
  onRefreshCameras,
  cameraZoom = 1,
  onCameraZoom,
  projectorModeByDisplayId = {},
  onSetProjectorMode,
  activeCameraControlDisplayId = null,
  onSetActiveCameraControlDisplayId,
}: Props) {
  const projectors = displays.filter((d) => !d.isPrimary)
  const primary = displays.find((d) => d.isPrimary)
  const friendlyProjectorName = (label: string | undefined, index: number) => {
    const raw = (label || '').trim()
    if (!raw || /^display\s*\d+$/i.test(raw)) return `Projector ${index + 1}`
    const vendor = raw.match(/\b(acer|epson|benq|optoma|sony|lg|samsung|viewsonic)\b/i)?.[1]
    if (vendor) return `${vendor.charAt(0).toUpperCase()}${vendor.slice(1).toLowerCase()} projector`
    return raw
  }

  return (
    <aside className="side-panel">
      <section>
        <h3 className="panel-title">Displays / Projectors</h3>
        <div className="device-list">
          {primary && (
            <div className="device-row connected">
              <div className="device-icon">
                <DisplayIcon />
              </div>
              <div className="device-meta">
                <strong>{primary.label || 'Primary display'}</strong>
                <span>
                  Laptop · {primary.size.width}×{primary.size.height} · control
                </span>
              </div>
              <span className="device-badge">Primary</span>
            </div>
          )}
          {projectors.length === 0 && (
            <p className="empty-hint">No projectors detected. Connect a projector via HDMI/USB-C.</p>
          )}
          {projectors.map((d, i) => {
            const open = activeProjectorIds.has(d.id)
            const multi = projectors.length >= 2
            const sideLabel = multi ? (i === 0 ? 'Left' : i === 1 ? 'Right' : `P${i + 1}`) : null
            const title = friendlyProjectorName(d.label, i)
            return (
              <div key={d.id} className={`device-row ${open ? 'connected' : ''}`}>
                <div className="device-icon">
                  <DisplayIcon />
                </div>
                <div className="device-meta">
                  <strong>
                    {title}
                    {sideLabel ? ` · ${sideLabel}` : ''}
                  </strong>
                  <span>
                    {d.size.width}×{d.size.height}
                    {d.size.width / d.size.height < 1.4 ? ' · 4:3/XGA-like' : ' · widescreen'}
                    {open && activeProjectorIds.size >= 2 ? ' · soft-edge' : ''}
                  </span>
                  {onSetProjectorMode && (
                    <div style={{ marginTop: 8 }}>
                      <label className="empty-hint" style={{ display: 'block', marginBottom: 4 }}>
                        Calibration mode
                      </label>
                      <select
                        value={projectorModeByDisplayId[d.id] ?? 'camera'}
                        onChange={(e) =>
                          onSetProjectorMode(
                            d.id,
                            e.target.value === 'manual' ? 'manual' : 'camera',
                          )
                        }
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: '#12151a',
                          color: 'var(--text)',
                          border: '1px solid var(--line)',
                          fontSize: 12,
                        }}
                      >
                        <option value="camera">Projector 1 · Camera auto-calibration</option>
                        <option value="manual">Projector 2 · Manual (no camera)</option>
                      </select>
                    </div>
                  )}
                  <div className="btn-row" style={{ marginTop: 8 }}>
                    {onSetActiveCameraControlDisplayId &&
                      (projectorModeByDisplayId[d.id] ?? 'camera') === 'camera' && (
                        <button
                          className={`btn ${
                            activeCameraControlDisplayId === d.id ? 'btn-primary' : 'btn-ghost'
                          }`}
                          style={{ padding: '6px 10px', fontSize: 12 }}
                          onClick={() => onSetActiveCameraControlDisplayId(d.id)}
                        >
                          {activeCameraControlDisplayId === d.id ? 'Using controls' : 'Use controls'}
                        </button>
                      )}
                    {!open ? (
                      <button className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => onOpenProjector(d, i)}>
                        Open output
                      </button>
                    ) : (
                      <button className="btn btn-danger" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => onCloseProjector(d.id)}>
                        Close
                      </button>
                    )}
                  </div>
                </div>
                <span className={`device-badge ${open ? '' : 'off'}`}>{open ? 'Live' : 'Idle'}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <h3 className="panel-title">Cameras</h3>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={onRefreshCameras} disabled={cameraScanning}>
            {cameraScanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        <div className="device-list">
          {cameras.length === 0 && <p className="empty-hint">No cameras found. Plug in your Logitech USB camera.</p>}
          {cameras.map((c) => {
            const selected = c.deviceId === selectedCameraId
            return (
              <button
                key={c.deviceId}
                type="button"
                className={`device-row ${selected ? 'connected' : ''} ${c.isBuiltin ? 'disconnected' : ''}`}
                onClick={() => onSelectCamera(c.deviceId)}
                style={{ textAlign: 'left', width: '100%' }}
              >
                <div className="device-icon">
                  <CameraIcon />
                </div>
                <div className="device-meta">
                  <strong>{c.label}</strong>
                  <span>
                    {c.isLogitech ? 'Logitech USB · preferred' : c.isBuiltin ? 'Built-in · skipped for cal' : 'External'}
                  </span>
                </div>
                {c.isLogitech && <span className="device-badge">USB</span>}
                {c.isBuiltin && <span className="device-badge off">Skip</span>}
              </button>
            )
          })}
        </div>
        {onCameraZoom && (
          <div className="slider-row" style={{ marginTop: 12, padding: '0 2px' }}>
            <span style={{ minWidth: 40 }}>Zoom</span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={cameraZoom}
              onChange={(e) => onCameraZoom(Number(e.target.value))}
              title="Zoom camera preview"
            />
            <span className="val">{cameraZoom.toFixed(2)}×</span>
          </div>
        )}
      </section>

      <section>
        <h3 className="panel-title">Live events</h3>
        <div className="event-feed">
          {events.length === 0 && <p className="empty-hint">Waiting for device changes…</p>}
          {events.map((e) => (
            <div key={e.id} className={`event-item ${e.kind === 'disconnect' || e.kind === 'danger' ? 'danger' : e.kind === 'warn' ? 'warn' : ''}`}>
              {new Date(e.at).toLocaleTimeString()} — {e.message}
            </div>
          ))}
        </div>
      </section>
    </aside>
  )
}
