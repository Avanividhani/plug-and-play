/**
 * Gray-code structured-light ProCam calibration
 * Inspired by https://github.com/punpongsanon/graycode-procam-calibration
 *
 * Project binary Gray-code patterns → capture with USB camera →
 * decode a camera→projector lookup (c2p) so a region selected in the
 * camera view lands on the matching projector pixels.
 */

import type { NormPoint } from './surfaceDetect'
import {
  applyHomography,
  computeHomographyRansac,
  type Homography,
  type Point,
} from './calibration'
import { opencvHomographyRansac } from './opencvVision'

export type GrayCodeProgress = {
  step: string
  index: number
  total: number
  message: string
}

/** Dense map: for sampled camera pixels → projector normalized coords */
export type CamToProjMap = {
  /** Grid resolution in camera space */
  camW: number
  camH: number
  /** Parallel arrays; NaN = unknown */
  projX: Float32Array
  projY: Float32Array
  /** Valid correspondence count */
  valid: number
  at: number
  /** Projector pattern bit depths used */
  bitsX: number
  bitsY: number
}

function bitsNeeded(n: number) {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, n))))
}

/** Binary → Gray */
function toGray(v: number) {
  return v ^ (v >> 1)
}

/** Build one Gray-code stripe pattern for axis. */
export function makeGrayPattern(
  width: number,
  height: number,
  bit: number,
  axis: 'x' | 'y',
  invert: boolean,
): ImageData {
  const img = new ImageData(width, height)
  const data = img.data
  const maxVal = axis === 'x' ? width : height
  const mask = 1 << bit

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const coord = axis === 'x' ? x : y
      // Quantize to pattern columns/rows
      const gray = toGray(coord)
      let on = (gray & mask) !== 0
      if (invert) on = !on
      const v = on ? 255 : 0
      const i = (y * width + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  void maxVal
  return img
}

export function drawPatternToCanvas(canvas: HTMLCanvasElement, pattern: ImageData) {
  if (canvas.width !== pattern.width || canvas.height !== pattern.height) {
    canvas.width = pattern.width
    canvas.height = pattern.height
  }
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(pattern, 0, 0)
}

function luminance(data: Uint8ClampedArray, i: number) {
  const o = i * 4
  return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
}

/**
 * Decode Gray-code bit planes from camera captures.
 * For each bit we have a pair (normal, inverse); bit is 1 if normal > inverse.
 */
export function decodeGrayBitPlane(
  normal: ImageData,
  inverse: ImageData,
  outBits: Uint8Array,
  bitIndex: number,
) {
  const n = normal.width * normal.height
  for (let i = 0; i < n; i++) {
    const a = luminance(normal.data, i)
    const b = luminance(inverse.data, i)
    if (a > b) outBits[i] |= 1 << bitIndex
  }
}

/** Gray code integer → binary */
function grayToBinary(gray: number) {
  let b = gray
  let mask = gray >> 1
  while (mask) {
    b ^= mask
    mask >>= 1
  }
  return b
}

/** 3×3 median smooth — only touches cells that were already valid (never invents beam). */
export function refineCamToProjMap(map: CamToProjMap, passes = 2): CamToProjMap {
  const { camW, camH } = map
  let projX = Float32Array.from(map.projX)
  let projY = Float32Array.from(map.projY)
  let valid = 0

  for (let pass = 0; pass < passes; pass++) {
    const nx = Float32Array.from(projX)
    const ny = Float32Array.from(projY)
    valid = 0
    for (let y = 0; y < camH; y++) {
      for (let x = 0; x < camW; x++) {
        const i = y * camW + x
        const ox = projX[i]
        const oy = projY[i]
        // Do NOT fill NaN holes — that dilated fake correspondences and broke mapping
        if (!Number.isFinite(ox) || !Number.isFinite(oy)) {
          nx[i] = NaN
          ny[i] = NaN
          continue
        }
        const xs: number[] = []
        const ys: number[] = []
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx < 0 || yy < 0 || xx >= camW || yy >= camH) continue
            const j = yy * camW + xx
            const px = projX[j]
            const py = projY[j]
            if (!Number.isFinite(px) || !Number.isFinite(py)) continue
            xs.push(px)
            ys.push(py)
          }
        }
        if (xs.length >= 3) {
          xs.sort((a, b) => a - b)
          ys.sort((a, b) => a - b)
          const mid = xs.length >> 1
          nx[i] = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
          ny[i] = ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2
        } else {
          nx[i] = ox
          ny[i] = oy
        }
        valid++
      }
    }
    projX = nx
    projY = ny
  }

  return { ...map, projX, projY, valid }
}

/**
 * Decode Gray-code captures into a dense cam→projector map.
 * Uses contrast checks + local majority vote for stabler bits.
 */
