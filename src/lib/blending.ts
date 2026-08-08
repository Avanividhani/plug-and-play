/** Edge blending for overlapping dual-projector setups. */

export type BlendConfig = {
  /** Overlap width as fraction of each projector width (0–0.5) */
  overlap: number
  /** Gamma for blend falloff (typical 2.2) */
  gamma: number
  /** Softness of the blend ramp */
  softness: number
  enabled: boolean
  /** Swap which output is treated as physical left vs right (mixed brands / Windows order) */
  swapSides: boolean
  /** Dim/boost left output (different lumen brands) */
  leftGain: number
  /** Dim/boost right output */
  rightGain: number
}

export const DEFAULT_BLEND: BlendConfig = {
  overlap: 0.18,
  gamma: 2.2,
  softness: 1,
  enabled: true,
  swapSides: false,
  leftGain: 1,
  rightGain: 1,
}

/** Intensity 0–1 across normalized x in [0,1] for left or right projector. */
export function blendWeight(
  xNorm: number,
  side: 'left' | 'right',
  cfg: BlendConfig,
): number {
  if (!cfg.enabled || cfg.overlap <= 0) return 1
  const o = Math.min(0.49, Math.max(0.01, cfg.overlap))
  let w = 1

  if (side === 'left') {
    // Fade out on the right edge
    if (xNorm < 1 - o) w = 1
    else {
      const t = (xNorm - (1 - o)) / o
      w = 1 - smoothstep(0, 1, t)
    }
  } else {
    // Fade out on the left edge
    if (xNorm > o) w = 1
    else {
      const t = xNorm / o
      w = smoothstep(0, 1, t)
    }
  }

  // Apply gamma so perceived brightness is linear across the seam
  return Math.pow(Math.max(0, Math.min(1, w)), 1 / Math.max(0.5, cfg.gamma * cfg.softness))
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Draw a horizontal luminance ramp preview into a canvas. */
export function drawBlendPreview(
  canvas: HTMLCanvasElement,
  cfg: BlendConfig,
  side: 'left' | 'right',
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  const img = ctx.createImageData(w, h)
  for (let x = 0; x < w; x++) {
    const weight = blendWeight(x / (w - 1), side, cfg)
    const v = Math.round(weight * 255)
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * Apply edge-blend as a CSS linear-gradient mask / canvas multiply overlay.
 * Returns CSS for mask-image on the content layer.
 */
export function blendMaskCss(side: 'left' | 'right', cfg: BlendConfig): string {
  if (!cfg.enabled) return 'none'
  const o = Math.round(cfg.overlap * 100)
  if (side === 'left') {
    return `linear-gradient(90deg, #fff 0%, #fff ${100 - o}%, transparent 100%)`
  }
  return `linear-gradient(90deg, transparent 0%, #fff ${o}%, #fff 100%)`
}
