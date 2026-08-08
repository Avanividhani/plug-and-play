/**
 * Named face regions with per-face (or per-grid-cell) cam→proj homographies
 * fitted only from gray-code samples inside each outline.
 * The dense CamToProjMap stays the source of truth — faces never replace it.
 */

import {
  applyHomography,
  computeHomographyRansac,
  type Homography,
  type Point,
} from './calibration'
import {
  harvestSamplesInPolygon,
  lookupCamToProj,
  mapPolygonPointwiseThroughGray,
  pickBestGrayMap,
  pointInPoly,
  type CamToProjMap,
} from './graycode'
import { opencvHomographyRansac } from './opencvVision'
import type { NormPoint } from './surfaceDetect'

export type FaceKind = 'flat' | 'curved'

export type FaceRegion = {
  id: string
  name: string
  outline: NormPoint[]
  kind: FaceKind
  /** Flat face: single cam→proj H */
  H: Homography | null
  /** Curved face: grid of local Hs over the outline AABB */
  grid?: { cols: number; rows: number; cells: (Homography | null)[][] }
  /** Which projector gray map was used to fit */
  projectorIndex: number
  sampleCount: number
}

function fitHomographyFromSamples(
  samples: { cam: Point; proj: Point }[],
): Homography | null {
  if (samples.length < 8) return null
  const src = samples.map((s) => s.cam)
  const dst = samples.map((s) => s.proj)
  return (
    opencvHomographyRansac(src, dst) ??
    computeHomographyRansac(src, dst, {
      iterations: Math.min(200, 60 + src.length),
      threshold: 0.018,
      minInliers: Math.max(6, Math.floor(src.length * 0.25)),
    })
  )
}

/** Fit one planar H using only map samples inside the outline. */
export function fitFaceHomography(
  map: CamToProjMap,
  outline: NormPoint[],
): { H: Homography | null; sampleCount: number } {
  const samples = harvestSamplesInPolygon(map, outline, 1)
  if (samples.length < 8) {
    // denser fallback already step 1; try all cells
    const again = harvestSamplesInPolygon(map, outline, 1)
    return { H: fitHomographyFromSamples(again), sampleCount: again.length }
  }
  // Subsample if huge
  let used = samples
  if (samples.length > 800) {
    const stride = Math.ceil(samples.length / 600)
    used = samples.filter((_, i) => i % stride === 0)
  }
  return { H: fitHomographyFromSamples(used), sampleCount: samples.length }
}

/** Fit a grid of local Hs for curved surfaces (hourglass, etc.). */
export function fitCurvedFaceGrid(
  map: CamToProjMap,
  outline: NormPoint[],
  cols = 4,
  rows = 4,
): {
  H: Homography | null
  grid: { cols: number; rows: number; cells: (Homography | null)[][] }
  sampleCount: number
} {
  const all = harvestSamplesInPolygon(map, outline, 1)
  const global = fitHomographyFromSamples(
    all.length > 800 ? all.filter((_, i) => i % Math.ceil(all.length / 600) === 0) : all,
  )

  const xs = outline.map((p) => p.x)
  const ys = outline.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const bw = Math.max(1e-6, maxX - minX)
  const bh = Math.max(1e-6, maxY - minY)

  const cells: (Homography | null)[][] = []
  for (let r = 0; r < rows; r++) {
    const row: (Homography | null)[] = []
    for (let c = 0; c < cols; c++) {
      const x0 = minX + (bw * c) / cols
      const x1 = minX + (bw * (c + 1)) / cols
      const y0 = minY + (bh * r) / rows
      const y1 = minY + (bh * (r + 1)) / rows
      const cellPoly: NormPoint[] = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ]
      // Samples in cell ∩ face outline
      const cellSamples = all.filter(
        (s) => pointInPoly(s.cam, cellPoly) && pointInPoly(s.cam, outline),
      )
      let H = fitHomographyFromSamples(cellSamples)
      if (!H && cellSamples.length >= 4) {
        // Tiny cell: DLT with looser RANSAC
        H =
          computeHomographyRansac(
            cellSamples.map((s) => s.cam),
            cellSamples.map((s) => s.proj),
            {
              iterations: 40,
              threshold: 0.03,
              minInliers: 4,
            },
          ) ?? global
      }
      if (!H) H = global
      row.push(H)
    }
    cells.push(row)
  }

  return {
    H: global,
    grid: { cols, rows, cells },
    sampleCount: all.length,
  }
}