export function buildCamToProjMap(
  captures: Map<string, ImageData>,
  projW: number,
  projH: number,
  sampleStep = 2,
): CamToProjMap {
  const first = captures.values().next().value as ImageData | undefined
  if (!first) throw new Error('No gray-code captures')

  const camFullW = first.width
  const camFullH = first.height
  const bitsX = bitsNeeded(projW)
  const bitsY = bitsNeeded(projH)

  const grayX = new Uint32Array(camFullW * camFullH)
  const grayY = new Uint32Array(camFullW * camFullH)
  const confX = new Uint8Array(camFullW * camFullH)
  const confY = new Uint8Array(camFullW * camFullH)

  for (let bit = 0; bit < bitsX; bit++) {
    const n = captures.get(`x${bit}`)
    const inv = captures.get(`x${bit}i`)
    if (!n || !inv) continue
    for (let i = 0; i < camFullW * camFullH; i++) {
      const a = luminance(n.data, i)
      const b = luminance(inv.data, i)
      const d = Math.abs(a - b)
      if (d < 8) continue
      if (a > b) grayX[i] |= 1 << bit
      if (d >= 18) confX[i] |= 1 << bit
    }
  }
  for (let bit = 0; bit < bitsY; bit++) {
    const n = captures.get(`y${bit}`)
    const inv = captures.get(`y${bit}i`)
    if (!n || !inv) continue
    for (let i = 0; i < camFullW * camFullH; i++) {
      const a = luminance(n.data, i)
      const b = luminance(inv.data, i)
      const d = Math.abs(a - b)
      if (d < 8) continue
      if (a > b) grayY[i] |= 1 << bit
      if (d >= 18) confY[i] |= 1 << bit
    }
  }

  // Local majority vote on each gray bit (3×3) — reduces single-pixel flicker
  const voteGray = (src: Uint32Array, bits: number) => {
    const out = new Uint32Array(src.length)
    for (let y = 1; y < camFullH - 1; y++) {
      for (let x = 1; x < camFullW - 1; x++) {
        let g = 0
        for (let bit = 0; bit < bits; bit++) {
          const mask = 1 << bit
          let ones = 0
          let count = 0
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const i = (y + dy) * camFullW + (x + dx)
              count++
              if (src[i] & mask) ones++
            }
          }
          if (ones > count / 2) g |= mask
        }
        out[y * camFullW + x] = g
      }
    }
    return out
  }
  const votedX = voteGray(grayX, bitsX)
  const votedY = voteGray(grayY, bitsY)

  const camW = Math.floor(camFullW / sampleStep)
  const camH = Math.floor(camFullH / sampleStep)
  const projX = new Float32Array(camW * camH)
  const projY = new Float32Array(camW * camH)
  projX.fill(NaN)
  projY.fill(NaN)
  let valid = 0

  for (let sy = 0; sy < camH; sy++) {
    for (let sx = 0; sx < camW; sx++) {
      const cx = Math.min(camFullW - 1, sx * sampleStep + (sampleStep >> 1))
      const cy = Math.min(camFullH - 1, sy * sampleStep + (sampleStep >> 1))
      const i = cy * camFullW + cx
      const bx = grayToBinary(votedX[i])
      const by = grayToBinary(votedY[i])
      if (bx >= projW || by >= projH) continue
      const sample = captures.get('x0')
      if (sample) {
        const L = luminance(sample.data, i)
        const Li = captures.get('x0i')
        const L2 = Li ? luminance(Li.data, i) : 0
        if (Math.max(L, L2) < 18) continue
        if (Math.abs(L - L2) < 8) continue
      }
      // Require enough high-contrast bits (slightly softer so small faces still get density)
      const need = Math.max(2, Math.floor((bitsX + bitsY) * 0.22))
      const strong = popcount(confX[i]) + popcount(confY[i]) >= need
      if (!strong) continue
      const idx = sy * camW + sx
      projX[idx] = bx / Math.max(1, projW - 1)
      projY[idx] = by / Math.max(1, projH - 1)
      valid++
    }
  }

  const raw: CamToProjMap = {
    camW,
    camH,
    projX,
    projY,
    valid,
    at: Date.now(),
    bitsX,
    bitsY,
  }
  return refineCamToProjMap(raw, 1)
}

function popcount(v: number) {
  let n = 0
  let x = v >>> 0
  while (x) {
    n += x & 1
    x >>>= 1
  }
  return n
}

export type PatternStep = {
  axis: 'x' | 'y'
  bit: number
  invert: boolean
  key: string
}

/** Ordered list of patterns to project (black, white, then gray pairs). */
export function buildPatternSequence(projW: number, projH: number): PatternStep[] {
  const bitsX = bitsNeeded(projW)
  const bitsY = bitsNeeded(projH)
  const steps: PatternStep[] = []
  for (let bit = 0; bit < bitsX; bit++) {
    steps.push({ axis: 'x', bit, invert: false, key: `x${bit}` })
    steps.push({ axis: 'x', bit, invert: true, key: `x${bit}i` })
  }
  for (let bit = 0; bit < bitsY; bit++) {
    steps.push({ axis: 'y', bit, invert: false, key: `y${bit}` })
    steps.push({ axis: 'y', bit, invert: true, key: `y${bit}i` })
  }
  return steps
}

export function patternImage(projW: number, projH: number, step: PatternStep): ImageData {
  return makeGrayPattern(projW, projH, step.bit, step.axis, step.invert)
}

/** Look up projector norm coords for a camera norm point (bilinear). */
export function lookupCamToProj(map: CamToProjMap, cam: NormPoint): NormPoint | null {
  const x = cam.x * (map.camW - 1)
  const y = cam.y * (map.camH - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(map.camW - 1, x0 + 1)
  const y1 = Math.min(map.camH - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0

  const samples: { px: number; py: number; w: number }[] = []
  for (const [ix, iy, w] of [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty],
  ] as const) {
    const i = iy * map.camW + ix
    const px = map.projX[i]
    const py = map.projY[i]
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue
    samples.push({ px, py, w })
  }
  if (!samples.length) {
    // Small nearest-neighbor search only — large radius snapped tips to wrong faces
    const cx = Math.round(x)
    const cy = Math.round(y)
    const maxR = Math.max(3, Math.min(10, Math.ceil(Math.min(map.camW, map.camH) * 0.012)))
    let bestPx = NaN
    let bestPy = NaN
    let bestD = Infinity
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
          const ix = cx + dx
          const iy = cy + dy
          if (ix < 0 || iy < 0 || ix >= map.camW || iy >= map.camH) continue
          const i = iy * map.camW + ix
          const px = map.projX[i]
          const py = map.projY[i]
          if (!Number.isFinite(px) || !Number.isFinite(py)) continue
          const d = dx * dx + dy * dy
          if (d < bestD) {
            bestD = d
            bestPx = px
            bestPy = py
          }
        }
      }
      if (Number.isFinite(bestPx) && Number.isFinite(bestPy)) {
        return { x: bestPx, y: bestPy }
      }
    }
    return null
  }
  let wsum = 0
  let sx = 0
  let sy = 0
  for (const s of samples) {
    wsum += s.w
    sx += s.px * s.w
    sy += s.py * s.w
  }
  return { x: sx / wsum, y: sy / wsum }
}

/** True if map cell has a finite cam→proj correspondence (lit / decoded). */
export function mapCellValid(map: CamToProjMap, i: number): boolean {
  return Number.isFinite(map.projX[i]) && Number.isFinite(map.projY[i])
}

/**
 * Collect cam→proj samples whose camera UV lies inside `outline`.
 * Uses the full stored map — fitting a face H must never discard this data.
 */
export function harvestSamplesInPolygon(
  map: CamToProjMap,
  outline: NormPoint[],
  sampleStep = 1,
): { cam: Point; proj: Point }[] {
  if (outline.length < 3) return []
  const out: { cam: Point; proj: Point }[] = []
  const step = Math.max(1, sampleStep)
  for (let iy = 0; iy < map.camH; iy += step) {
    for (let ix = 0; ix < map.camW; ix += step) {
      const i = iy * map.camW + ix
      if (!mapCellValid(map, i)) continue
      const cam = {
        x: ix / Math.max(1, map.camW - 1),
        y: iy / Math.max(1, map.camH - 1),
      }
      if (!pointInPoly(cam, outline)) continue
      out.push({
        cam,
        proj: { x: map.projX[i], y: map.projY[i] },
      })
    }
  }
  return out
}

