import { captureFrame, computeHomography, type Homography, type Point } from './calibration'

export type NormPoint = { x: number; y: number }

export type DetectedSurface = {
  id: string
  label: string
  /** 3+ points — rectangle (4) or custom polygon */
  corners: NormPoint[]
  area: number
  confidence: number
  source: 'auto' | 'manual'
  /** Content library item id assigned to this target (optional) */
  mediaId?: string | null
}

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function quad(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [NormPoint, NormPoint, NormPoint, NormPoint] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

function areaOf(corners: NormPoint[]) {
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
}

function makeSurface(
  label: string,
  corners: NormPoint[],
  source: 'auto' | 'manual',
  confidence = 0.7,
): DetectedSurface {
  return {
    id: uid('surf'),
    label,
    corners,
    area: areaOf(corners),
    confidence,
    source,
  }
}

/** Always-available zones so Scan never returns empty. */
export function presetSurfaces(): DetectedSurface[] {
  return [
    makeSurface('Center', quad(0.2, 0.2, 0.8, 0.8), 'auto', 0.9),
    makeSurface('Table / lower', quad(0.12, 0.45, 0.88, 0.92), 'auto', 0.85),
    makeSurface('Wall / upper', quad(0.12, 0.08, 0.88, 0.48), 'auto', 0.8),
    makeSurface('Left', quad(0.05, 0.15, 0.45, 0.85), 'auto', 0.75),
    makeSurface('Right', quad(0.55, 0.15, 0.95, 0.85), 'auto', 0.75),
  ]
}

/** Click on the camera view → a tweakable box around that spot. */
export function surfaceFromClick(p: NormPoint, label = 'Target'): DetectedSurface {
  const halfW = 0.18
  const halfH = 0.14
  const x0 = Math.max(0.02, Math.min(0.98 - halfW * 2, p.x - halfW))
  const y0 = Math.max(0.02, Math.min(0.98 - halfH * 2, p.y - halfH))
  return makeSurface(label, quad(x0, y0, x0 + halfW * 2, y0 + halfH * 2), 'manual', 1)
}

export function createManualSurface(corners: NormPoint[], label = 'Custom'): DetectedSurface {
  return makeSurface(label, corners, 'manual', 1)
}

/**
 * Simple scan: find a few brighter / darker blobs if possible,
 * then always merge with presets so the user always has choices.
 */
export function detectSurfaces(image: ImageData, maxSurfaces = 8): DetectedSurface[] {
  const found = findBlobSurfaces(image, 4)
  const presets = presetSurfaces()

  // Prefer detected blobs first, then fill with presets that don't overlap heavily
  const out: DetectedSurface[] = [...found]
  for (const p of presets) {
    if (out.length >= maxSurfaces) break
    const overlaps = out.some((s) => centersClose(s, p, 0.15))
    if (!overlaps) out.push(p)
  }
  if (out.length === 0) return presets
  return out.slice(0, maxSurfaces)
}

export function detectSurfacesFromVideo(video: HTMLVideoElement, maxSurfaces = 8): DetectedSurface[] {
  try {
    if (!video.videoWidth || !video.videoHeight) return presetSurfaces()
    const frame = captureFrame(video)
    return detectSurfaces(frame, maxSurfaces)
  } catch {
    return presetSurfaces()
  }
}

function centersClose(a: DetectedSurface, b: DetectedSurface, thresh: number) {
  const ca = center(a.corners)
  const cb = center(b.corners)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y) < thresh
}

function center(corners: NormPoint[]) {
  return {
    x: corners.reduce((s, c) => s + c.x, 0) / corners.length,
    y: corners.reduce((s, c) => s + c.y, 0) / corners.length,
  }
}