export function createFaceRegion(opts: {
  name: string
  outline: NormPoint[]
  kind: FaceKind
  map: CamToProjMap
  projectorIndex: number
  cols?: number
  rows?: number
}): FaceRegion | null {
  if (opts.outline.length < 3) return null
  const id = `face-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  if (opts.kind === 'curved') {
    const fitted = fitCurvedFaceGrid(opts.map, opts.outline, opts.cols ?? 4, opts.rows ?? 4)
    if (fitted.sampleCount < 4 && !fitted.H) return null
    return {
      id,
      name: opts.name,
      outline: opts.outline.map((p) => ({ x: p.x, y: p.y })),
      kind: 'curved',
      H: fitted.H,
      grid: fitted.grid,
      projectorIndex: opts.projectorIndex,
      sampleCount: fitted.sampleCount,
    }
  }

  const fitted = fitFaceHomography(opts.map, opts.outline)
  // Soften: keep face even with sparse samples if H exists; else try curved grid
  if (fitted.H && fitted.sampleCount >= 4) {
    return {
      id,
      name: opts.name,
      outline: opts.outline.map((p) => ({ x: p.x, y: p.y })),
      kind: 'flat',
      H: fitted.H,
      projectorIndex: opts.projectorIndex,
      sampleCount: fitted.sampleCount,
    }
  }
  const curved = fitCurvedFaceGrid(opts.map, opts.outline, 4, 4)
  if (curved.sampleCount >= 4 && (curved.H || curved.grid)) {
    return {
      id,
      name: opts.name,
      outline: opts.outline.map((p) => ({ x: p.x, y: p.y })),
      kind: 'curved',
      H: curved.H,
      grid: curved.grid,
      projectorIndex: opts.projectorIndex,
      sampleCount: curved.sampleCount,
    }
  }
  return null
}

/** Refit H / grid after kind or outline change (same id/name). */
export function refitFaceRegion(
  face: FaceRegion,
  map: CamToProjMap,
  kind: FaceKind = face.kind,
): FaceRegion | null {
  const next = createFaceRegion({
    name: face.name,
    outline: face.outline,
    kind,
    map,
    projectorIndex: face.projectorIndex,
  })
  if (!next) return null
  return { ...next, id: face.id, name: face.name }
}

export function findFaceAt(
  faces: FaceRegion[],
  camPoint: NormPoint,
): FaceRegion | null {
  for (let i = faces.length - 1; i >= 0; i--) {
    if (pointInPoly(camPoint, faces[i].outline)) return faces[i]
  }
  return null
}

/** Face that contains the most vertices of a draw (ties → last outlined). */
export function findFaceForPolygon(
  faces: FaceRegion[],
  camPoly: NormPoint[],
): FaceRegion | null {
  if (!faces.length || camPoly.length < 1) return null
  let best: FaceRegion | null = null
  let bestScore = 0
  for (const f of faces) {
    let score = 0
    for (const c of camPoly) {
      if (pointInPoly(c, f.outline)) score++
    }
    const cx = camPoly.reduce((s, p) => s + p.x, 0) / camPoly.length
    const cy = camPoly.reduce((s, p) => s + p.y, 0) / camPoly.length
    if (pointInPoly({ x: cx, y: cy }, f.outline)) score += 2
    if (score > bestScore) {
      bestScore = score
      best = f
    }
  }
  return bestScore > 0 ? best : null
}

function cellHomography(face: FaceRegion, cam: NormPoint): Homography | null {
  if (face.kind !== 'curved' || !face.grid) return face.H
  const xs = face.outline.map((p) => p.x)
  const ys = face.outline.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const bw = Math.max(1e-6, maxX - minX)
  const bh = Math.max(1e-6, maxY - minY)
  const u = Math.max(0, Math.min(0.999, (cam.x - minX) / bw))
  const v = Math.max(0, Math.min(0.999, (cam.y - minY) / bh))
  const c = Math.min(face.grid.cols - 1, Math.floor(u * face.grid.cols))
  const r = Math.min(face.grid.rows - 1, Math.floor(v * face.grid.rows))
  return face.grid.cells[r]?.[c] ?? face.H
}

export function mapPointThroughFace(face: FaceRegion, cam: NormPoint): NormPoint | null {
  const H = cellHomography(face, cam)
  if (!H) return null
  const p = applyHomography(H, cam)
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  return {
    x: Math.max(0, Math.min(1, p.x)),
    y: Math.max(0, Math.min(1, p.y)),
  }
}

export function mapPolygonThroughFace(
  face: FaceRegion,
  camPoly: NormPoint[],
  map?: CamToProjMap | null,
): NormPoint[] | null {
  if (camPoly.length < 3) return null

  // Prefer dense gray lookup when available — accurate on 3D / curved faces
  if (map && map.valid >= 50) {
    const dense = mapPolygonPointwiseThroughGray(camPoly, map, face.kind === 'curved' ? 16 : 10)
    if (dense && dense.length >= 3) return dense
  }

  // Curved: densify edges so cell Hs blend along the outline
  if (face.kind === 'curved' && face.grid) {
    const segs = Math.max(4, Math.min(16, Math.round(48 / camPoly.length)))
    const out: NormPoint[] = []
    for (let i = 0; i < camPoly.length; i++) {
      const a = camPoly[i]
      const b = camPoly[(i + 1) % camPoly.length]
      for (let s = 0; s < segs; s++) {
        const t = s / segs
        const cam = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        const p = mapPointThroughFace(face, cam)
        if (p) out.push(p)
      }
    }
    return out.length >= 3 ? out : null
  }

  const out: NormPoint[] = []
  for (const c of camPoly) {
    const p = mapPointThroughFace(face, c)
    if (!p) return null
    out.push(p)
  }
  return out
}

/** Pick map + projector index for an outline, then build a face. */
export function buildFaceFromOutline(
  outline: NormPoint[],
  maps: (CamToProjMap | null | undefined)[],
  opts: { name: string; kind: FaceKind },
): FaceRegion | null {
  const map = pickBestGrayMap(outline, maps)
  if (!map || map.valid < 50) return null
  let projectorIndex = 0
  for (let i = 0; i < maps.length; i++) {
    if (maps[i] === map) {
      projectorIndex = i
      break
    }
  }
  return createFaceRegion({
    name: opts.name,
    outline,
    kind: opts.kind,
    map,
    projectorIndex,
  })
}

/** Debug / fallback: verify a point via dense map when H is missing. */
export function mapPointViaMapOrFace(
  face: FaceRegion | null,
  map: CamToProjMap | null,
  cam: NormPoint,
): NormPoint | null {
  if (face) {
    const p = mapPointThroughFace(face, cam)
    if (p) return p
  }
  if (map) return lookupCamToProj(map, cam)
  return null
}
