import type { AudioDevice, CameraDevice } from '../lib/camera'
import type { DisplayInfo } from '../../electron/preload'
import type { AppEvent } from '../lib/types'
import { extractModelHint, friendlyDisplayName, isVrPhantomDisplay } from '../lib/displayNames'

type Props = {
  displays: DisplayInfo[]
  cameras: CameraDevice[]
  audioDevices?: AudioDevice[]
  selectedCameraId: string | null
  onSelectCamera: (id: string) => void
  activeProjectorIds: Set<number>
  onOpenProjector: (display: DisplayInfo, index: number) => void
  onCloseProjector: (displayId: number) => void
  events: AppEvent[]
  cameraScanning: boolean
  onRefreshCameras: () => void
  onRefreshAudio?: () => void
  audioScanning?: boolean
  showVirtualCameras?: boolean
  onShowVirtualCamerasChange?: (show: boolean) => void
  showAllAudio?: boolean
  onShowAllAudioChange?: (show: boolean) => void
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

function SpeakerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 9v6h3l5 4V5L7 9H4z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 9.5a3.5 3.5 0 010 5M18 7a6 6 0 010 10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function shortId(id: string | undefined | null): string | null {
  if (!id) return null
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

function displayDetailLine(d: DisplayInfo): string {
  const bits: string[] = []
  if (d.isPrimary) bits.push('Laptop · control')
  else bits.push('Display')
  bits.push(`${d.size.width}×${d.size.height}`)
  if (!d.isPrimary) {
    bits.push(d.size.width / d.size.height < 1.4 ? '4:3/XGA-like' : 'widescreen')
  }
  const model = d.model || extractModelHint(d.label)
  if (model && model.toLowerCase() !== d.label.toLowerCase()) bits.push(`model ${model}`)
  if (d.manufacturer) bits.push(d.manufacturer)
  if (d.serial) bits.push(`S/N ${d.serial}`)
  return bits.join(' · ')
}

function cameraDetailLine(c: CameraDevice): string {
  const bits: string[] = ['Camera']
  if (c.isLogitech) bits.push('Logitech USB · preferred')
  else if (c.isBuiltin) bits.push('Built-in · skipped for cal')
  else if (c.isVirtual) bits.push('Virtual · OS-reported')
  else bits.push('External')
  if (c.model) bits.push(`model ${c.model}`)
  const gid = shortId(c.groupId)
  if (gid) bits.push(`group ${gid}`)
  return bits.join(' · ')
}

function audioDetailLine(a: AudioDevice): string {
  const bits: string[] = [a.kind === 'audiooutput' ? 'Speaker' : 'Microphone']
  if (a.isDefault) bits.push('System default')
  else if (a.isCommunications) bits.push('Communications')
  if (a.isClutter) bits.push('Clutter')
  if (a.model) bits.push(`model ${a.model}`)
  const gid = shortId(a.groupId)
  if (gid) bits.push(`group ${gid}`)
  return bits.join(' · ')
}

export function DevicePanel({
  displays,
  cameras,
  audioDevices = [],
  selectedCameraId,
  onSelectCamera,
  activeProjectorIds,
  onOpenProjector,
  onCloseProjector,
  events,
  cameraScanning,
  onRefreshCameras,
  onRefreshAudio,
  audioScanning = false,
  showVirtualCameras = false,
  onShowVirtualCamerasChange,
  showAllAudio = false,
  onShowAllAudioChange,
  cameraZoom = 1,
  onCameraZoom,
  projectorModeByDisplayId = {},
  onSetProjectorMode,
  activeCameraControlDisplayId = null,
  onSetActiveCameraControlDisplayId,
}: Props) {
  const projectors = displays.filter(
    (d) => !d.isPrimary && !isVrPhantomDisplay(d.label, d.model, d.manufacturer),
  )
  const primary = displays.find((d) => d.isPrimary)
  const speakers = audioDevices.filter((a) => a.kind === 'audiooutput')
  const mics = audioDevices.filter((a) => a.kind === 'audioinput')
  const visibleCameras = showVirtualCameras ? cameras : cameras.filter((c) => !c.isVirtual)

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
                <span>{displayDetailLine(primary)}</span>
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
            const title = friendlyDisplayName(d.label, i)
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
                    {displayDetailLine(d)}
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
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '6px 10px', fontSize: 12 }}
                        onClick={() => onOpenProjector(d, i)}
                      >
                        Open output
                      </button>
                    ) : (
                      <button
                        className="btn btn-danger"
                        style={{ padding: '6px 10px', fontSize: 12 }}
                        onClick={() => onCloseProjector(d.id)}
                      >
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
          <button
            className="btn btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12 }}
            onClick={onRefreshCameras}
            disabled={cameraScanning}
          >
            {cameraScanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        {onShowVirtualCamerasChange && (
          <label className="empty-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={showVirtualCameras}
              onChange={(e) => onShowVirtualCamerasChange(e.target.checked)}
            />
            Show virtual cameras
          </label>
        )}
        <div className="device-list">
          {visibleCameras.length === 0 && (
            <p className="empty-hint">
              {showVirtualCameras
                ? 'No cameras found. Plug in your Logitech USB camera.'
                : 'No usable cameras found. Plug in your Logitech USB camera.'}
            </p>
          )}
          {visibleCameras.map((c) => {
            const selected = c.deviceId === selectedCameraId
            return (
              <button
                key={c.deviceId}
                type="button"
                className={`device-row ${selected ? 'connected' : ''} ${c.isBuiltin || c.isVirtual ? 'disconnected' : ''}`}
                onClick={() => onSelectCamera(c.deviceId)}
                style={{ textAlign: 'left', width: '100%' }}
              >
                <div className="device-icon">
                  <CameraIcon />
                </div>
                <div className="device-meta">
                  <strong>{c.label}</strong>
                  <span>{cameraDetailLine(c)}</span>
                </div>
                {c.isLogitech && <span className="device-badge">USB</span>}
                {c.isVirtual && <span className="device-badge off">Virtual</span>}
                {c.isBuiltin && !c.isVirtual && <span className="device-badge off">Skip</span>}
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
        <h3 className="panel-title">Audio</h3>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button
            className="btn btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12 }}
            onClick={() => onRefreshAudio?.()}
            disabled={audioScanning || !onRefreshAudio}
          >
            {audioScanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        {onShowAllAudioChange && (
          <label className="empty-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={showAllAudio}
              onChange={(e) => onShowAllAudioChange(e.target.checked)}
            />
            Show all audio devices
          </label>
        )}
        <div className="device-list">
          {audioDevices.length === 0 && (
            <p className="empty-hint">
              {showAllAudio
                ? 'No audio devices reported by the OS yet.'
                : 'No default audio endpoints yet. Enable “Show all” if needed.'}
            </p>
          )}
          {[...speakers, ...mics].map((a) => (
            <div
              key={`${a.kind}-${a.deviceId}`}
              className={`device-row ${a.isClutter ? 'disconnected' : 'connected'}`}
            >
              <div className="device-icon">
                <SpeakerIcon />
              </div>
              <div className="device-meta">
                <strong>{a.label}</strong>
                <span>{audioDetailLine(a)}</span>
              </div>
              <span className={`device-badge ${a.isClutter ? 'off' : ''}`}>
                {a.isDefault ? 'Default' : a.isCommunications ? 'Comm' : a.kind === 'audiooutput' ? 'Out' : 'In'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="panel-title">Live events</h3>
        <div className="event-feed">
          {events.length === 0 && <p className="empty-hint">Waiting for device changes…</p>}
          {events.map((e) => (
            <div
              key={e.id}
              className={`event-item ${e.kind === 'disconnect' || e.kind === 'danger' ? 'danger' : e.kind === 'warn' ? 'warn' : ''}`}
            >
              {new Date(e.at).toLocaleTimeString()} — {e.message}
            </div>
          ))}
        </div>
      </section>
    </aside>
  )
}
