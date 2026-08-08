import { useEffect, useRef, useState } from 'react'
import type { BlendConfig } from './lib/blending'
import { DEFAULT_BLEND, blendWeight } from './lib/blending'
import type { CalibrationResult, Homography } from './lib/calibration'
import { drawCornerMarkers } from './lib/calibration'
import { renderGenerativeFrame, renderLivingArtFrame, type GenRecipe } from './lib/aiContent'
import type { NormPoint } from './lib/surfaceDetect'
import { makeGrayPattern } from './lib/graycode'
import { isDegenerateQuad } from './lib/seeMatch'

type Mode = 'black' | 'white' | 'markers' | 'chessboard' | 'content' | 'graycode'
type Side = 'left' | 'right'

type ContentPayload = {
  type: 'image' | 'video' | 'ai'
  url: string
  recipe: GenRecipe | null
  name: string
}

type SurfacePayload = {
  projectorIndex: number
  label: string
  corners: NormPoint[]
  homography: Homography
  inverseHomography: Homography
}

type LayerPayload = {
  id: string
  label: string
  corners: NormPoint[]
  content: ContentPayload
}

type GrayPayload =
  | { kind: 'black'; patternW?: number; patternH?: number; projectorIndex?: number }
  | { kind: 'white'; patternW?: number; patternH?: number; projectorIndex?: number }
  | {
      kind: 'pattern'
      axis: 'x' | 'y'
      bit: number
      invert: boolean
      patternW: number
      patternH: number
      projectorIndex?: number
    }

const FULL_QUAD: NormPoint[] = [
  { x: 0.05, y: 0.05 },
  { x: 0.95, y: 0.05 },
  { x: 0.95, y: 0.95 },
  { x: 0.05, y: 0.95 },
]

function cornersForClip(corners: NormPoint[] | undefined | null): NormPoint[] {
  if (corners && corners.length >= 3) return corners
  return FULL_QUAD
}

/** Expand near-collapsed / NaN quads so CSS clip-path is not empty or invalid. */
function cornersForDomClip(corners: NormPoint[] | undefined | null): NormPoint[] {
  let drawCorners = cornersForClip(corners).map((p) => ({
    x: Number.isFinite(p.x) ? p.x : 0.5,
    y: Number.isFinite(p.y) ? p.y : 0.5,
  }))
  if (
    drawCorners.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)) ||
    (drawCorners.length === 4 && isDegenerateQuad(drawCorners, 0.0004, 0.004))
  ) {
    if (drawCorners.length === 4 && drawCorners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
      const xs = drawCorners.map((p) => p.x)
      const ys = drawCorners.map((p) => p.y)
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2
      const hw = Math.max(0.04, (Math.max(...xs) - Math.min(...xs)) / 2)
      const hh = Math.max(0.04, (Math.max(...ys) - Math.min(...ys)) / 2)
      drawCorners = [
        { x: cx - hw, y: cy - hh },
        { x: cx + hw, y: cy - hh },
        { x: cx + hw, y: cy + hh },
        { x: cx - hw, y: cy + hh },
      ]
    } else {
      return FULL_QUAD
    }
  }
  return drawCorners
}

/**
 * Projector has no user gesture — React's `muted` attribute often does not set the
 * property, so autoplay fails and a black <video> would cover the canvas path.
 * Force muted + play; stay transparent/fullscreen until frames actually run, then clip.
 */