/**
 * Map a 4-corner camera rect → exactly 4 projector corners.
 * Cube faces are planar: fit a RANSAC homography from dense gray-code samples
 * inside the rect, then warp all 4 corners through that plane (sharp, no triangles).
 */
export function mapQuadThroughGray(quad: NormPoint[], map: CamToProjMap): NormPoint[] | null {
  if (quad.length !== 4) return null

  const planar = mapPlanarQuadThroughGray(quad, map)
  if (planar) return planar

  // Sparse / tiny face fallback — neighborhood samples + repair
  return mapQuadNeighborhoodFallback(quad, map)
}

/** Bilinear point inside TL,TR,BR,BL quad. */
function bilerpQuad(quad: NormPoint[], u: number, v: number): NormPoint {
  const top = {
    x: quad[0].x + (quad[1].x - quad[0].x) * u,
    y: quad[0].y + (quad[1].y - quad[0].y) * u,
  }
  const bot = {
    x: quad[3].x + (quad[2].x - quad[3].x) * u,
    y: quad[3].y + (quad[2].y - quad[3].y) * u,
  }
  return {
    x: top.x + (bot.x - top.x) * v,
    y: top.y + (bot.y - top.y) * v,
  }
}

/**
 * Planar ProCam mapping: collect cam→proj hits inside the drawn face,
 * RANSAC-fit a homography, project the 4 corners. Best accuracy on cubes.
 */
export function mapPlanarQuadThroughGray(
  quad: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  if (quad.length !== 4) return null

  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const area = Math.max(1e-6, (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)))
  // Denser grid for tiny faces so RANSAC still has enough points
  const grid = area < 0.02 ? 28 : area < 0.06 ? 20 : 14
  // Keep samples near the edges — large inset biased H and shrank the projected quad
  const inset = area < 0.02 ? 0.03 : 0.04

  const src: Point[] = []
  const dst: Point[] = []
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      const u = inset + (1 - 2 * inset) * (i / grid)
      const v = inset + (1 - 2 * inset) * (j / grid)
      const cam = bilerpQuad(quad, u, v)
      const proj = lookupCamToProj(map, cam)
      if (!proj) continue
      if (!Number.isFinite(proj.x) || !Number.isFinite(proj.y)) continue
      src.push(cam)
      dst.push(proj)
    }
  }

  // Also harvest every map cell whose center lies in the quad (extra density)
  for (let iy = 0; iy < map.camH; iy++) {
    for (let ix = 0; ix < map.camW; ix++) {
      const i = iy * map.camW + ix
      const px = map.projX[i]
      const py = map.projY[i]
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      const cam = {
        x: ix / Math.max(1, map.camW - 1),
        y: iy / Math.max(1, map.camH - 1),
      }
      if (!pointInPoly(cam, quad)) continue
      src.push(cam)
      dst.push({ x: px, y: py })
    }
  }

  if (src.length < 8) return null

  // Prefer OpenCV RANSAC when WASM is warm; else pure-JS RANSAC/DLT
  let H: Homography | null = opencvHomographyRansac(src, dst)
  if (!H) {
    H = computeHomographyRansac(src, dst, {
      iterations: Math.min(160, 50 + src.length),
      threshold: area < 0.02 ? 0.025 : 0.016,
      minInliers: Math.max(6, Math.floor(src.length * 0.28)),
    })
  }
  if (!H) return null

  const mapped = quad.map((c) => {
    const p = applyHomography(H!, c)
    return {
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    }
  })

  // Reject collapsed / triangle-like results
  const a1 = triArea(mapped[0], mapped[1], mapped[2])
  const a2 = triArea(mapped[0], mapped[2], mapped[3])
  if (a1 < 0.00012 || a2 < 0.00012) return null
  if (segmentsCross(mapped[0], mapped[1], mapped[3], mapped[2])) return null

  return repairMappedQuad(mapped)
}

function mapQuadNeighborhoodFallback(
  quad: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const bw = Math.max(1e-4, maxX - minX)
  const bh = Math.max(1e-4, maxY - minY)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const centerProj = lookupCamToProj(map, { x: cx, y: cy })

  const median = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }

  const cornerProj = (corner: NormPoint): NormPoint | null => {
    const samples: NormPoint[] = []
    // Sample slightly inside so we hit valid gray cells, then extrapolate to the true corner
    const inset = 0.12
    const ox = corner.x + (cx - corner.x) * inset
    const oy = corner.y + (cy - corner.y) * inset
    const rad = Math.min(bw, bh) * 0.18
    for (let gy = -3; gy <= 3; gy++) {
      for (let gx = -3; gx <= 3; gx++) {
        const cam = {
          x: Math.max(minX, Math.min(maxX, ox + (gx / 3) * rad)),
          y: Math.max(minY, Math.min(maxY, oy + (gy / 3) * rad)),
        }
        const p = lookupCamToProj(map, cam)
        if (p) samples.push(p)
      }
    }
    const expandFromInset = (p: NormPoint): NormPoint => {
      // Sample sits at (1-inset) along center→corner; push back out to the corner
      const k = 1 / Math.max(0.05, 1 - inset)
      if (!centerProj) return p
      return {
        x: centerProj.x + (p.x - centerProj.x) * k,
        y: centerProj.y + (p.y - centerProj.y) * k,
      }
    }
    if (samples.length >= 3) {
      return expandFromInset({
        x: median(samples.map((p) => p.x)),
        y: median(samples.map((p) => p.y)),
      })
    }
    if (samples.length >= 1) return expandFromInset(samples[0])

    let found: NormPoint | null = null
    let foundT = 0
    for (let t = 0.05; t <= 0.9; t += 0.05) {
      const cam = {
        x: corner.x + (cx - corner.x) * t,
        y: corner.y + (cy - corner.y) * t,
      }
      const hit = lookupCamToProj(map, cam)
      if (hit) {
        found = hit
        foundT = t
        break
      }
    }
    if (found && centerProj && foundT > 0.001 && foundT < 0.99) {
      const k = foundT / (1 - foundT)
      return {
        x: found.x + (found.x - centerProj.x) * k,
        y: found.y + (found.y - centerProj.y) * k,
      }
    }
    return found
  }

  const out: NormPoint[] = []
  for (let i = 0; i < 4; i++) {
    const p = cornerProj(quad[i])
    if (!p) return null
    out.push({
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    })
  }
  return repairMappedQuad(out)
}

/** Triangle area (unsigned) in normalized space. */
function triArea(a: NormPoint, b: NormPoint, c: NormPoint) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) * 0.5
}