function findBlobSurfaces(image: ImageData, maxBlobs: number): DetectedSurface[] {
  const { width, height, data } = image
  const step = Math.max(2, Math.floor(Math.min(width, height) / 160))
  const w = Math.floor(width / step)
  const h = Math.floor(height / step)
  const gray = new Float32Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (Math.min(height - 1, y * step) * width + Math.min(width - 1, x * step)) * 4
      gray[y * w + x] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
    }
  }

  // Local contrast map — surfaces often differ from neighbors
  const contrast = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v = gray[i]
      contrast[i] =
        Math.abs(v - gray[i - 1]) +
        Math.abs(v - gray[i + 1]) +
        Math.abs(v - gray[i - w]) +
        Math.abs(v - gray[i + w])
    }
  }

  // Grow low-contrast regions (flat surfaces)
  const visited = new Uint8Array(w * h)
  const regions: { minX: number; minY: number; maxX: number; maxY: number; area: number; mean: number }[] =
    []

  const flatThresh = 28
  for (let y = 2; y < h - 2; y += 3) {
    for (let x = 2; x < w - 2; x += 3) {
      const start = y * w + x
      if (visited[start] || contrast[start] > flatThresh) continue
      const seed = gray[start]
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let area = 0
      let sum = 0
      const stack = [start]
      visited[start] = 1
      while (stack.length) {
        const i = stack.pop()!
        const px = i % w
        const py = (i / w) | 0
        if (Math.abs(gray[i] - seed) > 40) continue
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
        area++
        sum += gray[i]
        for (const [dx, dy] of [
          [2, 0],
          [-2, 0],
          [0, 2],
          [0, -2],
        ]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
          const ni = ny * w + nx
          if (visited[ni]) continue
          visited[ni] = 1
          if (contrast[ni] <= flatThresh * 1.4) stack.push(ni)
        }
      }
      const bw = maxX - minX
      const bh = maxY - minY
      if (area > w * h * 0.02 && bw > w * 0.12 && bh > h * 0.1) {
        regions.push({ minX, minY, maxX, maxY, area, mean: sum / Math.max(1, area) })
      }
    }
  }

  regions.sort((a, b) => b.area - a.area)
  const labels = ['Table', 'Wall', 'Surface', 'Panel', 'Area']
  const out: DetectedSurface[] = []

  for (let i = 0; i < Math.min(maxBlobs, regions.length); i++) {
    const r = regions[i]
    // pad slightly
    const pad = 0.02
    const x0 = Math.max(0.02, (r.minX / w) * step / width - pad)
    const y0 = Math.max(0.02, (r.minY / h) * step / height - pad)
    const x1 = Math.min(0.98, (r.maxX / w) * step / width + pad)
    const y1 = Math.min(0.98, (r.maxY / h) * step / height + pad)
    if (x1 - x0 < 0.1 || y1 - y0 < 0.08) continue

    const cy = (y0 + y1) / 2
    let label = labels[i] || `Surface ${i + 1}`
    if (cy > 0.55) label = i === 0 ? 'Table' : label
    else if (cy < 0.4) label = i === 0 ? 'Wall' : label

    out.push(makeSurface(label, quad(x0, y0, x1, y1), 'auto', Math.min(0.95, 0.5 + r.area / (w * h))))
  }

  return out
}

export function surfaceToHomography(
  corners: NormPoint[],
  projectorW: number,
  projectorH: number,
): { homography: Homography; inverseHomography: Homography } {
  // Homography needs 4 points — use corners or bbox of the polygon
  let quadPts = corners
  if (corners.length !== 4) {
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    quadPts = [
      { x: Math.min(...xs), y: Math.min(...ys) },
      { x: Math.max(...xs), y: Math.min(...ys) },
      { x: Math.max(...xs), y: Math.max(...ys) },
      { x: Math.min(...xs), y: Math.max(...ys) },
    ]
  }
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: projectorW, y: 0 },
    { x: projectorW, y: projectorH },
    { x: 0, y: projectorH },
  ]
  const dst: Point[] = quadPts.slice(0, 4).map((c) => ({
    x: c.x * projectorW,
    y: c.y * projectorH,
  }))
  const homography = computeHomography(src, dst)
  const inverseHomography = computeHomography(dst, src)
  return { homography, inverseHomography }
}

export function moveCorner(
  surface: DetectedSurface,
  cornerIndex: number,
  point: NormPoint,
): DetectedSurface {
  const corners = surface.corners.map((c, i) =>
    i === cornerIndex
      ? { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) }
      : c,
  )
  return { ...surface, corners, area: areaOf(corners) }
}

/** Insert a vertex at the midpoint of the longest edge (for curves / custom objects). */
export function addEditPoint(surface: DetectedSurface): DetectedSurface {
  const n = surface.corners.length
  if (n < 2) return surface
  let bestI = 0
  let bestLen = -1
  for (let i = 0; i < n; i++) {
    const a = surface.corners[i]
    const b = surface.corners[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > bestLen) {
      bestLen = len
      bestI = i
    }
  }
  const a = surface.corners[bestI]
  const b = surface.corners[(bestI + 1) % n]
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const corners = [
    ...surface.corners.slice(0, bestI + 1),
    mid,
    ...surface.corners.slice(bestI + 1),
  ]
  return { ...surface, corners, area: areaOf(corners) }
}

export function removeEditPoint(surface: DetectedSurface, cornerIndex: number): DetectedSurface {
  if (surface.corners.length <= 3) return surface
  if (cornerIndex < 0 || cornerIndex >= surface.corners.length) return surface
  const corners = surface.corners.filter((_, i) => i !== cornerIndex)
  return { ...surface, corners, area: areaOf(corners) }
}

export function nudgeSurface(surface: DetectedSurface, dx: number, dy: number): DetectedSurface {
  const corners = surface.corners.map((c) => ({
    x: Math.max(0, Math.min(1, c.x + dx)),
    y: Math.max(0, Math.min(1, c.y + dy)),
  }))
  return { ...surface, corners }
}

export function scaleSurface(surface: DetectedSurface, factor: number): DetectedSurface {
  const c = center(surface.corners)
  const corners = surface.corners.map((p) => ({
    x: Math.max(0, Math.min(1, c.x + (p.x - c.x) * factor)),
    y: Math.max(0, Math.min(1, c.y + (p.y - c.y) * factor)),
  }))
  return { ...surface, corners }
}