function DomProjectorVideo({
  url,
  corners,
  visible,
}: {
  url: string
  corners: NormPoint[]
  visible: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    setPlaying(false)
    const v = ref.current
    if (!v) return

    const forceMuted = () => {
      v.muted = true
      v.defaultMuted = true
      v.volume = 0
      v.setAttribute('muted', '')
    }

    const kick = () => {
      forceMuted()
      const p = v.play()
      if (p && typeof p.then === 'function') {
        void p
          .then(() => {
            if (v.readyState >= 2 && v.videoWidth > 0) setPlaying(true)
          })
          .catch((err) => console.warn('[projector] DOM video.play failed', url, err))
      }
    }

    forceMuted()
    v.playsInline = true
    v.loop = true
    v.autoplay = true
    v.preload = 'auto'

    const onReady = () => {
      kick()
      if (v.readyState >= 2 && v.videoWidth > 0 && !v.paused) setPlaying(true)
    }
    const onPlaying = () => setPlaying(true)
    const onError = () => {
      setPlaying(false)
      console.warn('[projector] DOM video error', url, v.error?.code, v.error?.message)
    }

    v.addEventListener('loadeddata', onReady)
    v.addEventListener('canplay', onReady)
    v.addEventListener('canplaythrough', onReady)
    v.addEventListener('playing', onPlaying)
    v.addEventListener('error', onError)
    kick()

    const retry = window.setInterval(() => {
      if (v.paused || v.ended) kick()
      else if (v.readyState >= 2 && v.videoWidth > 0) setPlaying(true)
    }, 500)

    return () => {
      window.clearInterval(retry)
      v.removeEventListener('loadeddata', onReady)
      v.removeEventListener('canplay', onReady)
      v.removeEventListener('canplaythrough', onReady)
      v.removeEventListener('playing', onPlaying)
      v.removeEventListener('error', onError)
    }
  }, [url])

  const clipCorners = cornersForDomClip(corners)
  // Full-screen until playback is proven, then restore shape clip.
  const useClip = playing && clipCorners.length >= 3
  const pts = clipCorners
    .map((c) => `${(c.x * 100).toFixed(2)}% ${(c.y * 100).toFixed(2)}%`)
    .join(', ')

  return (
    <video
      ref={ref}
      className="projector-dom-video"
      src={url}
      muted
      loop
      playsInline
      autoPlay
      preload="auto"
      style={{
        display: visible ? 'block' : 'none',
        zIndex: 5,
        // Transparent until playing so canvas pool video is not covered by a black frame.
        opacity: playing ? 1 : 0,
        background: 'transparent',
        clipPath: useClip ? `polygon(${pts})` : 'none',
        WebkitClipPath: useClip ? `polygon(${pts})` : 'none',
      }}
    />
  )
}

/**
 * Draw source image into a destination quad using a subdivided mesh.
 * Two affine triangles alone look like a “triangle” when one corner is weak;
 * a grid stays rectangular on cube faces.
 */
function drawImageToQuad(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  corners: NormPoint[],
  dw: number,
  dh: number,
) {
  if (corners.length !== 4) {
    ctx.save()
    ctx.beginPath()
    corners.forEach((c, i) => {
      const x = c.x * dw
      const y = c.y * dh
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.clip()
    const xs = corners.map((c) => c.x * dw)
    const ys = corners.map((c) => c.y * dh)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    ctx.drawImage(src, minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY))
    ctx.restore()
    return
  }

  const bil = (u: number, v: number) => {
    const tl = corners[0]
    const tr = corners[1]
    const br = corners[2]
    const bl = corners[3]
    const topX = tl.x + (tr.x - tl.x) * u
    const topY = tl.y + (tr.y - tl.y) * u
    const botX = bl.x + (br.x - bl.x) * u
    const botY = bl.y + (br.y - bl.y) * u
    return {
      x: (topX + (botX - topX) * v) * dw,
      y: (topY + (botY - topY) * v) * dh,
    }
  }

  const n = 6
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u0 = i / n
      const u1 = (i + 1) / n
      const v0 = j / n
      const v1 = (j + 1) / n
      const p00 = bil(u0, v0)
      const p10 = bil(u1, v0)
      const p11 = bil(u1, v1)
      const p01 = bil(u0, v1)
      const s00x = u0 * sw
      const s00y = v0 * sh
      const s10x = u1 * sw
      const s10y = v0 * sh
      const s11x = u1 * sw
      const s11y = v1 * sh
      const s01x = u0 * sw
      const s01y = v1 * sh
      fillTexturedTriangle(
        ctx,
        src,
        s00x,
        s00y,
        s10x,
        s10y,
        s11x,
        s11y,
        p00.x,
        p00.y,
        p10.x,
        p10.y,
        p11.x,
        p11.y,
      )
      fillTexturedTriangle(
        ctx,
        src,
        s00x,
        s00y,
        s11x,
        s11y,
        s01x,
        s01y,
        p00.x,
        p00.y,
        p11.x,
        p11.y,
        p01.x,
        p01.y,
      )
    }
  }
}

/** Affine texture triangle (canvas). */
function fillTexturedTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number,
  dx2: number,
  dy2: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(dx0, dy0)
  ctx.lineTo(dx1, dy1)
  ctx.lineTo(dx2, dy2)
  ctx.closePath()
  ctx.clip()

  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1)
  if (Math.abs(denom) < 1e-6) {
    ctx.restore()
    return
  }
  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom
  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom
  const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom
  const e =
    (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) /
    denom
  const f =
    (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) /
    denom

  ctx.setTransform(a, b, c, d, e, f)
  ctx.drawImage(img, 0, 0)
  ctx.restore()
}