/** True if segments AB and CD properly intersect. */
function segmentsCross(a: NormPoint, b: NormPoint, c: NormPoint, d: NormPoint) {
  const cross = (p: NormPoint, q: NormPoint, r: NormPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/**
 * Keep TL,TR,BR,BL topology. Fix bowties. Do NOT invent axis-aligned rectangles —
 * that turned triangles / skinny faces into boxes on the wall.
 */
export function repairMappedQuad(q: NormPoint[]): NormPoint[] {
  if (q.length !== 4) return q
  const out = q.map((p) => ({ x: p.x, y: p.y }))

  if (segmentsCross(out[0], out[1], out[3], out[2])) {
    const t = out[1]
    out[1] = out[2]
    out[2] = t
  }
  if (segmentsCross(out[1], out[2], out[0], out[3])) {
    const t = out[2]
    out[2] = out[3]
    out[3] = t
  }

  return out.map((p) => ({
    x: Math.max(0, Math.min(1, p.x)),
    y: Math.max(0, Math.min(1, p.y)),
  }))
}

export function mapCornersThroughGray(
  corners: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  // Keep topology for triangles / custom shapes (don't force planar quad)
  if (corners.length === 4 && looksLikeAxisAlignedRect(corners)) {
    return mapQuadThroughGray(corners, map)
  }
  const out: NormPoint[] = []
  for (const c of corners) {
    const p = lookupCamToProjRobust(map, c, c, c)
    if (!p) return null
    out.push({
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    })
  }
  return out
}

/** Point-in-polygon (ray cast). */
export function pointInPoly(p: NormPoint, poly: NormPoint[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    const hit =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi
    if (hit) inside = !inside
  }
  return inside
}

/** Convex hull (monotone chain), CCW. */
function convexHull(pts: NormPoint[]): NormPoint[] {
  if (pts.length <= 2) return pts.slice()
  const sorted = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  const cross = (o: NormPoint, a: NormPoint, b: NormPoint) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: NormPoint[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: NormPoint[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * Map a camera region → projector polygon.
 * Flat surfaces: planar / exact H (stable).
 * 3D / curved: dense gray-code lookup first — planar H drifts (“draw here, light elsewhere”).
 */
export function mapRegionThroughGray(
  camPolygon: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  if (camPolygon.length < 3) return null

  const residual = grayPlaneResidual(camPolygon, map)

  // Non-planar region: follow the real cam→proj field, not one global plane
  if (residual >= 0.025) {
    const outline = mapOutlineThroughGray(camPolygon, map, 14)
    if (outline && outline.length >= 3 && mappingCentroidOk(camPolygon, outline, map, 0.11)) {
      return outline
    }
    const dense = mapRegionDenseThroughGray(camPolygon, map)
    if (dense && dense.length >= 3 && mappingCentroidOk(camPolygon, dense, map, 0.14)) {
      return dense
    }
    const verts3d = mapExactVerticesThroughGray(camPolygon, map)
    if (verts3d && mappingCentroidOk(camPolygon, verts3d, map, 0.11)) return verts3d
  }

  // 1) Exact corner lookup — strongest “draw here → light here” on a good gray map
  const verts = mapExactVerticesThroughGray(camPolygon, map)
  if (verts && mappingCentroidOk(camPolygon, verts, map)) return verts

  // 2) 4-pt planar face fit (flat wall / single cube face)
  if (camPolygon.length === 4) {
    const quad = mapQuadThroughGray(camPolygon, map)
    if (
      quad &&
      triArea(quad[0], quad[1], quad[2]) > 0.0001 &&
      triArea(quad[0], quad[2], quad[3]) > 0.0001 &&
      mappingCentroidOk(camPolygon, quad, map)
    ) {
      return quad
    }
  }

  // 3) Local plane → exact same vertices
  const local = mapLocalHomographyThroughGray(camPolygon, map)
  if (local && local.length === camPolygon.length && mappingCentroidOk(camPolygon, local, map)) {
    return local
  }

  // Prefer any valid exact/planar result even if centroid check was strict
  if (verts) return verts
  if (camPolygon.length === 4) {
    const quad = mapQuadThroughGray(camPolygon, map)
    if (
      quad &&
      triArea(quad[0], quad[1], quad[2]) > 0.0001 &&
      triArea(quad[0], quad[2], quad[3]) > 0.0001
    ) {
      return quad
    }
  }
  if (local && local.length === camPolygon.length) return local

  // 4) 3D dense / outline as last resort for borderline residual
  const outline = mapOutlineThroughGray(camPolygon, map, 10)
  if (outline && outline.length >= 3) return outline
  if (residual >= 0.02) {
    const dense = mapRegionDenseThroughGray(camPolygon, map)
    if (dense && dense.length >= 3) return dense
  }

  return verts ?? local ?? null
}

/**
 * Pointwise cam→proj for any polygon (densified edges). Best on 3D / curved objects.
 */
export function mapPolygonPointwiseThroughGray(
  camPolygon: NormPoint[],
  map: CamToProjMap,
  segs = 12,
): NormPoint[] | null {
  if (camPolygon.length < 3) return null
  const outline = mapOutlineThroughGray(camPolygon, map, segs)
  if (outline && outline.length >= 3 && mappingCentroidOk(camPolygon, outline, map, 0.14)) {
    return outline
  }
  const verts = mapExactVerticesThroughGray(camPolygon, map)
  if (verts && mappingCentroidOk(camPolygon, verts, map, 0.14)) return verts
  return outline ?? verts
}

/**
 * Reject maps that land far from where the gray-code says the draw center is.
 * Stops “draw here, project over there” from a bad homography / dense contour.
 */
function mappingCentroidOk(
  camPolygon: NormPoint[],
  mapped: NormPoint[],
  map: CamToProjMap,
  maxDist = 0.08,
): boolean {
  if (mapped.length < 3) return false
  const cx = camPolygon.reduce((s, p) => s + p.x, 0) / camPolygon.length
  const cy = camPolygon.reduce((s, p) => s + p.y, 0) / camPolygon.length
  const expect = lookupCamToProj(map, { x: cx, y: cy })
  if (!expect) return true // can't verify — don't reject
  const mx = mapped.reduce((s, p) => s + p.x, 0) / mapped.length
  const my = mapped.reduce((s, p) => s + p.y, 0) / mapped.length
  return Math.hypot(mx - expect.x, my - expect.y) <= maxDist
}

/**
 * How poorly cam→proj samples fit a single plane (homography).
 * High = 3D / multi-face; low = flat wall or one cube face.
 */
function grayPlaneResidual(camPolygon: NormPoint[], map: CamToProjMap): number {
  const xs = camPolygon.map((p) => p.x)
  const ys = camPolygon.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const bw = Math.max(1e-4, maxX - minX)
  const bh = Math.max(1e-4, maxY - minY)

  const src: Point[] = []
  const dst: Point[] = []
  const grid = 10
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      const cam = {
        x: minX + (bw * i) / grid,
        y: minY + (bh * j) / grid,
      }
      if (!pointInPoly(cam, camPolygon)) continue
      const proj = lookupCamToProj(map, cam)
      if (!proj) continue
      src.push(cam)
      dst.push(proj)
    }
  }
  if (src.length < 10) return 0 // not enough evidence — treat as flat (keep working path)

  const H =
    opencvHomographyRansac(src, dst) ??
    computeHomographyRansac(src, dst, {
      iterations: 80,
      threshold: 0.02,
      minInliers: Math.max(6, Math.floor(src.length * 0.3)),
    })
  if (!H) return 0.05 // can't fit plane → likely 3D

  const errs: number[] = []
  for (let i = 0; i < src.length; i++) {
    const p = applyHomography(H, src[i])
    errs.push(Math.hypot(p.x - dst[i].x, p.y - dst[i].y))
  }
  errs.sort((a, b) => a - b)
  return errs[Math.floor(errs.length * 0.75)] ?? 0
}

/** Map each draw vertex once — same order/count as the camera shape. */
function mapExactVerticesThroughGray(
  camPolygon: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  const cx = camPolygon.reduce((s, p) => s + p.x, 0) / camPolygon.length
  const cy = camPolygon.reduce((s, p) => s + p.y, 0) / camPolygon.length
  const centerProj = lookupCamToProj(map, { x: cx, y: cy })
  const out: NormPoint[] = []
  for (const c of camPolygon) {
    let p = lookupCamToProj(map, c)
    if (!p) {
      // Mild inward search + extrapolate back (keeps tip near true corner)
      for (let t = 0.03; t <= 0.25; t += 0.03) {
        const cam = { x: c.x + (cx - c.x) * t, y: c.y + (cy - c.y) * t }
        const hit = lookupCamToProj(map, cam)
        if (hit) {
          if (centerProj) {
            const k = t / Math.max(0.05, 1 - t)
            p = {
              x: hit.x + (hit.x - centerProj.x) * k,
              y: hit.y + (hit.y - centerProj.y) * k,
            }
          } else {
            p = hit
          }
          break
        }
      }
    }
    if (!p) return null
    out.push({
      x: Math.max(0, Math.min(1, p.x)),
      y: Math.max(0, Math.min(1, p.y)),
    })
  }
  return out.length === camPolygon.length ? out : null
}

/**
 * Dense ProCam mapping for 3D objects.
 * Collects projector hits for every gray-code cell inside the camera draw,
 * rasterizes them, and extracts the real silhouette (follows cube faces, etc.).
 */
export function mapRegionDenseThroughGray(
  camPolygon: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  if (camPolygon.length < 3) return null

  const hits: NormPoint[] = []
  const area = polygonArea(camPolygon)
  const step = area < 0.02 ? 1 : area < 0.08 ? 1 : Math.max(1, Math.floor(Math.min(map.camW, map.camH) / 220))

  for (let iy = 0; iy < map.camH; iy += step) {
    for (let ix = 0; ix < map.camW; ix += step) {
      const i = iy * map.camW + ix
      const px = map.projX[i]
      const py = map.projY[i]
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      const cam: NormPoint = {
        x: ix / Math.max(1, map.camW - 1),
        y: iy / Math.max(1, map.camH - 1),
      }
      if (!pointInPoly(cam, camPolygon)) continue
      hits.push({
        x: Math.max(0, Math.min(1, px)),
        y: Math.max(0, Math.min(1, py)),
      })
    }
  }

  // Extra UV samples so small faces still get density
  const xs = camPolygon.map((p) => p.x)
  const ys = camPolygon.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const grid = area < 0.025 ? 32 : area < 0.08 ? 20 : 12
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      const cam = {
        x: minX + ((maxX - minX) * i) / grid,
        y: minY + ((maxY - minY) * j) / grid,
      }
      if (!pointInPoly(cam, camPolygon)) continue
      const p = lookupCamToProj(map, cam)
      if (p) hits.push({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })
    }
  }

  // Edge samples (preserve sharp silhouette on cube creases)
  const edgeSegs = Math.max(12, Math.min(40, Math.round(56 / camPolygon.length)))
  for (let ei = 0; ei < camPolygon.length; ei++) {
    const a = camPolygon[ei]
    const b = camPolygon[(ei + 1) % camPolygon.length]
    for (let s = 0; s < edgeSegs; s++) {
      const t = s / edgeSegs
      const cam = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const p = lookupCamToProjRobust(map, cam, a, b)
      if (p) hits.push({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })
    }
  }

  if (hits.length < 8) return null

  const outline = silhouetteFromHits(hits)
  if (outline && outline.length >= 3) return outline

  const hull = convexHull(hits)
  return hull.length >= 3 ? hull : null
}

/** Rasterize projector hits → outer contour (handles concave 3D silhouettes). */
function silhouetteFromHits(hits: NormPoint[]): NormPoint[] | null {
  const GW = 240
  const GH = 135
  const occ = new Uint8Array(GW * GH)

  for (const h of hits) {
    const ix = Math.max(0, Math.min(GW - 1, Math.round(h.x * (GW - 1))))
    const iy = Math.max(0, Math.min(GH - 1, Math.round(h.y * (GH - 1))))
    occ[iy * GW + ix] = 1
  }

  // Dilate once so thin faces stay connected across depth jumps
  const dil = new Uint8Array(occ)
  for (let y = 1; y < GH - 1; y++) {
    for (let x = 1; x < GW - 1; x++) {
      if (!occ[y * GW + x]) continue
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          dil[(y + dy) * GW + (x + dx)] = 1
        }
      }
    }
  }

  // Find seed: top-most then left-most occupied
  let seedX = -1
  let seedY = -1
  outer: for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      if (dil[y * GW + x]) {
        seedX = x
        seedY = y
        break outer
      }
    }
  }
  if (seedX < 0) return null

  const contour = mooreContour(dil, GW, GH, seedX, seedY)
  if (contour.length < 3) return null

  // Simplify to keep IPC light but preserve shape
  const simplified = simplifyPolyline(
    contour.map((c) => ({
      x: c.x / (GW - 1),
      y: c.y / (GH - 1),
    })),
    hits.length > 400 ? 0.004 : 0.0025,
  )
  return simplified.length >= 3 ? simplified : contour.map((c) => ({
    x: c.x / (GW - 1),
    y: c.y / (GH - 1),
  }))
}

