/**
 * See-and-match ProCam: camera sees where projector light lands,
 * then maps a user-drawn camera region into projector space.
 */

import {
  applyHomography,
  captureFrame,
  computeHomography,
  detectBrightMarkers,
  type Point,
} from './calibration'
import type { NormPoint } from './surfaceDetect'
import type { CamProjAlign } from './camProjAlign'

export const ALIGN_MARGIN = 0.08

export function projectorAlignMarkers(margin = ALIGN_MARGIN): NormPoint[] {
  return [
    { x: margin, y: margin },
    { x: 1 - margin, y: margin },
    { x: 1 - margin, y: 1 - margin },
    { x: margin, y: 1 - margin },
  ]
}

export type Quad = [NormPoint, NormPoint, NormPoint, NormPoint]

export function quadArea(c: NormPoint[]): number {
  let a = 0
  for (let i = 0; i < c.length; i++) {
    const j = (i + 1) % c.length
    a += c[i].x * c[j].y - c[j].x * c[i].y
  }
  return Math.abs(a) / 2
}

export function quadBounds(c: NormPoint[]) {
  const xs = c.map((p) => p.x)
  const ys = c.map((p) => p.y)
  return {
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    cx: xs.reduce((s, v) => s + v, 0) / c.length,
    cy: ys.reduce((s, v) => s + v, 0) / c.length,
  }
}

/** Reject warps that would look like a line / speck on the wall. */
export function isDegenerateQuad(c: NormPoint[], minArea = 0.002, minSide = 0.01): boolean {
  if (c.length < 3) return true
  const { w, h } = quadBounds(c)
  const area = quadArea(c)
  if (area < minArea) return true
  if (w < minSide || h < minSide) return true
  if (w / Math.max(h, 1e-6) > 25 || h / Math.max(w, 1e-6) > 25) return true
  return false
}

/**
 * Keep the mapped shape. Only rescue near-collapsed quads.
 */
export function sanitizeProjectorQuad(c: Quad): Quad {
  const clamped = clampQuad(c)
  if (!isDegenerateQuad(clamped, 0.0015, 0.008)) return clamped
  const { cx, cy, w, h } = quadBounds(clamped)
  const hw = Math.max(0.04, w / 2)
  const hh = Math.max(0.04, h / 2)
  return clampQuad([
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh },
  ])
}

function clampQuad(c: Quad): Quad {
  return c.map((p) => ({
    x: Math.max(0.01, Math.min(0.99, p.x)),
    y: Math.max(0.01, Math.min(0.99, p.y)),
  })) as Quad
}

function orderCorners(pts: Point[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  let best = 0
  let bestScore = Infinity
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y
    if (s < bestScore) {
      bestScore = s
      best = i
    }
  }
  const rot = [...sorted.slice(best), ...sorted.slice(0, best)]
  if (rot[1].x < rot[0].x) {
    return [
      { x: rot[0].x, y: rot[0].y },
      { x: rot[3].x, y: rot[3].y },
      { x: rot[2].x, y: rot[2].y },
      { x: rot[1].x, y: rot[1].y },
    ]
  }
  return [
    { x: rot[0].x, y: rot[0].y },
    { x: rot[1].x, y: rot[1].y },
    { x: rot[2].x, y: rot[2].y },
    { x: rot[3].x, y: rot[3].y },
  ]
}

/**
 * Find projector light by black↔white difference.
 * Rejects “almost whole frame” results (that broke mapping in bright rooms).
 */
