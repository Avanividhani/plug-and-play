/**
 * OpenCV.js helpers — loaded lazily so the UI never goes blank waiting on the WASM bundle.
 */

import type { NormPoint } from './surfaceDetect'
import type { Quad } from './seeMatch'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any

let readyPromise: Promise<Cv> | null = null

export function loadOpenCV(): Promise<Cv> {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    const mod = await import('@techstark/opencv-js')
    const anyCv = (mod.default ?? mod) as Cv
    if (anyCv.Mat) return anyCv
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV load timeout')), 90000)
      const poll = setInterval(() => {
        if (anyCv.Mat) {
          clearTimeout(timer)
          clearInterval(poll)
          resolve()
        }
      }, 50)
      const prev = anyCv.onRuntimeInitialized
      anyCv.onRuntimeInitialized = () => {
        clearTimeout(timer)
        clearInterval(poll)
        if (typeof prev === 'function') prev()
        resolve()
      }
    })
    return anyCv
  })()
  return readyPromise
}

function imageDataToMat(c: Cv, img: ImageData) {
  return c.matFromImageData(img)
}

function orderQuadNorm(pts: NormPoint[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  )
  let best = 0
  let bestScore = Infinity
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i].x + sorted[i].y
    if (s < bestScore) {
      bestScore = s
      best = i
    }
  }
  const rot = [...sorted.slice(best), ...sorted.slice(0, best)]
  if (rot.length < 4) {
    return [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ]
  }
  if (rot[1].x < rot[0].x) {
    return [rot[0], rot[3], rot[2], rot[1]] as Quad
  }
  return [rot[0], rot[1], rot[2], rot[3]] as Quad
}

function contourToQuad(c: Cv, contour: Cv, width: number, height: number): Quad | null {
  const peri = c.arcLength(contour, true)
  const approx = new c.Mat()
  c.approxPolyDP(contour, approx, 0.04 * peri, true)

  let pts: NormPoint[] = []
  if (approx.rows >= 4) {
    for (let i = 0; i < Math.min(approx.rows, 8); i++) {
      const x = approx.intAt(i, 0)
      const y = approx.intAt(i, 1)
      pts.push({ x: x / width, y: y / height })
    }
  }
  approx.delete()

  if (pts.length < 4) {
    const rect = c.boundingRect(contour)
    pts = [
      { x: rect.x / width, y: rect.y / height },
      { x: (rect.x + rect.width) / width, y: rect.y / height },
      { x: (rect.x + rect.width) / width, y: (rect.y + rect.height) / height },
      { x: rect.x / width, y: (rect.y + rect.height) / height },
    ]
  }

  if (pts.length > 4) {
    const targets = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    pts = targets.map((t) => {
      let best = pts[0]
      let bestD = Infinity
      for (const p of pts) {
        const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      return { ...best }
    })
  }

  return orderQuadNorm(pts)
}

export async function opencvDetectFootprint(
  blackFrame: ImageData,
  whiteFrame: ImageData,
): Promise<{ quad: Quad; coverage: number; ok: boolean }> {
  const c = await loadOpenCV()
  const black = imageDataToMat(c, blackFrame)
  const white = imageDataToMat(c, whiteFrame)
  const grayB = new c.Mat()
  const grayW = new c.Mat()
  const diff = new c.Mat()
  const bin = new c.Mat()
  const morph = new c.Mat()

  try {
    c.cvtColor(black, grayB, c.COLOR_RGBA2GRAY)
    c.cvtColor(white, grayW, c.COLOR_RGBA2GRAY)
    c.absdiff(grayW, grayB, diff)
    c.threshold(diff, bin, 0, 255, c.THRESH_BINARY + c.THRESH_OTSU)

    const k = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(7, 7))
    c.morphologyEx(bin, morph, c.MORPH_CLOSE, k)
    c.morphologyEx(morph, morph, c.MORPH_OPEN, k)
    k.delete()

    const contours = new c.MatVector()
    const hierarchy = new c.Mat()
    c.findContours(morph, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE)

    let bestIdx = -1
    let bestArea = 0
    for (let i = 0; i < contours.size(); i++) {
      const a = c.contourArea(contours.get(i))
      if (a > bestArea) {
        bestArea = a
        bestIdx = i
      }
    }

    const frameArea = whiteFrame.width * whiteFrame.height
    const coverage = bestArea / frameArea
    const fallbackQuad: Quad = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ]

    let quad: Quad = fallbackQuad
    if (bestIdx >= 0 && bestArea > frameArea * 0.01) {
      quad = contourToQuad(c, contours.get(bestIdx), whiteFrame.width, whiteFrame.height) ?? fallbackQuad
    } else {
      c.threshold(grayW, bin, 0, 255, c.THRESH_BINARY + c.THRESH_OTSU)
      c.findContours(bin, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE)
      bestIdx = -1
      bestArea = 0
      for (let i = 0; i < contours.size(); i++) {
        const a = c.contourArea(contours.get(i))
        if (a > bestArea) {
          bestArea = a
          bestIdx = i
        }
      }
      if (bestIdx >= 0) {
        quad =
          contourToQuad(c, contours.get(bestIdx), whiteFrame.width, whiteFrame.height) ?? fallbackQuad
      }
    }

    contours.delete()
    hierarchy.delete()
    return { quad, coverage: Math.max(coverage, 0.05), ok: coverage >= 0.02 && coverage <= 0.5 }
  } finally {
    black.delete()
    white.delete()
    grayB.delete()
    grayW.delete()
    diff.delete()
    bin.delete()
    morph.delete()
  }
}

