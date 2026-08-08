/** Local generative “AI” content — procedural motion graphics from a text prompt. */

export type GeneratedClip = {
  id: string
  title: string
  prompt: string
  createdAt: number
  /** data URL of a short animated preview (canvas frames as webp still + recipe) */
  thumbnail: string
  recipe: GenRecipe
}

export type LiveStyle = 'aurora' | 'liquid' | 'embers' | 'ribbons' | 'pulse' | 'field' | 'scan'

export type GenRecipe = {
  palette: string[]
  mode:
    | 'orbits'
    | 'ribbons'
    | 'field'
    | 'pulse'
    | 'lattice'
    | 'aurora'
    | 'liquid'
    | 'embers'
    | 'scan'
    | 'white'
    | 'whitePulse'
    | 'whiteGrid'
    /** SD still + animated generative life (no zoom) — needs MediaItem.url */
    | 'livingArt'
    /** Legacy alias for livingArt */
    | 'photoMotion'
  /** Which motion language to play over a livingArt still */
  liveStyle?: LiveStyle
  speed: number
  density: number
  seed: number
}

const PALETTES = [
  ['#3dd6c6', '#5b8def', '#0a0c0f', '#e8edf4'],
  ['#f0a060', '#e85d6a', '#1a1020', '#ffe8d6'],
  ['#5ed68a', '#3dd6c6', '#0c1410', '#d8ffe8'],
  ['#c4a8ff', '#7b6cff', '#120f1c', '#eee8ff'],
  ['#ff6b9d', '#c44dff', '#0f0a14', '#ffd6ea'],
  ['#ffe566', '#3dd6c6', '#10140a', '#fff8d0'],
]