export function detectProjectorFootprint(
  blackFrame: ImageData,
  whiteFrame: ImageData,
): { quad: Quad; coverage: number; maskArea: number; ok: boolean } {
  const { width, height } = whiteFrame
  const step = Math.max(2, Math.floor(Math.min(width, height) / 180))
  const samples: { x: number; y: number; d: number; wL: number; bL: number }[] = []

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const wL =
        0.299 * whiteFrame.data[i] +
        0.587 * whiteFrame.data[i + 1] +
        0.114 * whiteFrame.data[i + 2]
      const bL =
        0.299 * blackFrame.data[i] +
        0.587 * blackFrame.data[i + 1] +
        0.114 * blackFrame.data[i + 2]
      samples.push({ x, y, d: wL - bL, wL, bL })
    }
  }

  const diffs = samples.map((s) => s.d).sort((a, b) => a - b)
  const p90 = diffs[Math.floor(diffs.length * 0.9)] ?? 20
  const p95 = diffs[Math.floor(diffs.length * 0.95)] ?? 30
  const thresh = Math.max(18, Math.min(85, (p90 + p95) / 2))

  // Lit by projector = got brighter; ignore pixels that were already bright
  let lit = samples.filter((s) => s.d >= thresh && s.bL < 150)
  let coverage = lit.length / Math.max(1, samples.length)

  const fail = (): { quad: Quad; coverage: number; maskArea: number; ok: boolean } => ({
    quad: [
      { x: 0.25, y: 0.2 },
      { x: 0.75, y: 0.2 },
      { x: 0.75, y: 0.7 },
      { x: 0.25, y: 0.7 },
    ],
    coverage,
    maskArea: coverage,
    ok: false,
  })

  if (lit.length < 12) {
    lit = samples.filter((s) => s.d >= thresh * 0.7 && s.bL < 160)
    coverage = lit.length / Math.max(1, samples.length)
    if (lit.length < 12) return fail()
  }

  // Only reject near-full-frame floods
  if (coverage > 0.55) return fail()

  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (const s of lit) {
    if (s.x < minX) minX = s.x
    if (s.y < minY) minY = s.y
    if (s.x > maxX) maxX = s.x
    if (s.y > maxY) maxY = s.y
  }

  const bw = (maxX - minX) / width
  const bh = (maxY - minY) / height
  if (bw < 0.06 || bh < 0.06) return fail()
  // Reject "whole camera" locks — those made draws land in the wrong place
  if (bw > 0.72 || bh > 0.72 || bw * bh > 0.4) return fail()

  const targets = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  const corners = targets.map((t) => {
    let best = lit[0]
    let bestD = Infinity
    for (const p of lit) {
      const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  })

  const ordered = orderCorners(corners)
  // Keep real corners — forcing an AABB here broke mapping
  const quad = ordered.map((c) => ({
    x: Math.max(0.005, Math.min(0.995, c.x / width)),
    y: Math.max(0.005, Math.min(0.995, c.y / height)),
  })) as Quad

  return {
    quad,
    coverage: lit.length / Math.max(1, samples.length),
    maskArea: lit.length / Math.max(1, samples.length),
    ok: true,
  }
}

/**
 * Detect the bright projector blob from a single full-white frame (no black pair).
 */
export function detectBrightBeam(whiteFrame: ImageData): { quad: Quad; ok: boolean } {
  const { width, height } = whiteFrame
  const step = Math.max(2, Math.floor(Math.min(width, height) / 160))
  const samples: { x: number; y: number; L: number }[] = []
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const L =
        0.299 * whiteFrame.data[i] +
        0.587 * whiteFrame.data[i + 1] +
        0.114 * whiteFrame.data[i + 2]
      samples.push({ x, y, L })
    }
  }
  const sorted = [...samples].map((s) => s.L).sort((a, b) => a - b)
  const p85 = sorted[Math.floor(sorted.length * 0.85)] ?? 180
  const thresh = Math.max(150, p85)
  const lit = samples.filter((s) => s.L >= thresh)
  const cov = lit.length / Math.max(1, samples.length)
  if (lit.length < 20 || cov > 0.5 || cov < 0.02) {
    return {
      ok: false,
      quad: [
        { x: 0.2, y: 0.15 },
        { x: 0.8, y: 0.15 },
        { x: 0.8, y: 0.75 },
        { x: 0.2, y: 0.75 },
      ],
    }
  }
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (const s of lit) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x)
    maxY = Math.max(maxY, s.y)
  }
  const bw = (maxX - minX) / width
  const bh = (maxY - minY) / height
  if (bw > 0.9 || bh > 0.9) {
    return {
      ok: false,
      quad: [
        { x: 0.2, y: 0.15 },
        { x: 0.8, y: 0.15 },
        { x: 0.8, y: 0.75 },
        { x: 0.2, y: 0.75 },
      ],
    }
  }
  const q = orderCorners([
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]).map((c) => ({ x: c.x / width, y: c.y / height })) as Quad
  return { quad: q, ok: true }
}