/** OpenCV probe blob: absdiff black vs probe-white, reject whole-frame results. */
export async function opencvDetectProbeBlob(
  blackFrame: ImageData,
  probeFrame: ImageData,
): Promise<{ quad: Quad; coverage: number; ok: boolean }> {
  const c = await loadOpenCV()
  const black = imageDataToMat(c, blackFrame)
  const white = imageDataToMat(c, probeFrame)
  const grayB = new c.Mat()
  const grayW = new c.Mat()
  const diff = new c.Mat()
  const bin = new c.Mat()
  const morph = new c.Mat()

  try {
    c.cvtColor(black, grayB, c.COLOR_RGBA2GRAY)
    c.cvtColor(white, grayW, c.COLOR_RGBA2GRAY)
    c.absdiff(grayW, grayB, diff)
    c.threshold(diff, bin, 0, 255, c.THRESH_BINARY + c.THRESH_OTSU)
    const k = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(9, 9))
    c.morphologyEx(bin, morph, c.MORPH_CLOSE, k)
    c.morphologyEx(morph, morph, c.MORPH_OPEN, k)
    k.delete()

    const contours = new c.MatVector()
    const hierarchy = new c.Mat()
    c.findContours(morph, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE)

    const frameArea = probeFrame.width * probeFrame.height
    let bestIdx = -1
    let bestArea = 0
    for (let i = 0; i < contours.size(); i++) {
      const a = c.contourArea(contours.get(i))
      if (a > bestArea) {
        bestArea = a
        bestIdx = i
      }
    }
    const coverage = bestArea / frameArea
    // Probe is ~64% of projector area in PROBE_QUAD; in camera it is usually smaller
    if (bestIdx < 0 || coverage < 0.02 || coverage > 0.45) {
      contours.delete()
      hierarchy.delete()
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
    const quad =
      contourToQuad(c, contours.get(bestIdx), probeFrame.width, probeFrame.height) ??
      ([
        { x: 0.3, y: 0.25 },
        { x: 0.7, y: 0.25 },
        { x: 0.7, y: 0.65 },
        { x: 0.3, y: 0.65 },
      ] as Quad)

    // Reject nonsense skinny / edge blobs
    const xs = quad.map((p) => p.x)
    const ys = quad.map((p) => p.y)
    const bw = Math.max(...xs) - Math.min(...xs)
    const bh = Math.max(...ys) - Math.min(...ys)
    if (bw < 0.08 || bh < 0.08 || bw / bh > 4 || bh / bw > 4) {
      contours.delete()
      hierarchy.delete()
      return { ok: false, coverage, quad }
    }

    contours.delete()
    hierarchy.delete()
    return { quad, coverage, ok: true }
  } finally {
    black.delete()
    white.delete()
    grayB.delete()
    grayW.delete()
    diff.delete()
    bin.delete()
    morph.delete()
  }
}