/** Moore-neighborhood outer contour (clockwise). */
function mooreContour(
  occ: Uint8Array,
  w: number,
  h: number,
  startX: number,
  startY: number,
): { x: number; y: number }[] {
  // 8-connected dirs clockwise starting from W
  const dx = [-1, -1, 0, 1, 1, 1, 0, -1]
  const dy = [0, -1, -1, -1, 0, 1, 1, 1]
  const pts: { x: number; y: number }[] = []
  let x = startX
  let y = startY
  let dir = 0 // came from east → start looking west
  const maxSteps = w * h * 2
  for (let step = 0; step < maxSteps; step++) {
    pts.push({ x, y })
    // start search from dir-2 (Moore)
    let found = false
    for (let k = 0; k < 8; k++) {
      const nd = (dir + 6 + k) % 8 // turn left first
      const nx = x + dx[nd]
      const ny = y + dy[nd]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      if (!occ[ny * w + nx]) continue
      x = nx
      y = ny
      dir = nd
      found = true
      break
    }
    if (!found) break
    if (x === startX && y === startY && pts.length > 2) break
  }
  return pts
}

/** Ramer–Douglas–Peucker-lite using radial distance threshold. */
function simplifyPolyline(pts: NormPoint[], eps: number): NormPoint[] {
  if (pts.length <= 4) return pts
  const keep = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 80)) === 0)
  // Ensure we didn't over-simplify below 8 pts for 3D silhouettes
  if (keep.length >= 8) {
    // close without duplicating
    const out = keep.slice()
    const a = out[0]
    const b = out[out.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) < eps) out.pop()
    return out
  }
  // denser keep
  return pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 120)) === 0)
}

