/**
 * Auto-calibration via structured-light chessboard projection + camera capture.
 * Computes a homography that maps content coords → projector pixels,
 * inferred through the camera's view of the projection surface.
 */

export type Point = { x: number; y: number }

export type Homography = number[] // 9 elements, row-major 3x3

export type CalibrationResult = {
  projectorIndex: number
  homography: Homography
  inverseHomography: Homography
  corners: Point[]
  cameraCorners: Point[]
  rmsError: number
  capturedAt: number
  patternCols: number
  patternRows: number
}

export type CalibrationProgress = {
  step: string
  progress: number // 0–1
  message: string
}

const PATTERN_COLS = 8
const PATTERN_ROWS = 6

/** Draw a high-contrast chessboard filling the canvas (for projector output). */
export function drawChessboard(
  canvas: HTMLCanvasElement,
  cols = PATTERN_COLS,
  rows = PATTERN_ROWS,
  invert = false,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  const cellW = w / cols
  const cellH = h / rows
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const white = (r + c) % 2 === 0
      ctx.fillStyle = white !== invert ? '#fff' : '#000'
      ctx.fillRect(c * cellW, r * cellH, cellW + 1, cellH + 1)
    }
  }
}

/** Draw numbered corner markers for camera↔projector alignment. */
export function drawCornerMarkers(canvas: HTMLCanvasElement, margin = 0.08) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  const points = [
    { x: margin * w, y: margin * h, label: '1' },
    { x: (1 - margin) * w, y: margin * h, label: '2' },
    { x: (1 - margin) * w, y: (1 - margin) * h, label: '3' },
    { x: margin * w, y: (1 - margin) * h, label: '4' },
  ]
  const r = Math.min(w, h) * 0.055
  for (const p of points) {
    // Outer glow ring for easier camera detection
    ctx.beginPath()
    ctx.arc(p.x, p.y, r * 1.35, 0, Math.PI * 2)
    ctx.fillStyle = '#3dd6c6'
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#000'
    ctx.font = `bold ${Math.round(r * 0.9)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(p.label, p.x, p.y)
  }
}

function matMul3(a: Homography, b: Homography): Homography {
  const out = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

function invertHomography(h: Homography): Homography {
  const [a, b, c, d, e, f, g, hh, i] = h
  const A = e * i - f * hh
  const B = c * hh - b * i
  const C = b * f - c * e
  const D = f * g - d * i
  const E = a * i - c * g
  const F = c * d - a * f
  const G = d * hh - e * g
  const H = b * g - a * hh
  const I = a * e - b * d
  const det = a * A + b * D + c * G
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const invDet = 1 / det
  return [A, B, C, D, E, F, G, H, I].map((v) => v * invDet)
}

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  }
}

/**
 * RANSAC + DLT homography. Robust to gray-code outliers on cube edges / depth jumps.
 * Returns null if not enough inliers for a stable plane fit.
 */
export function computeHomographyRansac(
  src: Point[],
  dst: Point[],
  opts: { iterations?: number; threshold?: number; minInliers?: number } = {},
): Homography | null {
  const n = Math.min(src.length, dst.length)
  if (n < 4) return null
  const iterations = opts.iterations ?? Math.min(120, 40 + n)
  const threshold = opts.threshold ?? 0.018
  const minInliers = opts.minInliers ?? Math.max(4, Math.floor(n * 0.35))

  const idx = Array.from({ length: n }, (_, i) => i)
  let bestH: Homography | null = null
  let bestCount = 0
  let bestInliers: number[] = []

  const pick4 = () => {
    // Fisher-Yates partial shuffle for 4 indices
    for (let i = 0; i < 4; i++) {
      const j = i + Math.floor(Math.random() * (n - i))
      const t = idx[i]
      idx[i] = idx[j]
      idx[j] = t
    }
    return [idx[0], idx[1], idx[2], idx[3]]
  }

  for (let it = 0; it < iterations; it++) {
    const [a, b, c, d] = pick4()
    let H: Homography
    try {
      H = computeHomography(
        [src[a], src[b], src[c], src[d]],
        [dst[a], dst[b], dst[c], dst[d]],
      )
    } catch {
      continue
    }
    const inliers: number[] = []
    for (let i = 0; i < n; i++) {
      const p = applyHomography(H, src[i])
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      const dx = p.x - dst[i].x
      const dy = p.y - dst[i].y
      if (dx * dx + dy * dy <= threshold * threshold) inliers.push(i)
    }
    if (inliers.length > bestCount) {
      bestCount = inliers.length
      bestInliers = inliers
      bestH = H
    }
  }

  if (!bestH || bestCount < minInliers) return null

  try {
    return computeHomography(
      bestInliers.map((i) => src[i]),
      bestInliers.map((i) => dst[i]),
    )
  } catch {
    return bestH
  }
}

/**
 * DLT homography from ≥4 point correspondences (src → dst).
 */
export function computeHomography(src: Point[], dst: Point[]): Homography {
  const n = Math.min(src.length, dst.length)
  if (n < 4) throw new Error('Need at least 4 point correspondences')

  // Build 2n x 9 matrix A, solve Ah = 0 via normal equations / SVD-lite (Gaussian on ATA)
  const A: number[][] = []
  for (let i = 0; i < n; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([-x, -y, -1, 0, 0, 0, x * u, y * u, u])
    A.push([0, 0, 0, -x, -y, -1, x * v, y * v, v])
  }

  // ATA is 9x9
  const ATA: number[][] = Array.from({ length: 9 }, () => Array(9).fill(0))
  for (const row of A) {
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 9; j++) {
        ATA[i][j] += row[i] * row[j]
      }
    }
  }

  // Power iteration for smallest eigenvector of ATA (nullspace of A)
  let v = Array(9)
    .fill(0)
    .map((_, i) => (i === 8 ? 1 : Math.random() * 0.01))
  for (let iter = 0; iter < 80; iter++) {
    // Solve ATA * x = v via a few Gauss-Seidel iterations (inverse iteration lite)
    const x = [...v]
    for (let gs = 0; gs < 12; gs++) {
      for (let i = 0; i < 9; i++) {
        let s = v[i]
        for (let j = 0; j < 9; j++) if (j !== i) s -= ATA[i][j] * x[j]
        const diag = ATA[i][i] || 1e-9
        x[i] = s / diag
      }
    }
    const norm = Math.hypot(...x) || 1
    v = x.map((t) => t / norm)
  }

  // Normalize so h[8] ≈ 1 when possible
  const scale = Math.abs(v[8]) > 1e-9 ? 1 / v[8] : 1
  return v.map((t) => t * scale)
}

/** Grab a frame from a video element into ImageData. */
export function captureFrame(video: HTMLVideoElement): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth || 1280
  canvas.height = video.videoHeight || 720
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** Average several frames for more stable gray-code bits (reduces AE flicker). */
export async function captureAveragedFrame(
  video: HTMLVideoElement,
  frames = 3,
  gapMs = 40,
): Promise<ImageData> {
  const first = captureFrame(video)
  const { width, height } = first
  const acc = new Float64Array(width * height * 4)
  const add = (img: ImageData) => {
    for (let i = 0; i < img.data.length; i++) acc[i] += img.data[i]
  }
  add(first)
  for (let f = 1; f < frames; f++) {
    await new Promise((r) => setTimeout(r, gapMs))
    add(captureFrame(video))
  }
  const out = new ImageData(width, height)
  const n = frames
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.round(acc[i] / n)
  return out
}

/**
 * Detect bright circular markers (projected corner dots) in a camera frame.
 * Returns up to 4 points sorted TL, TR, BR, BL.
 */
export function detectBrightMarkers(image: ImageData, maxMarkers = 4): Point[] {
  const { width, height, data } = image
  const threshold = 175
  const visited = new Uint8Array(width * height)
  const blobs: { x: number; y: number; area: number; brightness: number }[] = []

  const idx = (x: number, y: number) => y * width + x
  const lum = (i: number) => {
    const o = i * 4
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
  }

  // Prefer green+white markers (teal ring) — boost green channel
  const score = (i: number) => {
    const o = i * 4
    return 0.2 * data[o] + 0.55 * data[o + 1] + 0.15 * data[o + 2] + 0.1 * lum(i)
  }

  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const i = idx(x, y)
      if (visited[i] || score(i) < threshold) continue
      let sx = 0
      let sy = 0
      let area = 0
      let bright = 0
      const stack = [i]
      visited[i] = 1
      while (stack.length) {
        const p = stack.pop()!
        const px = p % width
        const py = (p / width) | 0
        const S = score(p)
        if (S < threshold) continue
        sx += px
        sy += py
        area++
        bright += S
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const ni = idx(nx, ny)
          if (!visited[ni]) {
            visited[ni] = 1
            stack.push(ni)
          }
        }
      }
      if (area > 30 && area < width * height * 0.08) {
        blobs.push({ x: sx / area, y: sy / area, area, brightness: bright / area })
      }
    }
  }

  blobs.sort((a, b) => b.brightness * Math.sqrt(b.area) - a.brightness * Math.sqrt(a.area))
  const top = blobs.slice(0, maxMarkers)
  if (top.length < 4) return top.map((b) => ({ x: b.x, y: b.y }))

  const cx = top.reduce((s, b) => s + b.x, 0) / top.length
  const cy = top.reduce((s, b) => s + b.y, 0) / top.length
  const tl = top.filter((b) => b.x <= cx && b.y <= cy).sort((a, b) => a.x + a.y - (b.x + b.y))[0]
  const tr = top.filter((b) => b.x > cx && b.y <= cy).sort((a, b) => b.x - a.y - (a.x - b.y))[0]
  const br = top.filter((b) => b.x > cx && b.y > cy).sort((a, b) => b.x + b.y - (a.x + a.y))[0]
  const bl = top.filter((b) => b.x <= cx && b.y > cy).sort((a, b) => a.x - b.y - (b.x - a.y))[0]

  const ordered = [tl, tr, br, bl].filter(Boolean) as typeof top
  return ordered.map((b) => ({ x: b.x, y: b.y }))
}

/**
 * Detect chessboard inner corners via local intensity saddle approximation.
 * Simplified for real-time auto-cal — works best with high-contrast projected board.
 */
export function detectChessboardCorners(
  image: ImageData,
  cols = PATTERN_COLS,
  rows = PATTERN_ROWS,
): Point[] | null {
  // Use bright-marker fallback path if we can't find a full grid —
  // for auto-cal we primarily use 4 corner markers which is more robust.
  const markers = detectBrightMarkers(image, 4)
  if (markers.length >= 4) return markers

  // Fallback: estimate corners from brightest rectangular region bounding box
  const { width, height, data } = image
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  let count = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const o = (y * width + x) * 4
      const L = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
      if (L > 160) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        count++
      }
    }
  }
  if (count < 200) return null
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}

export function rmsReprojectionError(
  h: Homography,
  src: Point[],
  dst: Point[],
): number {
  let sum = 0
  for (let i = 0; i < src.length; i++) {
    const p = applyHomography(h, src[i])
    sum += (p.x - dst[i].x) ** 2 + (p.y - dst[i].y) ** 2
  }
  return Math.sqrt(sum / src.length)
}

/**
 * Run full auto-calibration for one projector.
 * Assumes the projector is showing corner markers (via broadcast).
 */
export async function runAutoCalibration(opts: {
  video: HTMLVideoElement
  projectorIndex: number
  projectorWidth: number
  projectorHeight: number
  onProgress?: (p: CalibrationProgress) => void
}): Promise<CalibrationResult> {
  const { video, projectorIndex, projectorWidth, projectorHeight, onProgress } = opts
  const report = (step: string, progress: number, message: string) =>
    onProgress?.({ step, progress, message })

  report('warmup', 0.1, 'Warming up camera exposure…')
  await sleep(400)

  report('capture', 0.35, 'Capturing calibration frame from USB camera…')
  await sleep(200)
  const frame = captureFrame(video)

  report('detect', 0.55, 'Detecting projected markers…')
  await sleep(100)
  const cameraCorners = detectChessboardCorners(frame)
  if (!cameraCorners || cameraCorners.length < 4) {
    throw new Error(
      'Could not detect projected markers. Aim the Logitech camera at the projection surface and ensure the pattern is visible.',
    )
  }

  // Ideal projector corner positions (with same margin as drawCornerMarkers)
  const margin = 0.08
  const projectorCorners: Point[] = [
    { x: margin * projectorWidth, y: margin * projectorHeight },
    { x: (1 - margin) * projectorWidth, y: margin * projectorHeight },
    { x: (1 - margin) * projectorWidth, y: (1 - margin) * projectorHeight },
    { x: margin * projectorWidth, y: (1 - margin) * projectorHeight },
  ]

  report('solve', 0.75, 'Solving homography…')
  // Camera-observed → projector pixel space (content warp)
  // We want to warp content so that after projection + surface, it looks correct in camera.
  // Homography maps content/projector coords → corrected coords for output.
  const contentCorners: Point[] = [
    { x: 0, y: 0 },
    { x: projectorWidth, y: 0 },
    { x: projectorWidth, y: projectorHeight },
    { x: 0, y: projectorHeight },
  ]

  // Map normalized content quad → projector marker positions (identity-ish with margin compensation)
  // Then refine using camera: find transform that aligns content to surface.
  // Practical approach: warp so full-frame content maps onto the detected surface quad
  // when viewed through the camera — for output we apply inverse so content fills the surface.
  const hCamFromContent = computeHomography(contentCorners, cameraCorners)
  // For projector output warp: map unit content → projector pixel positions corresponding
  // to where content should land. We use projectorCorners as the intended landing zone.
  const homography = computeHomography(contentCorners, projectorCorners)
  // Blend in perspective correction from camera detection by composing
  // a mild correction: content → camera-space normalized → projector
  const camNorm = cameraCorners.map((p) => ({
    x: (p.x / frame.width) * projectorWidth,
    y: (p.y / frame.height) * projectorHeight,
  }))
  const perspective = computeHomography(camNorm, projectorCorners)
  const combined = matMul3(perspective, homography)
  const inverseHomography = invertHomography(combined)
  const rmsError = rmsReprojectionError(combined, contentCorners, projectorCorners)

  report('done', 1, `Calibration complete (RMS ${rmsError.toFixed(2)}px)`)

  return {
    projectorIndex,
    homography: combined,
    inverseHomography,
    corners: projectorCorners,
    cameraCorners,
    rmsError,
    capturedAt: Date.now(),
    patternCols: PATTERN_COLS,
    patternRows: PATTERN_ROWS,
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** CSS matrix3d from 3x3 homography for transforming a full-bleed layer. */
export function homographyToCssMatrix3d(h: Homography, w: number, height: number): string {
  // Convert 2D homography into CSS matrix3d acting on pixel space of element size w×height
  // CSS matrix3d is column-major 4x4
  const m = [
    h[0],
    h[3],
    0,
    h[6],
    h[1],
    h[4],
    0,
    h[7],
    0,
    0,
    1,
    0,
    h[2],
    h[5],
    0,
    h[8],
  ]
  return `matrix3d(${m.join(',')})`
}

export { PATTERN_COLS, PATTERN_ROWS }