/** Fraction of “lit” (black→white diff) samples that fall inside the quad AABB. */
export function litCoverageInsideQuad(
  blackFrame: ImageData,
  whiteFrame: ImageData,
  quad: Quad,
): number {
  const { width, height } = whiteFrame
  const b = quadBounds(quad)
  const left = b.cx - b.w / 2
  const top = b.cy - b.h / 2
  const right = left + b.w
  const bottom = top + b.h
  const step = Math.max(2, Math.floor(Math.min(width, height) / 160))
  let lit = 0
  let inside = 0
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const wL =
        0.299 * whiteFrame.data[i] +
        0.587 * whiteFrame.data[i + 1] +
        0.114 * whiteFrame.data[i + 2]
      const bL =
        0.299 * blackFrame.data[i] +
        0.587 * blackFrame.data[i + 1] +
        0.114 * blackFrame.data[i + 2]
      if (wL - bL < 22) continue
      lit++
      const nx = x / width
      const ny = y / height
      if (nx >= left && nx <= right && ny >= top && ny <= bottom) inside++
    }
  }
  if (lit < 8) return 0
  return inside / lit
}

export function alignFromFootprint(footprintCam: Quad): CamProjAlign {
  const projUnit: Quad = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
  const projToCam = computeHomography(projUnit, footprintCam)
  const camToProj = computeHomography(footprintCam, projUnit)

  return {
    camToProj,
    projToCam,
    camMarkers: footprintCam,
    projMarkers: projUnit,
    rms: 0,
    at: Date.now(),
  }
}

/** Known white rectangle we project during probe calibration (projector-normalized). */
export const PROBE_QUAD: Quad = [
  { x: 0.18, y: 0.18 },
  { x: 0.82, y: 0.18 },
  { x: 0.82, y: 0.82 },
  { x: 0.18, y: 0.82 },
]

/**
 * Build align from a projected probe rectangle and where the camera saw it.
 * camBlob corners ↔ probeCorners in projector space (not full frame).
 */
export function alignFromProbe(camBlob: Quad, probe: Quad = PROBE_QUAD): CamProjAlign {
  const camToProj = computeHomography(camBlob, probe)
  const projToCam = computeHomography(probe, camBlob)
  let err = 0
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(camToProj, camBlob[i])
    err += (p.x - probe[i].x) ** 2 + (p.y - probe[i].y) ** 2
  }
  return {
    camToProj,
    projToCam,
    camMarkers: camBlob,
    projMarkers: probe,
    rms: Math.sqrt(err / 4),
    at: Date.now(),
  }
}

/**
 * Find the bright probe rectangle in camera by black vs probe-white difference.
 * Much more reliable than full-frame white (avoids lighting up the whole room).
 */
export function detectProbeBlob(
  blackFrame: ImageData,
  probeFrame: ImageData,
): { quad: Quad; coverage: number; ok: boolean } {
  const { width, height } = probeFrame
  const step = Math.max(2, Math.floor(Math.min(width, height) / 200))
  const samples: { x: number; y: number; d: number }[] = []

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const wL =
        0.299 * probeFrame.data[i] +
        0.587 * probeFrame.data[i + 1] +
        0.114 * probeFrame.data[i + 2]
      const bL =
        0.299 * blackFrame.data[i] +
        0.587 * blackFrame.data[i + 1] +
        0.114 * blackFrame.data[i + 2]
      samples.push({ x, y, d: wL - bL })
    }
  }

  const diffs = samples.map((s) => s.d).sort((a, b) => a - b)
  const p92 = diffs[Math.floor(diffs.length * 0.92)] ?? 25
  const p97 = diffs[Math.floor(diffs.length * 0.97)] ?? 40
  const thresh = Math.max(25, Math.min(100, (p92 + p97) / 2))
  const lit = samples.filter((s) => s.d >= thresh)
  const coverage = lit.length / Math.max(1, samples.length)

  if (lit.length < 15 || coverage < 0.015 || coverage > 0.45) {
    return {
      ok: false,
      coverage,
      quad: [
        { x: 0.3, y: 0.25 },
        { x: 0.7, y: 0.25 },
        { x: 0.7, y: 0.65 },
        { x: 0.3, y: 0.65 },
      ],
    }
  }

  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (const s of lit) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x)
    maxY = Math.max(maxY, s.y)
  }
  const bw = (maxX - minX) / width
  const bh = (maxY - minY) / height
  if (bw < 0.05 || bh < 0.05 || bw > 0.72 || bh > 0.72 || bw * bh > 0.4) {
    return { ok: false, coverage, quad: PROBE_QUAD }
  }

  // Extreme points near bbox corners
  const targets = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
  const corners = targets.map((t) => {
    let best = lit[0]
    let bestD = Infinity
    for (const p of lit) {
      const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  })
  const ordered = orderCorners(corners)
  const quad = ordered.map((c) => ({ x: c.x / width, y: c.y / height })) as Quad
  return { quad, coverage, ok: true }
}