function hashPrompt(prompt: string): number {
  let h = 2166136261
  for (let i = 0; i < prompt.length; i++) {
    h ^= prompt.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function pickLiveStyle(prompt: string, seed: number): LiveStyle {
  const p = prompt.toLowerCase()
  if (/ocean|wave|fluid|water|liquid|river/.test(p)) return 'liquid'
  if (/fire|ember|spark|lava|magma|flame/.test(p)) return 'embers'
  if (/aurora|northern|glow|dream|fog|mist/.test(p)) return 'aurora'
  if (/neon|pulse|beat|music|party|club/.test(p)) return 'pulse'
  if (/scan|tech|cyber|glitch|matrix|hud/.test(p)) return 'scan'
  if (/ribbon|silk|fabric|flow|stream/.test(p)) return 'ribbons'
  if (/star|dust|snow|particle|field|ash/.test(p)) return 'field'
  const styles: LiveStyle[] = ['aurora', 'liquid', 'embers', 'ribbons', 'pulse', 'field', 'scan']
  return styles[seed % styles.length]
}

function pickMode(prompt: string, seed: number): GenRecipe['mode'] {
  const style = pickLiveStyle(prompt, seed)
  if (style === 'aurora') return 'aurora'
  if (style === 'liquid') return 'liquid'
  if (style === 'embers') return 'embers'
  if (style === 'scan') return 'scan'
  if (style === 'ribbons') return 'ribbons'
  if (style === 'pulse') return 'pulse'
  if (style === 'field') return 'field'
  const modes: GenRecipe['mode'][] = ['orbits', 'ribbons', 'field', 'pulse', 'lattice', 'aurora']
  return modes[seed % modes.length]
}

export function recipeFromPrompt(prompt: string): GenRecipe {
  const seed = hashPrompt(prompt.trim() || 'lumen')
  const liveStyle = pickLiveStyle(prompt, seed)
  return {
    palette: PALETTES[seed % PALETTES.length],
    mode: pickMode(prompt, seed),
    liveStyle,
    speed: 0.45 + ((seed >> 3) % 90) / 100,
    density: 0.55 + ((seed >> 9) % 70) / 100,
    seed,
  }
}

/** Cover-fit image into canvas (no zoom animation). */
export function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  w: number,
  h: number,
  nw: number,
  nh: number,
) {
  const scale = Math.max(w / Math.max(1, nw), h / Math.max(1, nh))
  const dw = nw * scale
  const dh = nh * scale
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
}

function rndFn(seed: number) {
  return (n: number) => {
    const x = Math.sin(n * 127.1 + seed * 0.001) * 43758.5453
    return x - Math.floor(x)
  }
}

/** Animated overlays that actually move — used alone or over an SD still. */
export function paintMotionOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  style: LiveStyle,
  palette: string[],
  density: number,
  seed: number,
  time: number,
) {
  const rnd = rndFn(seed)
  const c0 = palette[0] || '#3dd6c6'
  const c1 = palette[1] || '#5b8def'

  if (style === 'aurora') {
    for (let i = 0; i < 7; i++) {
      const cx = w * (0.15 + 0.7 * rnd(i) + 0.12 * Math.sin(time * 0.7 + i))
      const cy = h * (0.2 + 0.35 * Math.sin(time * 0.85 + i * 1.3) + rnd(i + 2) * 0.35)
      const r = Math.min(w, h) * (0.28 + rnd(i + 3) * 0.35)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, i % 2 ? c0 : c1)
      g.addColorStop(1, 'transparent')
      ctx.globalAlpha = 0.42
      ctx.globalCompositeOperation = 'screen'
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  if (style === 'liquid') {
    ctx.lineWidth = 4
    ctx.globalCompositeOperation = 'screen'
    const bands = Math.floor(5 + density * 6)
    for (let r = 0; r < bands; r++) {
      ctx.strokeStyle = r % 2 ? c0 : c1
      ctx.globalAlpha = 0.45
      ctx.beginPath()
      for (let x = 0; x <= w; x += 6) {
        const y =
          h * (0.35 + r * 0.08) +
          Math.sin(x * 0.012 + time * 1.4 + r) * (28 + r * 10) +
          Math.sin(x * 0.03 - time * 0.9 + r) * 16
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    // Rising bubbles
    const n = Math.floor(20 + density * 40)
    for (let i = 0; i < n; i++) {
      const x = rnd(i) * w
      const y = ((rnd(i + 1) * 0.7 + time * 0.12 * (0.4 + rnd(i + 2))) % 1) * h
      ctx.globalAlpha = 0.35
      ctx.fillStyle = c0
      ctx.beginPath()
      ctx.arc(x, y, 2 + rnd(i + 4) * 5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  if (style === 'embers') {
    ctx.globalCompositeOperation = 'screen'
    const n = Math.floor(50 + density * 120)
    for (let i = 0; i < n; i++) {
      const x = rnd(i) * w + Math.sin(time + i) * 8
      const y = h - ((rnd(i + 1) + time * 0.08 * (0.5 + rnd(i + 2))) % 1) * h * 1.1
      const r = 1.5 + rnd(i + 5) * 4
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3)
      g.addColorStop(0, c0)
      g.addColorStop(0.4, c1)
      g.addColorStop(1, 'transparent')
      ctx.globalAlpha = 0.5 + rnd(i + 6) * 0.5
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r * 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  if (style === 'ribbons') {
    ctx.lineWidth = 3.5
    ctx.globalCompositeOperation = 'screen'
    const ribbons = Math.floor(5 + density * 8)
    for (let r = 0; r < ribbons; r++) {
      ctx.strokeStyle = r % 2 ? c0 : c1
      ctx.globalAlpha = 0.5
      ctx.beginPath()
      for (let x = 0; x <= w; x += 7) {
        const y =
          h / 2 +
          Math.sin(x * 0.009 + time * 1.2 + r) * (50 + r * 14) +
          Math.sin(x * 0.022 - time * 0.8 + r * 2) * 24
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  if (style === 'pulse') {
    ctx.globalCompositeOperation = 'screen'
    const rings = Math.floor(4 + density * 5)
    for (let i = 0; i < rings; i++) {
      const phase = (time * 0.55 + i / rings) % 1
      const r = phase * Math.max(w, h) * 0.65
      ctx.strokeStyle = i % 2 ? c0 : c1
      ctx.globalAlpha = (1 - phase) * 0.7
      ctx.lineWidth = 3 + (1 - phase) * 12
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2)
      ctx.stroke()
    }
    const cx = w * (0.5 + 0.2 * Math.sin(time * 0.9))
    const cy = h * (0.5 + 0.15 * Math.cos(time * 0.7))
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.35)
    g.addColorStop(0, c0)
    g.addColorStop(1, 'transparent')
    ctx.globalAlpha = 0.35
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  if (style === 'scan') {
    ctx.globalCompositeOperation = 'screen'
    const y = ((time * 0.25) % 1) * h
    const g = ctx.createLinearGradient(0, y - 40, 0, y + 40)
    g.addColorStop(0, 'transparent')
    g.addColorStop(0.5, c0)
    g.addColorStop(1, 'transparent')
    ctx.globalAlpha = 0.55
    ctx.fillStyle = g
    ctx.fillRect(0, y - 40, w, 80)
    ctx.strokeStyle = c1
    ctx.globalAlpha = 0.25
    ctx.lineWidth = 1
    for (let yy = 0; yy < h; yy += 6) {
      ctx.beginPath()
      ctx.moveTo(0, yy + Math.sin(time + yy * 0.1) * 2)
      ctx.lineTo(w, yy)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  // field
  ctx.globalCompositeOperation = 'screen'
  const n = Math.floor(90 + density * 180)
  for (let i = 0; i < n; i++) {
    const x = rnd(i) * w
    const y = ((rnd(i + 1) + time * 0.06 * (0.3 + rnd(i + 2))) % 1) * h
    ctx.fillStyle = i % 2 ? c0 : c1
    ctx.globalAlpha = 0.35 + rnd(i + 4) * 0.55
    ctx.fillRect(x, y, 2 + rnd(i + 5) * 3, 2 + rnd(i + 6) * 3)
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

/**
 * Living art: fixed SD (or solid) plate + real motion overlay.
 * No ken-burns / zoom — the picture stays put; light and graphics move.
 */
export function renderLivingArtFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  recipe: GenRecipe,
  t: number,
  img: HTMLImageElement | null,
) {
  const { palette, speed, density, seed } = recipe
  const time = t * (speed || 0.6)
  const style = recipe.liveStyle ?? 'aurora'

  if (img && img.complete && img.naturalWidth > 0) {
    drawImageCover(ctx, img, w, h, img.naturalWidth, img.naturalHeight)
    // Gentle color breathing (opacity wash — not scale)
    const wash = 0.08 + 0.06 * Math.sin(time * 0.7)
    ctx.fillStyle = palette[0] || '#fff'
      ctx.globalAlpha = wash * 1.4
      ctx.globalCompositeOperation = 'overlay'
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    } else {
      ctx.fillStyle = palette[2] || '#0a0c0f'
      ctx.fillRect(0, 0, w, h)
    }

    // Stronger motion for living art (was too subtle over busy stills)
    paintMotionOverlay(ctx, w, h, style, palette, Math.max(0.7, density), seed, time * 1.25)

  // Soft vignette
  const vig = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.35,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.72,
  )
  vig.addColorStop(0, 'transparent')
  vig.addColorStop(1, 'rgba(0,0,0,0.4)')
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, w, h)
}

export function renderGenerativeFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  recipe: GenRecipe,
  t: number,
) {
  const { palette, mode, speed, density, seed } = recipe
  const time = t * speed

  if (mode === 'white') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    return
  }

  if (mode === 'livingArt' || mode === 'photoMotion') {
    renderLivingArtFrame(ctx, w, h, recipe, t, null)
    return
  }

  if (mode === 'whitePulse') {
    const pulse = 0.72 + 0.28 * Math.sin(time * 2.2)
    ctx.fillStyle = `rgb(${Math.round(255 * pulse)},${Math.round(255 * pulse)},${Math.round(255 * pulse)})`
    ctx.fillRect(0, 0, w, h)
    const cx = w * (0.5 + 0.25 * Math.sin(time * 0.9))
    const cy = h * (0.5 + 0.2 * Math.cos(time * 0.7))
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.45)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.5, 'rgba(240,240,240,0.9)')
    g.addColorStop(1, 'rgba(200,200,200,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    return
  }

  if (mode === 'whiteGrid') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    const step = Math.max(40, Math.min(w, h) / 8)
    const shift = (time * 30) % step
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'
    ctx.lineWidth = 3
    for (let x = -step + shift; x < w + step; x += step) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    for (let y = -step + shift * 0.6; y < h + step; y += step) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    return
  }

  // Full-frame motion styles (aurora / liquid / …) as standalone loops
  if (
    mode === 'aurora' ||
    mode === 'liquid' ||
    mode === 'embers' ||
    mode === 'scan' ||
    mode === 'ribbons' ||
    mode === 'field' ||
    mode === 'pulse'
  ) {
    ctx.fillStyle = palette[2] || '#0a0c0f'
    ctx.fillRect(0, 0, w, h)
    paintMotionOverlay(ctx, w, h, mode as LiveStyle, palette, density, seed, time)
    const vig = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.3,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.7,
    )
    vig.addColorStop(0, 'transparent')
    vig.addColorStop(1, 'rgba(0,0,0,0.5)')
    ctx.fillStyle = vig
    ctx.fillRect(0, 0, w, h)
    return
  }

  ctx.fillStyle = palette[2] || '#000'
  ctx.fillRect(0, 0, w, h)

  const rnd = rndFn(seed)

  if (mode === 'orbits') {
    const n = Math.floor(8 + density * 20)
    for (let i = 0; i < n; i++) {
      const angle = time * (0.3 + rnd(i) * 0.8) + i
      const radius = (0.15 + rnd(i + 3) * 0.35) * Math.min(w, h)
      const x = w / 2 + Math.cos(angle) * radius
      const y = h / 2 + Math.sin(angle * (0.7 + rnd(i + 1))) * radius * 0.7
      const r = 4 + rnd(i + 5) * 28
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, palette[i % 2])
      g.addColorStop(1, 'transparent')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  } else {
    // lattice
    const step = Math.max(24, 80 - density * 40)
    ctx.strokeStyle = palette[0]
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 1.5
    const skew = Math.sin(time * 0.4) * 20
    for (let x = -step; x < w + step; x += step) {
      ctx.beginPath()
      ctx.moveTo(x + skew, 0)
      ctx.lineTo(x - skew, h)
      ctx.stroke()
    }
    for (let y = -step; y < h + step; y += step) {
      ctx.beginPath()
      ctx.moveTo(0, y + Math.cos(time * 0.3) * 10)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = palette[1]
    for (let x = 0; x < w; x += step) {
      for (let y = 0; y < h; y += step) {
        if (rnd(x * 0.1 + y) > 0.7) {
          ctx.beginPath()
          ctx.arc(x + skew * 0.3, y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }

  const vig = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.3,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.7,
  )
  vig.addColorStop(0, 'transparent')
  vig.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, w, h)
}

const WHITE_PALETTE = ['#ffffff', '#f0f0f0', '#ffffff', '#ffffff']

export function builtInTestContent(): GeneratedClip[] {
  const defs: { id: string; title: string; mode: GenRecipe['mode']; speed: number }[] = [
    { id: 'test-white-solid', title: 'White solid', mode: 'white', speed: 1 },
    { id: 'test-white-pulse', title: 'White pulse', mode: 'whitePulse', speed: 1 },
    { id: 'test-white-grid', title: 'White grid', mode: 'whiteGrid', speed: 0.8 },
  ]
  return defs.map((d) => {
    const recipe: GenRecipe = {
      palette: WHITE_PALETTE,
      mode: d.mode,
      speed: d.speed,
      density: 1,
      seed: 1,
    }
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')!
    renderGenerativeFrame(ctx, canvas.width, canvas.height, recipe, 0.5)
    return {
      id: d.id,
      title: d.title,
      prompt: d.title,
      createdAt: 0,
      thumbnail: canvas.toDataURL('image/webp', 0.9),
      recipe,
    }
  })
}

export async function generateAiContent(prompt: string): Promise<GeneratedClip> {
  const recipe = recipeFromPrompt(prompt)
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const ctx = canvas.getContext('2d')!
  await new Promise((r) => setTimeout(r, 400 + Math.random() * 500))
  renderGenerativeFrame(ctx, canvas.width, canvas.height, recipe, 1.2)
  const thumbnail = canvas.toDataURL('image/webp', 0.85)
  const title = prompt.trim().slice(0, 42) || `Generative ${recipe.mode}`
  return {
    id: `ai-${recipe.seed}-${Date.now()}`,
    title,
    prompt: prompt.trim(),
    createdAt: Date.now(),
    thumbnail,
    recipe,
  }
}