function polygonArea(poly: NormPoint[]): number {
  const xs = poly.map((p) => p.x)
  const ys = poly.map((p) => p.y)
  return Math.max(1e-8, (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)))
}

function nearPolygon(p: NormPoint, poly: NormPoint[], dist: number): boolean {
  if (pointInPoly(p, poly)) return true
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const d = pointSegDist(p, a, b)
    if (d <= dist) return true
  }
  return false
}

function pointSegDist(p: NormPoint, a: NormPoint, b: NormPoint): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy || 1e-12
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
  t = Math.max(0, Math.min(1, t))
  const qx = a.x + t * vx
  const qy = a.y + t * vy
  return Math.hypot(p.x - qx, p.y - qy)
}

/**
 * Fit a local cam→proj homography from gray cells near the shape (padded AABB),
 * then warp every vertex. Critical for small objects with few interior samples.
 */
export function mapLocalHomographyThroughGray(
  camPolygon: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  if (camPolygon.length < 3) return null
  const xs = camPolygon.map((p) => p.x)
  const ys = camPolygon.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const bw = Math.max(0.008, maxX - minX)
  const bh = Math.max(0.008, maxY - minY)
  // Pad more for tinier shapes so we still gather enough plane samples
  const pad = Math.max(0.018, Math.max(bw, bh) * 0.55)

  const src: Point[] = []
  const dst: Point[] = []
  const x0 = Math.max(0, Math.floor((minX - pad) * (map.camW - 1)))
  const x1 = Math.min(map.camW - 1, Math.ceil((maxX + pad) * (map.camW - 1)))
  const y0 = Math.max(0, Math.floor((minY - pad) * (map.camH - 1)))
  const y1 = Math.min(map.camH - 1, Math.ceil((maxY + pad) * (map.camH - 1)))
  const span = Math.max(x1 - x0, y1 - y0)
  const step = span < 40 ? 1 : span < 90 ? 2 : 3

  for (let iy = y0; iy <= y1; iy += step) {
    for (let ix = x0; ix <= x1; ix += step) {
      const i = iy * map.camW + ix
      const px = map.projX[i]
      const py = map.projY[i]
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      src.push({
        x: ix / Math.max(1, map.camW - 1),
        y: iy / Math.max(1, map.camH - 1),
      })
      dst.push({ x: px, y: py })
    }
  }

  // Dense UV samples inside the shape itself
  const grid = bw * bh < 0.02 ? 24 : 12
  if (camPolygon.length === 4) {
    for (let j = 0; j <= grid; j++) {
      for (let i = 0; i <= grid; i++) {
        const cam = bilerpQuad(camPolygon, i / grid, j / grid)
        const proj = lookupCamToProj(map, cam)
        if (!proj) continue
        src.push(cam)
        dst.push(proj)
      }
    }
  } else {
    for (let j = 0; j <= grid; j++) {
      for (let i = 0; i <= grid; i++) {
        const cam = {
          x: minX + (bw * i) / grid,
          y: minY + (bh * j) / grid,
        }
        if (!pointInPoly(cam, camPolygon)) continue
        const proj = lookupCamToProj(map, cam)
        if (!proj) continue
        src.push(cam)
        dst.push(proj)
      }
    }
  }

  if (src.length < 6) return null

  let H: Homography | null = opencvHomographyRansac(src, dst)
  if (!H) {
    H = computeHomographyRansac(src, dst, {
      iterations: Math.min(200, 60 + src.length),
      threshold: bw * bh < 0.02 ? 0.03 : 0.018,
      minInliers: Math.max(4, Math.floor(src.length * 0.22)),
    })
  }
  if (!H) return null

  // Rectangles: warp exact 4 corners (keeps size matched to the camera draw)
  if (camPolygon.length === 4) {
    const verts = camPolygon.map((c) => {
      const p = applyHomography(H!, c)
      return {
        x: Math.max(0, Math.min(1, p.x)),
        y: Math.max(0, Math.min(1, p.y)),
      }
    })
    if (
      triArea(verts[0], verts[1], verts[2]) > 0.00008 &&
      triArea(verts[0], verts[2], verts[3]) > 0.00008
    ) {
      return repairMappedQuad(verts)
    }
  }

  // Custom N-gons: warp exact vertices first (same corner count as the draw)
  if (camPolygon.length !== 4) {
    const verts = camPolygon.map((c) => {
      const p = applyHomography(H!, c)
      return {
        x: Math.max(0, Math.min(1, p.x)),
        y: Math.max(0, Math.min(1, p.y)),
      }
    })
    if (verts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return verts
  }

  // Warp densified outline as backup
  const segs = Math.max(8, Math.min(28, Math.round(36 / camPolygon.length)))
  const out: NormPoint[] = []
  for (let i = 0; i < camPolygon.length; i++) {
    const a = camPolygon[i]
    const b = camPolygon[(i + 1) % camPolygon.length]
    for (let s = 0; s < segs; s++) {
      const t = s / segs
      const cam = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const p = applyHomography(H, cam)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      out.push({
        x: Math.max(0, Math.min(1, p.x)),
        y: Math.max(0, Math.min(1, p.y)),
      })
    }
  }
  return out.length >= 3 ? out : null
}

/** True if a 4-pt poly is roughly an axis-aligned camera rectangle (drag-rect). */
function looksLikeAxisAlignedRect(poly: NormPoint[]): boolean {
  if (poly.length !== 4) return false
  const xs = poly.map((p) => p.x)
  const ys = poly.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const tol = Math.max(0.004, Math.min(maxX - minX, maxY - minY) * 0.08)
  let onBox = 0
  for (const p of poly) {
    const onV = Math.abs(p.x - minX) < tol || Math.abs(p.x - maxX) < tol
    const onH = Math.abs(p.y - minY) < tol || Math.abs(p.y - maxY) < tol
    if (onV && onH) onBox++
  }
  return onBox === 4
}

/**
 * Densify each edge and map through gray-code — keeps triangle / custom outline.
 * Falls back to vertex-only if an edge is sparse.
 */
function mapOutlineThroughGray(
  camPolygon: NormPoint[],
  map: CamToProjMap,
  segsIn?: number,
): NormPoint[] | null {
  const segs =
    segsIn ?? Math.max(10, Math.min(40, Math.round(48 / Math.max(1, camPolygon.length))))
  const boundary: NormPoint[] = []
  let edgesOk = 0

  for (let i = 0; i < camPolygon.length; i++) {
    const a = camPolygon[i]
    const b = camPolygon[(i + 1) % camPolygon.length]
    const edgePts: NormPoint[] = []
    for (let s = 0; s < segs; s++) {
      const t = s / segs
      const cam = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const p = lookupCamToProjRobust(map, cam, a, b)
      if (p) {
        edgePts.push({
          x: Math.max(0, Math.min(1, p.x)),
          y: Math.max(0, Math.min(1, p.y)),
        })
      }
    }
    if (edgePts.length >= Math.max(2, Math.floor(segs * 0.35))) edgesOk++
    boundary.push(...edgePts)
  }

  if (edgesOk === camPolygon.length && boundary.length >= camPolygon.length) {
    return boundary
  }

  // Vertex-only recovery (still same N corners when possible)
  const verts: NormPoint[] = []
  for (const c of camPolygon) {
    const p = lookupCamToProjRobust(map, c, c, c)
    if (p) {
      verts.push({
        x: Math.max(0, Math.min(1, p.x)),
        y: Math.max(0, Math.min(1, p.y)),
      })
    }
  }
  if (verts.length === camPolygon.length) return verts
  if (boundary.length >= 3) return boundary
  return verts.length >= 3 ? verts : null
}

  /** Lookup with a short walk toward edge midpoint if the tip is in a shadow gap. */
function lookupCamToProjRobust(
  map: CamToProjMap,
  cam: NormPoint,
  a: NormPoint,
  b: NormPoint,
): NormPoint | null {
  const direct = lookupCamToProj(map, cam)
  if (direct) return direct
  const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 }
  const midHit = lookupCamToProj(map, mid)
  for (let t = 0.06; t <= 0.85; t += 0.06) {
    const p = {
      x: cam.x + (mid.x - cam.x) * t,
      y: cam.y + (mid.y - cam.y) * t,
    }
    const hit = lookupCamToProj(map, p)
    if (hit) {
      // Hit is inward from the tip — extrapolate back out so corners don't shrink
      if (midHit && t > 0.001 && t < 0.95) {
        const k = t / (1 - t)
        return {
          x: Math.max(0, Math.min(1, hit.x + (hit.x - midHit.x) * k)),
          y: Math.max(0, Math.min(1, hit.y + (hit.y - midHit.y) * k)),
        }
      }
      return hit
    }
  }
  // Last try: slightly larger neighbor search around the tip — prefer direction from mid
  const tipX = Math.round(cam.x * (map.camW - 1))
  const tipY = Math.round(cam.y * (map.camH - 1))
  const maxR = 14
  let nearPx = NaN
  let nearPy = NaN
  let nearD = Infinity
  outer: for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        const ix = tipX + dx
        const iy = tipY + dy
        if (ix < 0 || iy < 0 || ix >= map.camW || iy >= map.camH) continue
        const i = iy * map.camW + ix
        const px = map.projX[i]
        const py = map.projY[i]
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue
        const d = dx * dx + dy * dy
        if (d < nearD) {
          nearD = d
          nearPx = px
          nearPy = py
        }
      }
    }
    if (Number.isFinite(nearPx)) break outer
  }
  if (!Number.isFinite(nearPx) || !Number.isFinite(nearPy)) return null
  if (midHit) {
    const distCam = Math.hypot(cam.x - mid.x, cam.y - mid.y) || 1e-6
    const hitCamApprox = Math.sqrt(nearD) / Math.max(1, Math.min(map.camW, map.camH))
    const t = Math.min(0.9, hitCamApprox / distCam)
    if (t > 0.02 && t < 0.95) {
      const k = t / (1 - t)
      return {
        x: Math.max(0, Math.min(1, nearPx + (nearPx - midHit.x) * k)),
        y: Math.max(0, Math.min(1, nearPy + (nearPy - midHit.y) * k)),
      }
    }
  }
  return { x: nearPx, y: nearPy }
}