export function tryMarkerRefine(video: HTMLVideoElement, base: CamProjAlign): CamProjAlign {
  try {
    const frame = captureFrame(video)
    const found = detectBrightMarkers(frame, 4)
    if (found.length < 4) return base
    const camMarkers = found.map((p) => ({
      x: p.x / frame.width,
      y: p.y / frame.height,
    })) as NormPoint[]
    if (isDegenerateQuad(camMarkers as Quad, 0.02, 0.05)) return base
    const projMarkers = projectorAlignMarkers()
    const camToProj = computeHomography(camMarkers, projMarkers)
    const projToCam = computeHomography(projMarkers, camMarkers)
    let err = 0
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(camToProj, camMarkers[i])
      err += (p.x - projMarkers[i].x) ** 2 + (p.y - projMarkers[i].y) ** 2
    }
    const rms = Math.sqrt(err / 4)
    if (rms > 0.15) return base
    return {
      ...base,
      camToProj,
      projToCam,
      camMarkers: camMarkers as Quad,
      projMarkers,
      rms,
      at: Date.now(),
    }
  } catch {
    return base
  }
}

export function selectionToProjectorQuad(
  selectionCam: NormPoint[],
  align: CamProjAlign | null,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): NormPoint[] {
  const clampPt = (p: NormPoint) => ({
    x: Math.max(0.002, Math.min(0.998, p.x)),
    y: Math.max(0.002, Math.min(0.998, p.y)),
  })

  if (!align || selectionCam.length < 3) {
    if (selectionCam.length >= 3) {
      return selectionCam.map((p) => clampPt({ x: p.x + offset.x, y: p.y + offset.y }))
    }
    return [
      { x: 0.2 + offset.x, y: 0.2 + offset.y },
      { x: 0.8 + offset.x, y: 0.2 + offset.y },
      { x: 0.8 + offset.x, y: 0.8 + offset.y },
      { x: 0.2 + offset.x, y: 0.8 + offset.y },
    ].map(clampPt)
  }

  const FULL: Quad = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]

  // Homography from the locked beam corners (handles skewed yellow beams).
  // Do NOT use AABB relative mapping — yellow is often a parallelogram, and
  // axis-aligned UV put light in the wrong place on the wall.
  const mapped = selectionCam.map((c) => {
    const p = applyHomography(align.camToProj, c)
    return clampPt({ x: p.x + offset.x, y: p.y + offset.y })
  })
  if (!isDegenerateQuad(mapped, 0.0008, 0.006)) return mapped

  if (align.camMarkers?.length >= 4) {
    const projBounds =
      align.projMarkers?.length >= 4 ? (align.projMarkers as Quad) : FULL
    return mapRelativeToFootprint(
      selectionCam,
      align.camMarkers as Quad,
      offset,
      projBounds,
    ).map(clampPt)
  }

  return mapped
}

/**
 * Map a camera point into projector space using the real beam quad (not its AABB).
 * u,v are bilinear coords in footprint → same u,v in projBounds.
 */
export function mapRelativeToFootprint(
  selection: NormPoint[],
  footprint: Quad,
  offset: { x: number; y: number } = { x: 0, y: 0 },
  projBounds: Quad = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
): NormPoint[] {
  // Prefer exact homography between the two quads (handles skewed yellow beams)
  try {
    const camToProj = computeHomography(footprint, projBounds)
    return selection.map((p) => {
      const q = applyHomography(camToProj, p)
      return { x: q.x + offset.x, y: q.y + offset.y }
    })
  } catch {
    const fb = quadBounds(footprint)
    const pb = quadBounds(projBounds)
    const left = fb.cx - fb.w / 2
    const top = fb.cy - fb.h / 2
    const w = Math.max(fb.w, 1e-4)
    const h = Math.max(fb.h, 1e-4)
    const pLeft = pb.cx - pb.w / 2
    const pTop = pb.cy - pb.h / 2
    return selection.map((p) => ({
      x: pLeft + ((p.x - left) / w) * pb.w + offset.x,
      y: pTop + ((p.y - top) / h) * pb.h + offset.y,
    }))
  }
}

