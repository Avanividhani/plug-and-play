import type { NormPoint } from './surfaceDetect'

/** Shapes used when drawing projection targets on the camera. */
export type DrawShapeId =
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'octagon'
  | 'star'
  | 'freeform'

export type DrawShapeDef = {
  id: DrawShapeId
  label: string
  /** drag = bounding box; click = place corners (freeform) */
  mode: 'drag' | 'click'
}

export const DRAW_SHAPES: DrawShapeDef[] = [
  { id: 'rect', label: 'Rectangle', mode: 'drag' },
  { id: 'circle', label: 'Circle', mode: 'drag' },
  { id: 'ellipse', label: 'Ellipse', mode: 'drag' },
  { id: 'triangle', label: 'Triangle', mode: 'drag' },
  { id: 'diamond', label: 'Diamond', mode: 'drag' },
  { id: 'pentagon', label: 'Pentagon', mode: 'drag' },
  { id: 'hexagon', label: 'Hexagon', mode: 'drag' },
  { id: 'octagon', label: 'Octagon', mode: 'drag' },
  { id: 'star', label: 'Star', mode: 'drag' },
  { id: 'freeform', label: 'Freeform (poly)', mode: 'click' },
]

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

function bounds(x0: number, y0: number, x1: number, y1: number) {
  const minX = Math.min(x0, x1)
  const maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1)
  const maxY = Math.max(y0, y1)
  return {
    minX,
    maxX,
    minY,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    rx: (maxX - minX) / 2,
    ry: (maxY - minY) / 2,
    w: maxX - minX,
    h: maxY - minY,
  }
}

/** Regular N-gon inscribed in the bbox ellipse (CCW from top). */
function regularPolygon(cx: number, cy: number, rx: number, ry: number, n: number): NormPoint[] {
  const pts: NormPoint[] = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    pts.push({
      x: clamp01(cx + Math.cos(a) * rx),
      y: clamp01(cy + Math.sin(a) * ry),
    })
  }
  return pts
}

/** Smooth ellipse / circle outline. */
function ellipsePoly(cx: number, cy: number, rx: number, ry: number, segments = 36): NormPoint[] {
  return regularPolygon(cx, cy, rx, ry, segments)
}

/** 5-point star inscribed in bbox. */
function starPoly(cx: number, cy: number, rx: number, ry: number): NormPoint[] {
  const pts: NormPoint[] = []
  const inner = 0.4
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    const f = i % 2 === 0 ? 1 : inner
    pts.push({
      x: clamp01(cx + Math.cos(a) * rx * f),
      y: clamp01(cy + Math.sin(a) * ry * f),
    })
  }
  return pts
}

/**
 * Build a camera-space polygon from a drag bounding box.
 * Returns null for freeform (click mode) or tiny boxes.
 */
export function shapeFromBounds(
  id: DrawShapeId,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): NormPoint[] | null {
  if (id === 'freeform') return null
  const b = bounds(x0, y0, x1, y1)
  if (b.w < 0.02 || b.h < 0.02) return null

  switch (id) {
    case 'rect':
      return [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
      ]
    case 'circle': {
      // Inscribe circle in the shorter axis so drag stays circular
      const r = Math.min(b.rx, b.ry)
      return ellipsePoly(b.cx, b.cy, r, r, 40)
    }
    case 'ellipse':
      return ellipsePoly(b.cx, b.cy, b.rx, b.ry, 40)
    case 'triangle':
      return [
        { x: clamp01(b.cx), y: clamp01(b.minY) },
        { x: clamp01(b.maxX), y: clamp01(b.maxY) },
        { x: clamp01(b.minX), y: clamp01(b.maxY) },
      ]
    case 'diamond':
      return [
        { x: clamp01(b.cx), y: clamp01(b.minY) },
        { x: clamp01(b.maxX), y: clamp01(b.cy) },
        { x: clamp01(b.cx), y: clamp01(b.maxY) },
        { x: clamp01(b.minX), y: clamp01(b.cy) },
      ]
    case 'pentagon':
      return regularPolygon(b.cx, b.cy, b.rx, b.ry, 5)
    case 'hexagon':
      return regularPolygon(b.cx, b.cy, b.rx, b.ry, 6)
    case 'octagon':
      return regularPolygon(b.cx, b.cy, b.rx, b.ry, 8)
    case 'star':
      return starPoly(b.cx, b.cy, b.rx, b.ry)
    default:
      return null
  }
}

export function shapeLabel(id: DrawShapeId): string {
  return DRAW_SHAPES.find((s) => s.id === id)?.label ?? 'Shape'
}

export function shapeIcon(label: string): string {
  const base = label.replace(/\s+\d+$/, '').toLowerCase()
  if (base.startsWith('rect')) return '▭'
  if (base.startsWith('circle')) return '○'
  if (base.startsWith('ellipse')) return '⬭'
  if (base.startsWith('triangle')) return '△'
  if (base.startsWith('diamond')) return '◇'
  if (base.startsWith('pentagon')) return '⬠'
  if (base.startsWith('hexagon')) return '⬡'
  if (base.startsWith('octagon')) return '◎'
  if (base.startsWith('star')) return '☆'
  if (base.startsWith('freeform') || base.startsWith('curve') || base.startsWith('poly')) return '⌒'
  return '□'
}