export function ProjectorView({ index }: { index: number }) {
  const [mode, setMode] = useState<Mode>('black')
  const [blend, setBlend] = useState<BlendConfig>({ ...DEFAULT_BLEND, enabled: false })
  const [side, setSide] = useState<Side>(index === 0 ? 'left' : 'right')
  const [, setCalibration] = useState<CalibrationResult | null>(null)
  const [surface, setSurface] = useState<SurfacePayload | null>(null)
  const [content, setContent] = useState<ContentPayload | null>(null)
  const [layers, setLayers] = useState<LayerPayload[]>([])
  const [gray, setGray] = useState<GrayPayload | null>(null)

  const patternRef = useRef<HTMLCanvasElement>(null)
  const outRef = useRef<HTMLCanvasElement>(null)
  const blendCanvasRef = useRef<HTMLCanvasElement>(null)
  const srcCanvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const imgPoolRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const rafRef = useRef(0)

  useEffect(() => {
    if (!window.lumen) return
    const offs = [
      window.lumen.on('projector:mode', (payload) => {
        const { mode: m } = payload as { mode: Mode }
        setMode(m)
        if (m !== 'graycode') setGray(null)
      }),
      window.lumen.on('projector:graycode', (payload) => {
        const p = payload as GrayPayload
        if (p.projectorIndex !== undefined && p.projectorIndex !== index) return
        setGray(p)
        setMode('graycode')
      }),
      window.lumen.on('projector:config', (payload) => {
        const p = payload as { blend: BlendConfig; side: Side; projectorIndex: number }
        if (p.projectorIndex !== undefined && p.projectorIndex !== index) return
        if (p.blend) setBlend({ ...DEFAULT_BLEND, ...p.blend })
        if (p.side) setSide(p.side)
      }),
      window.lumen.on('projector:calibration', (payload) => {
        const cal = payload as CalibrationResult
        if (cal.projectorIndex === index) {
          setCalibration(cal)
          setSurface(null)
          setLayers([])
        }
      }),
      window.lumen.on('projector:surface', (payload) => {
        setSurface(payload as SurfacePayload)
      }),
      window.lumen.on('projector:content', (payload) => {
        setContent(payload as ContentPayload)
        setMode('content')
      }),
      window.lumen.on('projector:layers', (payload) => {
        const p = payload as { layers: LayerPayload[] }
        setLayers(Array.isArray(p.layers) ? p.layers : [])
        setMode('content')
      }),
    ]
    return () =>
      offs.forEach((off) => {
        off()
      })
  }, [index])

  useEffect(() => {
    const canvas = patternRef.current
    if (!canvas) return
    const w = window.innerWidth
    const h = window.innerHeight
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (mode === 'markers') drawCornerMarkers(canvas)
    else if (mode === 'chessboard') {
      import('./lib/calibration').then(({ drawChessboard }) => drawChessboard(canvas))
    } else if (mode === 'white') {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
    } else if (mode === 'black') {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
    } else if (mode === 'graycode' && gray) {
      if (gray.kind === 'black') {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, h)
      } else if (gray.kind === 'white') {
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, w, h)
      } else {
        const lw = gray.patternW || 512
        const lh = gray.patternH || 288
        const img = makeGrayPattern(lw, lh, gray.bit, gray.axis, gray.invert)
        const off = document.createElement('canvas')
        off.width = lw
        off.height = lh
        off.getContext('2d')!.putImageData(img, 0, 0)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(off, 0, 0, w, h)
      }
    }
  }, [mode, gray])

  const applyBlendOverlay = () => {
    const canvas = blendCanvasRef.current
    if (!canvas) return
    const w = window.innerWidth
    const h = window.innerHeight
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const gain =
      side === 'left' ? (blend.leftGain ?? 1) : (blend.rightGain ?? 1)
    const needGain = gain < 0.995
    if (!blend.enabled && !needGain) {
      ctx.clearRect(0, 0, w, h)
      return
    }
    const img = ctx.createImageData(w, h)
    for (let x = 0; x < w; x++) {
      const edgeW = blend.enabled ? blendWeight(x / (w - 1), side, blend) : 1
      const combined = Math.max(0, Math.min(1, edgeW * gain))
      const a = Math.round((1 - combined) * 255)
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4
        img.data[i] = 0
        img.data[i + 1] = 0
        img.data[i + 2] = 0
        img.data[i + 3] = a
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  // Paint one or many content layers onto the projector
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    const activeLayers: LayerPayload[] =
      layers.length > 0
        ? layers
            .filter((l) => l.content)
            .map((l) => ({
              ...l,
              corners: cornersForClip(l.corners),
            }))
        : content
          ? [
              {
                id: 'single',
                label: surface?.label || 'Surface',
                corners: cornersForClip(surface?.corners),
                content,
              },
            ]
          : []

    if ((mode !== 'content' && !(mode === 'white' && activeLayers.length > 0)) || activeLayers.length === 0)
      return

    const out = outRef.current
    const src = srcCanvasRef.current
    if (!out || !src) return

    const w = window.innerWidth
    const h = window.innerHeight
    out.width = w
    out.height = h
    src.width = 960
    src.height = 540
    const outCtx = out.getContext('2d')
    const srcCtx = src.getContext('2d')
    if (!outCtx || !srcCtx) return

    const ensureVideo = (url: string) => {
      let v = videoPoolRef.current.get(url)
      if (!v) {
        v = document.createElement('video')
        v.muted = true
        v.defaultMuted = true
        v.volume = 0
        v.loop = true
        v.playsInline = true
        v.autoplay = true
        v.preload = 'auto'
        v.setAttribute('playsinline', 'true')
        v.setAttribute('muted', 'true')
        v.setAttribute('webkit-playsinline', 'true')
        // Never set crossOrigin — it can block localhost Range streaming / taint canvas.
        v.src = url
        v.load()
        const kick = () => {
          void v!.play().catch((err) => console.warn('[projector] video.play failed', url, err))
        }
        v.addEventListener('loadeddata', kick)
        v.addEventListener('canplay', kick)
        v.addEventListener('canplaythrough', kick)
        v.addEventListener('ended', () => {
          try {
            v!.currentTime = 0
          } catch {
            /* ignore */
          }
          kick()
        })
        v.addEventListener('error', () => {
          console.warn('[projector] video error', url, v?.error?.code, v?.error?.message)
        })
        kick()
        videoPoolRef.current.set(url, v)
      } else if (v.paused || v.ended) {
        void v.play().catch(() => {})
      }
      return v
    }
    const ensureImg = (url: string) => {
      let im = imgPoolRef.current.get(url)
      if (!im) {
        im = new Image()
        im.src = url
        imgPoolRef.current.set(url, im)
      }
      return im
    }

    for (const layer of activeLayers) {
      if (layer.content.type === 'video' && layer.content.url) ensureVideo(layer.content.url)
      if (
        (layer.content.type === 'image' || layer.content.type === 'ai') &&
        layer.content.url
      ) {
        ensureImg(layer.content.url)
      }
    }

    const start = performance.now()

    const paintLayer = (layer: LayerPayload, t: number) => {
      const c = layer.content
      const solidWhite = c.type === 'ai' && c.recipe?.mode === 'white'
      // Never paint opaque white under video — if frames aren't ready, leave black
      // so a failed DOM <video> doesn't look like a "stuck white face".
      srcCtx.fillStyle = c.type === 'video' ? '#000' : '#fff'
      srcCtx.fillRect(0, 0, src.width, src.height)
      if (!solidWhite) {
        if (
          c.type === 'ai' &&
          c.recipe &&
          (c.recipe.mode === 'livingArt' || c.recipe.mode === 'photoMotion')
        ) {
          const im = c.url ? ensureImg(c.url) : null
          renderLivingArtFrame(
            srcCtx,
            src.width,
            src.height,
            c.recipe,
            t,
            im && im.complete && im.naturalWidth > 0 ? im : null,
          )
        } else if (c.type === 'ai' && c.recipe) {
          renderGenerativeFrame(srcCtx, src.width, src.height, c.recipe, t)
        } else if (c.type === 'video' && c.url) {
          // Canvas backup while DomProjectorVideo is opacity:0 until play succeeds.
          const v = ensureVideo(c.url)
          if (v.paused || v.ended) void v.play().catch(() => {})
          try {
            if (v.readyState >= 2 && v.videoWidth > 0) {
              srcCtx.drawImage(v, 0, 0, src.width, src.height)
            } else {
              // No frame yet — skip warping a black/white plate over the shape.
              return
            }
          } catch (err) {
            console.warn('[projector] drawImage(video) failed', err)
            return
          }
        } else if (c.type === 'image' && c.url) {
          const im = ensureImg(c.url)
          if (im.complete) srcCtx.drawImage(im, 0, 0, src.width, src.height)
        }
      }

      let drawCorners = layer.corners
      if (drawCorners.length === 4 && isDegenerateQuad(drawCorners, 0.0004, 0.004)) {
        const xs = drawCorners.map((p) => p.x)
        const ys = drawCorners.map((p) => p.y)
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2
        const hw = Math.max(0.04, (Math.max(...xs) - Math.min(...xs)) / 2)
        const hh = Math.max(0.04, (Math.max(...ys) - Math.min(...ys)) / 2)
        drawCorners = [
          { x: cx - hw, y: cy - hh },
          { x: cx + hw, y: cy - hh },
          { x: cx + hw, y: cy + hh },
          { x: cx - hw, y: cy + hh },
        ]
      }

      if (solidWhite || drawCorners.length !== 4) {
        outCtx.beginPath()
        drawCorners.forEach((p, i) => {
          const x = p.x * w
          const y = p.y * h
          if (i === 0) outCtx.moveTo(x, y)
          else outCtx.lineTo(x, y)
        })
        outCtx.closePath()
        if (solidWhite) {
          outCtx.fillStyle = '#fff'
          outCtx.fill('nonzero')
        } else {
          const xs = drawCorners.map((p) => p.x * w)
          const ys = drawCorners.map((p) => p.y * h)
          const minX = Math.min(...xs)
          const maxX = Math.max(...xs)
          const minY = Math.min(...ys)
          const maxY = Math.max(...ys)
          const bw = Math.max(1, maxX - minX)
          const bh = Math.max(1, maxY - minY)
          const cx = xs.reduce((a, b) => a + b, 0) / xs.length
          const cy = ys.reduce((a, b) => a + b, 0) / ys.length
          outCtx.save()
          for (let i = 0; i < drawCorners.length; i++) {
            const a = drawCorners[i]
            const b = drawCorners[(i + 1) % drawCorners.length]
            outCtx.beginPath()
            outCtx.moveTo(cx, cy)
            outCtx.lineTo(a.x * w, a.y * h)
            outCtx.lineTo(b.x * w, b.y * h)
            outCtx.closePath()
            outCtx.save()
            outCtx.clip()
            outCtx.drawImage(src, minX, minY, bw, bh)
            outCtx.restore()
          }
          outCtx.restore()
        }
      } else {
        drawImageToQuad(outCtx, src, src.width, src.height, drawCorners, w, h)
      }
    }

    const paint = (now: number) => {
      const t = (now - start) / 1000
      outCtx.fillStyle = '#000'
      outCtx.fillRect(0, 0, w, h)
      for (const layer of activeLayers) paintLayer(layer, t)
      applyBlendOverlay()
      rafRef.current = requestAnimationFrame(paint)
    }

    rafRef.current = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, content, surface, layers, blend, side])

  useEffect(() => {
    applyBlendOverlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blend, side, mode])

  const showPattern =
    mode === 'markers' ||
    mode === 'chessboard' ||
    mode === 'black' ||
    mode === 'graycode' ||
    (mode === 'white' && layers.length === 0 && !content)
  // Prefer layers over a stale white flash (openProjector briefly sets mode white).
  const showContent =
    (layers.length > 0 || !!content) &&
    mode !== 'markers' &&
    mode !== 'chessboard' &&
    mode !== 'graycode' &&
    mode !== 'black'

  const blendActive =
    blend.enabled ||
    (side === 'left' ? (blend.leftGain ?? 1) : (blend.rightGain ?? 1)) < 0.995

  const videoLayers =
    showContent
      ? (layers.length > 0
          ? layers
          : content
            ? [
                {
                  id: 'single',
                  label: content.name,
                  corners: cornersForClip(surface?.corners),
                  content,
                },
              ]
            : []
        ).filter((l) => l.content.type === 'video' && !!l.content.url)
      : []

  // When DOM video is up, keep edge-blend under it (canvas@2 < blend@3 < video@5).
  // Covering <video> with a full-size blend canvas was a common "video never shows" failure.
  const blendZ = videoLayers.length > 0 ? 3 : blendActive ? 10 : 0

  return (
    <div className="projector-root">
      <canvas ref={patternRef} style={{ display: showPattern ? 'block' : 'none', zIndex: 1 }} />
      <canvas ref={outRef} style={{ display: showContent ? 'block' : 'none', zIndex: 2 }} />
      <canvas
        ref={blendCanvasRef}
        style={{
          display: blendActive ? 'block' : 'none',
          zIndex: blendZ,
          pointerEvents: 'none',
          mixBlendMode: 'normal',
        }}
      />
      {/* DOM <video>: forced muted autoplay; fullscreen until playing, then shape clip */}
      {videoLayers.map((layer) => (
        <DomProjectorVideo
          key={`dom-vid-${layer.id}-${layer.content.url}`}
          url={layer.content.url}
          corners={layer.corners}
          visible={showContent}
        />
      ))}
      <canvas ref={srcCanvasRef} style={{ display: 'none' }} />
      <video ref={videoRef} muted loop playsInline style={{ display: 'none' }} />
      <img ref={imgRef} alt="" style={{ display: 'none' }} />
    </div>
  )
}