/**
 * Camera-space polygon ≈ intersection of the user's draw with this projector's lit footprint.
 * Used so a rectangle spanning two beams splits correctly across both outputs.
 */
export function clipPolygonToGrayFootprint(
  camPolygon: NormPoint[],
  map: CamToProjMap,
): NormPoint[] | null {
  const fp = footprintFromGrayMap(map)
  if (!fp || fp.length < 4) return camPolygon.length >= 3 ? camPolygon : null

  // Fully inside this beam — keep original corners (esp. 4-pt rectangles)
  if (camPolygon.every((c) => pointInPoly(c, fp))) return camPolygon

  // Sample a dense grid in the draw ∩ footprint AABB, keep points inside both polys
  const xs = camPolygon.map((p) => p.x)
  const ys = camPolygon.map((p) => p.y)
  const fxs = fp.map((p) => p.x)
  const fys = fp.map((p) => p.y)
  const minX = Math.max(Math.min(...xs), Math.min(...fxs))
  const maxX = Math.min(Math.max(...xs), Math.max(...fxs))
  const minY = Math.max(Math.min(...ys), Math.min(...fys))
  const maxY = Math.min(Math.max(...ys), Math.max(...fys))
  if (maxX - minX < 0.01 || maxY - minY < 0.01) return null

  const pts: NormPoint[] = []
  const steps = 24
  for (let iy = 0; iy <= steps; iy++) {
    for (let ix = 0; ix <= steps; ix++) {
      const p = {
        x: minX + ((maxX - minX) * ix) / steps,
        y: minY + ((maxY - minY) * iy) / steps,
      }
      if (pointInPoly(p, camPolygon) && pointInPoly(p, fp)) pts.push(p)
    }
  }
  // Keep original corners that fall in the footprint
  for (const c of camPolygon) {
    if (pointInPoly(c, fp)) pts.push(c)
  }
  if (pts.length < 3) return null

  const hull = convexHull(pts)
  return hull.length >= 3 ? hull : null
}