/** Shrink a quad toward its center (for a visible test patch). */
export function insetQuad(q: Quad, t: number): Quad {
  const { cx, cy } = quadBounds(q)
  return q.map((p) => ({
    x: cx + (p.x - cx) * (1 - t),
    y: cy + (p.y - cy) * (1 - t),
  })) as Quad
}

/** Axis-aligned rectangle in camera space → ordered TL,TR,BR,BL quad. */
export function rectToQuad(x0: number, y0: number, x1: number, y1: number): Quad {
  const minX = Math.max(0, Math.min(x0, x1))
  const maxX = Math.min(1, Math.max(x0, x1))
  const minY = Math.max(0, Math.min(y0, y1))
  const maxY = Math.min(1, Math.max(y0, y1))
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}

/** 3×3 probe points across the projector (known map of the beam). */
export const CALIB_GRID: NormPoint[] = [
  { x: 0.18, y: 0.18 },
  { x: 0.5, y: 0.18 },
  { x: 0.82, y: 0.18 },
  { x: 0.18, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.82, y: 0.5 },
  { x: 0.18, y: 0.82 },
  { x: 0.5, y: 0.82 },
  { x: 0.82, y: 0.82 },
]

export function patchAround(c: NormPoint, half = 0.05): Quad {
  return [
    { x: Math.max(0.01, c.x - half), y: Math.max(0.01, c.y - half) },
    { x: Math.min(0.99, c.x + half), y: Math.max(0.01, c.y - half) },
    { x: Math.min(0.99, c.x + half), y: Math.min(0.99, c.y + half) },
    { x: Math.max(0.01, c.x - half), y: Math.min(0.99, c.y + half) },
  ]
}

/** Bright region AABB from black↔lit difference (for closed-loop snap). */
export function detectLitBounds(
  blackFrame: ImageData,
  litFrame: ImageData,
  near?: { cx: number; cy: number; radius: number },
): { cx: number; cy: number; w: number; h: number; ok: boolean; n: number } {
  const { width, height } = litFrame
  const step = Math.max(2, Math.floor(Math.min(width, height) / 220))
  const diffs: number[] = []
  const samples: { x: number; y: number; d: number; bL: number }[] = []

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const wL =
        0.299 * litFrame.data[i] +
        0.587 * litFrame.data[i + 1] +
        0.114 * litFrame.data[i + 2]
      const bL =
        0.299 * blackFrame.data[i] +
        0.587 * blackFrame.data[i + 1] +
        0.114 * blackFrame.data[i + 2]
      samples.push({ x, y, d: wL - bL, bL })
      diffs.push(wL - bL)
    }
  }
  diffs.sort((a, b) => a - b)
  const p95 = diffs[Math.floor(diffs.length * 0.95)] ?? 40
  const thresh = Math.max(28, Math.min(110, p95 * 0.85))
  let lit = samples.filter((s) => s.d >= thresh && s.bL < 140)

  // Prefer lit pixels near the drawn shape (ignore stray reflections)
  if (near && lit.length >= 8) {
    const r = near.radius * Math.min(width, height)
    const local = lit.filter((s) => {
      const dx = s.x - near.cx * width
      const dy = s.y - near.cy * height
      return Math.hypot(dx, dy) <= r
    })
    if (local.length >= 8) lit = local
  }

  if (lit.length < 10) {
    return { cx: 0.5, cy: 0.5, w: 0, h: 0, ok: false, n: lit.length }
  }

  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  let sx = 0
  let sy = 0
  for (const s of lit) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x)
    maxY = Math.max(maxY, s.y)
    sx += s.x
    sy += s.y
  }
  const w = (maxX - minX) / width
  const h = (maxY - minY) / height
  if (w < 0.01 || h < 0.01) {
    return { cx: 0.5, cy: 0.5, w, h, ok: false, n: lit.length }
  }
  return {
    cx: sx / lit.length / width,
    cy: sy / lit.length / height,
    w,
    h,
    ok: true,
    n: lit.length,
  }
}

