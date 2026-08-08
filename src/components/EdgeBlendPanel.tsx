import { useEffect, useRef } from 'react'
import type { BlendConfig } from '../lib/blending'
import { DEFAULT_BLEND } from '../lib/blending'

type Props = {
  config: BlendConfig
  onChange: (cfg: BlendConfig) => void
  projectorCount: number
}

export function EdgeBlendPanel({ config, onChange, projectorCount }: Props) {
  const leftRef = useRef<HTMLCanvasElement>(null)
  const rightRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    import('../lib/blending').then(({ drawBlendPreview }) => {
      if (leftRef.current) {
        leftRef.current.width = 280
        leftRef.current.height = 36
        drawBlendPreview(leftRef.current, config, 'left')
      }
      if (rightRef.current) {
        rightRef.current.width = 280
        rightRef.current.height = 36
        drawBlendPreview(rightRef.current, config, 'right')
      }
    })
  }, [config])

  const disabled = projectorCount < 2
  const withDefaults: BlendConfig = {
    ...DEFAULT_BLEND,
    ...config,
    swapSides: config.swapSides ?? false,
    leftGain: config.leftGain ?? 1,
    rightGain: config.rightGain ?? 1,
  }

  const status =
    disabled ? 'Need 2 projectors' : withDefaults.enabled ? 'On' : 'Off'

  return (
    <details className="advanced-details edge-blend-details">
      <summary>
        <span className="details-chevron" aria-hidden>
          ▸
        </span>
        <span>Edge blending</span>
        <span className={`details-status ${withDefaults.enabled && !disabled ? 'on' : ''}`}>
          {status}
        </span>
      </summary>

      <div className="edge-blend-body">
        <p className="sub">
          Soft seam for two projectors (works with different brands — e.g. Acer + Casio). Match Windows
          order to the wall with Swap sides; balance brightness if one lamp is brighter.
        </p>

        {disabled && (
          <p className="empty-hint" style={{ textAlign: 'left', padding: '0 0 12px' }}>
            Connect and open two projector outputs to enable blending.
          </p>
        )}

        <label className="step" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={withDefaults.enabled}
            disabled={disabled}
            onChange={(e) => onChange({ ...withDefaults, enabled: e.target.checked })}
          />
          Enable edge blend
        </label>

        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onChange({ ...withDefaults, swapSides: !withDefaults.swapSides })}
          >
            {withDefaults.swapSides ? 'Sides swapped — click to restore' : 'Swap left / right'}
          </button>
        </div>

        <div className="slider-row">
          <span>Overlap</span>
          <input
            type="range"
            min={0.05}
            max={0.4}
            step={0.01}
            value={withDefaults.overlap}
            disabled={disabled || !withDefaults.enabled}
            onChange={(e) => onChange({ ...withDefaults, overlap: Number(e.target.value) })}
          />
          <span className="val">{Math.round(withDefaults.overlap * 100)}%</span>
        </div>
        <div className="slider-row">
          <span>Gamma</span>
          <input
            type="range"
            min={1}
            max={3.5}
            step={0.05}
            value={withDefaults.gamma}
            disabled={disabled || !withDefaults.enabled}
            onChange={(e) => onChange({ ...withDefaults, gamma: Number(e.target.value) })}
          />
          <span className="val">{withDefaults.gamma.toFixed(2)}</span>
        </div>
        <div className="slider-row">
          <span>Softness</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={withDefaults.softness}
            disabled={disabled || !withDefaults.enabled}
            onChange={(e) => onChange({ ...withDefaults, softness: Number(e.target.value) })}
          />
          <span className="val">{withDefaults.softness.toFixed(2)}</span>
        </div>
        <div className="slider-row">
          <span>Left gain</span>
          <input
            type="range"
            min={0.4}
            max={1.2}
            step={0.02}
            value={withDefaults.leftGain}
            disabled={disabled}
            onChange={(e) => onChange({ ...withDefaults, leftGain: Number(e.target.value) })}
          />
          <span className="val">{withDefaults.leftGain.toFixed(2)}</span>
        </div>
        <div className="slider-row">
          <span>Right gain</span>
          <input
            type="range"
            min={0.4}
            max={1.2}
            step={0.02}
            value={withDefaults.rightGain}
            disabled={disabled}
            onChange={(e) => onChange({ ...withDefaults, rightGain: Number(e.target.value) })}
          />
          <span className="val">{withDefaults.rightGain.toFixed(2)}</span>
        </div>

        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <div>
            <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>Left projector mask</span>
            <canvas ref={leftRef} style={{ width: '100%', height: 36, borderRadius: 6, display: 'block' }} />
          </div>
          <div>
            <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>Right projector mask</span>
            <canvas ref={rightRef} style={{ width: '100%', height: 36, borderRadius: 6, display: 'block' }} />
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onChange({ ...DEFAULT_BLEND, enabled: true })}
          >
            Reset defaults
          </button>
        </div>
      </div>
    </details>
  )
}