/** Camera-space footprint of where the projector is visible (for yellow overlay). */
export function footprintFromGrayMap(map: CamToProjMap): NormPoint[] | null {
  const pts: NormPoint[] = []
  const step = Math.max(1, Math.floor(Math.min(map.camW, map.camH) / 80))
  for (let iy = 0; iy < map.camH; iy += step) {
    for (let ix = 0; ix < map.camW; ix += step) {
      const i = iy * map.camW + ix
      if (!Number.isFinite(map.projX[i]) || !Number.isFinite(map.projY[i])) continue
      pts.push({
        x: ix / Math.max(1, map.camW - 1),
        y: iy / Math.max(1, map.camH - 1),
      })
    }
  }
  if (pts.length < 20) return null
  const hull = convexHull(pts)
  return hull.length >= 3 ? hull : null
}

/** Union of several camera footprints (convex hull of all points). */
export function unionFootprints(fps: (NormPoint[] | null | undefined)[]): NormPoint[] | null {
  const pts: NormPoint[] = []
  for (const fp of fps) {
    if (!fp || fp.length < 3) continue
    pts.push(...fp)
  }
  if (pts.length < 3) return null
  const hull = convexHull(pts)
  return hull.length >= 3 ? hull : null
}

/** Reduce a footprint hull to TL,TR,BR,BL for align/homography fallbacks. */
export function hullToAlignQuad(hull: NormPoint[]): [
  NormPoint,
  NormPoint,
  NormPoint,
  NormPoint,
] {
  if (hull.length === 4) {
    return [hull[0], hull[1], hull[2], hull[3]]
  }
  const xs = hull.map((p) => p.x)
  const ys = hull.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const pick = (tx: number, ty: number) => {
    let best = hull[0]
    let bestD = Infinity
    for (const p of hull) {
      const d = (p.x - tx) ** 2 + (p.y - ty) ** 2
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return { x: best.x, y: best.y }
  }
  return [
    pick(minX, minY),
    pick(maxX, minY),
    pick(maxX, maxY),
    pick(minX, maxY),
  ]
}

/** How well a gray map covers a camera polygon (higher = better). */
export function scoreGrayMapForRegion(camPolygon: NormPoint[], map: CamToProjMap): number {
  if (!map || map.valid < 20 || camPolygon.length < 3) return -1
  let score = 0
  for (const c of camPolygon) {
    if (lookupCamToProj(map, c)) score += 25
  }
  for (let iy = 0; iy < map.camH; iy++) {
    for (let ix = 0; ix < map.camW; ix++) {
      const i = iy * map.camW + ix
      if (!Number.isFinite(map.projX[i]) || !Number.isFinite(map.projY[i])) continue
      const cam: NormPoint = {
        x: ix / Math.max(1, map.camW - 1),
        y: iy / Math.max(1, map.camH - 1),
      }
      if (pointInPoly(cam, camPolygon)) score += 1
    }
  }
  return score
}

/** Pick the gray map that best covers the drawn camera region. */
export function pickBestGrayMap(
  camPolygon: NormPoint[],
  maps: (CamToProjMap | null | undefined)[],
): CamToProjMap | null {
  let best: CamToProjMap | null = null
  let bestScore = -1
  for (const m of maps) {
    if (!m || m.valid < 50) continue
    const s = scoreGrayMapForRegion(camPolygon, m)
    if (s > bestScore) {
      bestScore = s
      best = m
    }
  }
  if (best) return best
  // Fallback: first valid map
  for (const m of maps) {
    if (m && m.valid >= 50) return m
  }
  return null
}

/**
 * Run full gray-code capture sequence.
 * `showPattern` should display the ImageData fullscreen on the projector and resolve when ready.
 * `grabFrame` should return a camera ImageData after exposure settles.
 */
export async function runGrayCodeCalibration(opts: {
  projW: number
  projH: number
  showPattern: (img: ImageData | 'black' | 'white') => Promise<void>
  grabFrame: () => Promise<ImageData>
  onProgress?: (p: GrayCodeProgress) => void
  settleMs?: number
  sampleStep?: number
}): Promise<CamToProjMap> {
  const settle = opts.settleMs ?? 280
  const steps = buildPatternSequence(opts.projW, opts.projH)
  const total = steps.length + 2
  const captures = new Map<string, ImageData>()

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  opts.onProgress?.({ step: 'black', index: 0, total, message: 'Capturing black frame…' })
  await opts.showPattern('black')
  await wait(settle)
  await opts.grabFrame() // discard / AE settle

  opts.onProgress?.({ step: 'white', index: 1, total, message: 'Capturing white frame…' })
  await opts.showPattern('white')
  await wait(settle)
  await opts.grabFrame()

  let i = 2
  for (const step of steps) {
    opts.onProgress?.({
      step: step.key,
      index: i,
      total,
      message: `Gray code ${step.axis.toUpperCase()} bit ${step.bit}${step.invert ? ' (inv)' : ''}…`,
    })
    const img = patternImage(opts.projW, opts.projH, step)
    await opts.showPattern(img)
    await wait(settle)
    captures.set(step.key, await opts.grabFrame())
    i++
  }

  opts.onProgress?.({ step: 'decode', index: total, total, message: 'Decoding camera→projector map…' })
  const map = buildCamToProjMap(captures, opts.projW, opts.projH, opts.sampleStep ?? 4)
  if (map.valid < 50) {
    throw new Error(
      `Gray-code decode found only ${map.valid} correspondences. Dim room lights, aim the Logitech at the projected area, and retry.`,
    )
  }
  return map
}