/** Bright patch centroid from black↔lit difference (one calib point). */
export function detectLitCentroid(
  blackFrame: ImageData,
  litFrame: ImageData,
): { x: number; y: number; ok: boolean; n: number } {
  const { width, height } = litFrame
  const step = Math.max(2, Math.floor(Math.min(width, height) / 220))
  const diffs: number[] = []
  const samples: { x: number; y: number; d: number; bL: number }[] = []

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const wL =
        0.299 * litFrame.data[i] +
        0.587 * litFrame.data[i + 1] +
        0.114 * litFrame.data[i + 2]
      const bL =
        0.299 * blackFrame.data[i] +
        0.587 * blackFrame.data[i + 1] +
        0.114 * blackFrame.data[i + 2]
      const d = wL - bL
      samples.push({ x, y, d, bL })
      diffs.push(d)
    }
  }
  diffs.sort((a, b) => a - b)
  const p95 = diffs[Math.floor(diffs.length * 0.95)] ?? 40
  const thresh = Math.max(32, Math.min(120, p95 * 0.88))
  // Ignore pixels that were already bright with projector off (windows, lamps)
  const lit = samples.filter((s) => s.d >= thresh && s.bL < 130)
  const cov = lit.length / Math.max(1, samples.length)
  if (lit.length < 8 || cov > 0.25 || cov < 0.0005) {
    return { x: 0.5, y: 0.5, ok: false, n: lit.length }
  }

  let sx = 0
  let sy = 0
  let sw = 0
  for (const s of lit) {
    const w = s.d
    sx += s.x * w
    sy += s.y * w
    sw += w
  }
  return {
    x: sx / sw / width,
    y: sy / sw / height,
    ok: true,
    n: lit.length,
  }
}

/** Build cam↔proj map; drop outlier pairs and refit for accuracy. */
export function alignFromPointPairs(
  camPts: NormPoint[],
  projPts: NormPoint[],
): CamProjAlign {
  if (camPts.length < 4 || projPts.length < 4) {
    throw new Error('Need at least 4 calibration points')
  }
  const n0 = Math.min(camPts.length, projPts.length)
  let cam = camPts.slice(0, n0)
  let proj = projPts.slice(0, n0)

  const fit = (c: NormPoint[], p: NormPoint[]) => {
    const camToProj = computeHomography(c, p)
    const projToCam = computeHomography(p, c)
    const residuals: number[] = []
    let err = 0
    for (let i = 0; i < c.length; i++) {
      const q = applyHomography(camToProj, c[i])
      const r = Math.hypot(q.x - p[i].x, q.y - p[i].y)
      residuals.push(r)
      err += r * r
    }
    return { camToProj, projToCam, residuals, rms: Math.sqrt(err / c.length) }
  }

  let best = fit(cam, proj)
  // Drop worst outliers once if we have enough points
  if (cam.length >= 6) {
    const sorted = best.residuals
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r - a.r)
    const drop = new Set(sorted.slice(0, Math.min(2, cam.length - 4)).map((x) => x.i))
    const cam2 = cam.filter((_, i) => !drop.has(i))
    const proj2 = proj.filter((_, i) => !drop.has(i))
    const refit = fit(cam2, proj2)
    if (refit.rms < best.rms) {
      best = refit
      cam = cam2
      proj = proj2
    }
  }

  const xs = cam.map((p) => p.x)
  const ys = cam.map((p) => p.y)
  const camMarkers: Quad = [
    { x: Math.min(...xs), y: Math.min(...ys) },
    { x: Math.max(...xs), y: Math.min(...ys) },
    { x: Math.max(...xs), y: Math.max(...ys) },
    { x: Math.min(...xs), y: Math.max(...ys) },
  ]
  const pxs = proj.map((p) => p.x)
  const pys = proj.map((p) => p.y)
  const projMarkers: Quad = [
    { x: Math.min(...pxs), y: Math.min(...pys) },
    { x: Math.max(...pxs), y: Math.min(...pys) },
    { x: Math.max(...pxs), y: Math.max(...pys) },
    { x: Math.min(...pxs), y: Math.max(...pys) },
  ]
  return {
    camToProj: best.camToProj,
    projToCam: best.projToCam,
    camMarkers,
    projMarkers,
    rms: best.rms,
    at: Date.now(),
  }
}