export async function opencvScanSurfaces(
  frame: ImageData,
  maxSurfaces = 5,
): Promise<{ label: string; corners: Quad; confidence: number }[]> {
  const c = await loadOpenCV()
  const src = imageDataToMat(c, frame)
  const gray = new c.Mat()
  const blur = new c.Mat()
  const edges = new c.Mat()
  const closed = new c.Mat()

  try {
    c.cvtColor(src, gray, c.COLOR_RGBA2GRAY)
    c.GaussianBlur(gray, blur, new c.Size(5, 5), 0)
    c.Canny(blur, edges, 40, 120)
    const k = c.getStructuringElement(c.MORPH_RECT, new c.Size(5, 5))
    c.morphologyEx(edges, closed, c.MORPH_CLOSE, k)
    k.delete()

    const contours = new c.MatVector()
    const hierarchy = new c.Mat()
    c.findContours(closed, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE)

    const frameArea = frame.width * frame.height
    const candidates: { area: number; quad: Quad }[] = []
    for (let i = 0; i < contours.size(); i++) {
      const a = c.contourArea(contours.get(i))
      if (a < frameArea * 0.03 || a > frameArea * 0.7) continue
      const q = contourToQuad(c, contours.get(i), frame.width, frame.height)
      if (q) candidates.push({ area: a, quad: q })
    }
    candidates.sort((a, b) => b.area - a.area)

    const labels = ['Table', 'Wall', 'Surface', 'Panel', 'Area']
    const out = candidates.slice(0, maxSurfaces).map((cand, i) => {
      const cy = cand.quad.reduce((s, p) => s + p.y, 0) / 4
      let label = labels[i] || `Surface ${i + 1}`
      if (cy > 0.55) label = i === 0 ? 'Table' : label
      else if (cy < 0.4) label = i === 0 ? 'Wall' : label
      return {
        label,
        corners: cand.quad,
        confidence: Math.min(0.95, 0.45 + cand.area / frameArea),
      }
    })

    contours.delete()
    hierarchy.delete()
    return out
  } finally {
    src.delete()
    gray.delete()
    blur.delete()
    edges.delete()
    closed.delete()
  }
}

/** Cached after first load — enables sync RANSAC homography during draw mapping. */
let cachedCv: Cv | null = null

export async function warmOpenCV(): Promise<Cv> {
  const c = await loadOpenCV()
  cachedCv = c
  return c
}

export function getOpenCVSync(): Cv | null {
  return cachedCv
}

/**
 * OpenCV findHomography (RANSAC) — sharper plane fit for cube faces than pure JS DLT.
 * Returns 3×3 row-major homography, or null if OpenCV isn’t ready / fit fails.
 */
export function opencvHomographyRansac(
  src: { x: number; y: number }[],
  dst: { x: number; y: number }[],
): number[] | null {
  const c = cachedCv
  if (!c?.findHomography || src.length < 4 || dst.length < 4) return null
  const n = Math.min(src.length, dst.length)
  const srcMat = c.matFromArray(
    n,
    1,
    c.CV_32FC2,
    src.slice(0, n).flatMap((p) => [p.x, p.y]),
  )
  const dstMat = c.matFromArray(
    n,
    1,
    c.CV_32FC2,
    dst.slice(0, n).flatMap((p) => [p.x, p.y]),
  )
  const mask = new c.Mat()
  try {
    const H = c.findHomography(srcMat, dstMat, c.RANSAC, 0.012, mask)
    if (!H || H.empty()) {
      H?.delete()
      return null
    }
    const data = H.data64F?.length ? H.data64F : H.data32F
    if (!data || data.length < 9) {
      H.delete()
      return null
    }
    const out = Array.from(data.slice(0, 9)) as number[]
    H.delete()
    // Need a decent inlier ratio
    let inliers = 0
    if (mask.rows) {
      for (let i = 0; i < mask.rows; i++) {
        if (mask.ucharAt(i, 0)) inliers++
      }
    }
    if (inliers < Math.max(4, Math.floor(n * 0.25))) return null
    return out
  } catch {
    return null
  } finally {
    srcMat.delete()
    dstMat.delete()
    mask.delete()
  }
}
