/** Stable Diffusion image generation — local WebUI, Stability API, or cloud fallback. */

import { generateAiContent } from './aiContent'

export type SdProvider = 'auto' | 'local' | 'stability' | 'pollinations'

export type SdSettings = {
  provider: SdProvider
  /** Stability AI API key (https://platform.stability.ai) */
  stabilityApiKey: string
  /** Pollinations key from https://enter.pollinations.ai (optional, fixes 403) */
  pollinationsApiKey: string
  /** Automatic1111 / Forge WebUI base URL */
  localUrl: string
}

export type SdImage = {
  id: string
  name: string
  url: string
  thumbnail: string
  prompt: string
  provider: string
  /** Present when falling back to local motion recipe */
  recipe?: import('./aiContent').GenRecipe
  type?: 'image' | 'ai'
}

const STORAGE_KEY = 'lumenmap-sd-settings'

export function loadSdSettings(): SdSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SdSettings>
      return {
        provider: parsed.provider ?? 'auto',
        stabilityApiKey: parsed.stabilityApiKey ?? '',
        pollinationsApiKey: parsed.pollinationsApiKey ?? '',
        localUrl: parsed.localUrl ?? 'http://127.0.0.1:7860',
      }
    }
  } catch {
    /* ignore */
  }
  return {
    provider: 'auto',
    stabilityApiKey: '',
    pollinationsApiKey: '',
    localUrl: 'http://127.0.0.1:7860',
  }
}

export function saveSdSettings(settings: SdSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* ignore */
  }
}

function uid() {
  return `sd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function titleFromPrompt(prompt: string) {
  const t = prompt.trim().replace(/\s+/g, ' ')
  return t.slice(0, 48) || 'AI image'
}

async function base64ToObjectUrl(b64: string, mime = 'image/png'): Promise<string> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

type HttpResult = {
  ok: boolean
  status: number
  base64?: string
  contentType?: string
  json?: unknown
  text?: string
  error?: string
}

async function http(req: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | null
  bodyMultipart?: { name: string; value: string }[] | null
  responseType?: 'json' | 'base64' | 'text'
}): Promise<HttpResult> {
  if (typeof window !== 'undefined' && window.lumen?.aiHttp) {
    return window.lumen.aiHttp(req)
  }
  const headers = { ...(req.headers ?? {}) }
  let body: BodyInit | undefined
  if (req.bodyMultipart) {
    const form = new FormData()
    for (const p of req.bodyMultipart) form.append(p.name, p.value)
    body = form
  } else if (req.body != null) {
    body = req.body
  }
  const res = await fetch(req.url, { method: req.method ?? 'GET', headers, body })
  if (req.responseType === 'json') {
    return { ok: res.ok, status: res.status, json: await res.json() }
  }
  if (req.responseType === 'text') {
    return { ok: res.ok, status: res.status, text: await res.text() }
  }
  const ab = await res.arrayBuffer()
  const bytes = new Uint8Array(ab)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return {
    ok: res.ok,
    status: res.status,
    base64: btoa(binary),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  }
}

function failDetail(res: HttpResult): string {
  if (res.error) return res.error
  if (res.text) return res.text.slice(0, 160)
  return ''
}

/** Local Automatic1111 / Forge txt2img */
async function generateLocal(prompt: string, baseUrl: string): Promise<SdImage> {
  const root = baseUrl.replace(/\/$/, '')
  const res = await http({
    url: `${root}/sdapi/v1/txt2img`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: 'blurry, low quality, watermark, text',
      steps: 20,
      width: 768,
      height: 768,
      cfg_scale: 7,
      sampler_name: 'Euler a',
    }),
    responseType: 'json',
  })
  if (!res.ok) throw new Error(`Local SD failed (${res.status}${failDetail(res) ? `: ${failDetail(res)}` : ''})`)
  const data = res.json as { images?: string[] }
  const b64 = data?.images?.[0]
  if (!b64) throw new Error('Local SD returned no image')
  const url = await base64ToObjectUrl(b64)
  return {
    id: uid(),
    name: titleFromPrompt(prompt),
    url,
    thumbnail: url,
    prompt: prompt.trim(),
    provider: 'local',
    type: 'image',
  }
}

/** Stability AI Stable Image Core */
async function generateStability(prompt: string, apiKey: string): Promise<SdImage> {
  const res = await http({
    url: 'https://api.stability.ai/v2beta/stable-image/generate/core',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'image/*',
    },
    bodyMultipart: [
      { name: 'prompt', value: prompt },
      { name: 'output_format', value: 'png' },
      { name: 'aspect_ratio', value: '1:1' },
    ],
    responseType: 'base64',
  })
  if (!res.ok || !res.base64) {
    throw new Error(`Stability API failed (${res.status})${failDetail(res) ? `: ${failDetail(res)}` : ''}`)
  }
  const mime = res.contentType?.startsWith('image/') ? res.contentType : 'image/png'
  const url = await base64ToObjectUrl(res.base64, mime)
  return {
    id: uid(),
    name: titleFromPrompt(prompt),
    url,
    thumbnail: url,
    prompt: prompt.trim(),
    provider: 'stability',
    type: 'image',
  }
}

/** Cloud image gen — tries several endpoints; optional Pollinations key. */
async function generatePollinations(prompt: string, apiKey?: string): Promise<SdImage> {
  const q = encodeURIComponent(prompt.trim())
  const seed = Date.now() % 100000
  const key = apiKey?.trim()

  const authHeaders = key ? { Authorization: `Bearer ${key}` } : undefined

  const candidates: { url: string; headers?: Record<string, string> }[] = []

  if (key) {
    candidates.push({
      url: `https://gen.pollinations.ai/image/${q}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`,
      headers: authHeaders,
    })
    candidates.push({
      url: `https://image.pollinations.ai/prompt/${q}?width=1024&height=1024&nologo=true&seed=${seed}&key=${encodeURIComponent(key)}`,
      headers: authHeaders,
    })
  }

  candidates.push({
    url: `https://image.pollinations.ai/prompt/${q}?width=768&height=768&nologo=true&seed=${seed}`,
  })
  candidates.push({
    url: `https://image.pollinations.ai/prompt/${q}?width=512&height=512&nologo=true&seed=${seed}`,
  })
  candidates.push({
    url: `https://image.pollinations.ai/prompt/${q}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`,
  })

  let lastStatus = 0
  let lastDetail = ''
  for (const c of candidates) {
    try {
      const res = await http({
        url: c.url,
        method: 'GET',
        headers: {
          Referer: 'https://pollinations.ai/',
          Origin: 'https://pollinations.ai',
          ...(c.headers ?? {}),
        },
        responseType: 'base64',
      })
      lastStatus = res.status
      lastDetail = failDetail(res)
      if (
        res.ok &&
        res.base64 &&
        res.base64.length >= 800 &&
        (!res.contentType ||
          res.contentType.includes('image') ||
          res.contentType.includes('octet'))
      ) {
        const mime = res.contentType?.startsWith('image/') ? res.contentType : 'image/jpeg'
        const objectUrl = await base64ToObjectUrl(res.base64, mime)
        return {
          id: uid(),
          name: titleFromPrompt(prompt),
          url: objectUrl,
          thumbnail: objectUrl,
          prompt: prompt.trim(),
          provider: 'pollinations',
          type: 'image',
        }
      }
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : 'request failed'
    }
  }

  const hint =
    lastStatus === 403 || lastStatus === 401 || lastStatus === 402
      ? ' Add a free key from enter.pollinations.ai in SD settings, or a Stability API key.'
      : ''
  throw new Error(
    `Cloud SD failed (${lastStatus || 'network'})${lastDetail ? `: ${lastDetail}` : ''}.${hint}`,
  )
}

/** Always-available offline fallback — procedural still + looping recipe */
async function generateProceduralFallback(prompt: string): Promise<SdImage> {
  const clip = await generateAiContent(prompt)
  return {
    id: clip.id,
    name: clip.title,
    url: clip.thumbnail,
    thumbnail: clip.thumbnail,
    prompt: clip.prompt,
    provider: 'procedural-fallback',
    recipe: clip.recipe,
    type: 'ai',
  }
}

async function tryLocal(prompt: string, localUrl: string): Promise<SdImage | null> {
  try {
    const root = localUrl.replace(/\/$/, '')
    const ping = await http({
      url: `${root}/sdapi/v1/sd-models`,
      method: 'GET',
      responseType: 'json',
    })
    if (!ping.ok) return null
    return await generateLocal(prompt, localUrl)
  } catch {
    return null
  }
}

/**
 * Generate a still image for projection.
 * auto: local WebUI → Stability key → cloud → procedural fallback
 */
export async function generateStableDiffusionImage(
  prompt: string,
  settings: SdSettings = loadSdSettings(),
): Promise<SdImage> {
  const p = prompt.trim()
  if (!p) throw new Error('Enter a prompt')

  const provider = settings.provider

  if (provider === 'local') {
    return generateLocal(p, settings.localUrl)
  }
  if (provider === 'stability') {
    if (!settings.stabilityApiKey.trim()) throw new Error('Add a Stability API key')
    return generateStability(p, settings.stabilityApiKey.trim())
  }
  if (provider === 'pollinations') {
    try {
      return await generatePollinations(p, settings.pollinationsApiKey)
    } catch (cloudErr) {
      // Soft-fallback so Generate still works
      const fallback = await generateProceduralFallback(p)
      fallback.name = `${fallback.name} (offline)`
      console.warn(cloudErr)
      return fallback
    }
  }

  // auto
  const local = await tryLocal(p, settings.localUrl)
  if (local) return local
  if (settings.stabilityApiKey.trim()) {
    try {
      return await generateStability(p, settings.stabilityApiKey.trim())
    } catch {
      /* fall through */
    }
  }
  try {
    return await generatePollinations(p, settings.pollinationsApiKey)
  } catch {
    return generateProceduralFallback(p)
  }
}

/**
 * Living AI loop from a prompt: SD still (if available) + real motion overlays
 * (aurora / liquid / embers…). Not a video file — live canvas animation.
 * No ken-burns zoom — the picture stays put; graphics move over it.
 */
export async function generateStableDiffusionMotion(
  prompt: string,
  settings: SdSettings = loadSdSettings(),
): Promise<SdImage> {
  const p = prompt.trim()
  if (!p) throw new Error('Enter a prompt')

  const { recipeFromPrompt, pickLiveStyle } = await import('./aiContent')
  const base = recipeFromPrompt(p)
  const livingRecipe = {
    ...base,
    mode: 'livingArt' as const,
    liveStyle: base.liveStyle ?? pickLiveStyle(p, base.seed),
    speed: 0.55 + (base.speed % 1) * 0.45,
  }

  try {
    const still = await generateStableDiffusionImage(p, settings)
    if (still.provider === 'procedural-fallback' && still.recipe) {
      // Offline: full procedural motion matching the prompt
      return {
        ...still,
        name: `${titleFromPrompt(p)} · live`,
        type: 'ai',
        recipe: {
          ...still.recipe,
          liveStyle: livingRecipe.liveStyle,
        },
      }
    }
    return {
      id: still.id,
      name: `${titleFromPrompt(p)} · live`,
      url: still.url,
      thumbnail: still.thumbnail,
      prompt: p,
      provider: still.provider,
      recipe: livingRecipe,
      type: 'ai',
    }
  } catch {
    const clip = await generateAiContent(p)
    return {
      id: clip.id,
      name: `${clip.title} · live`,
      url: clip.thumbnail,
      thumbnail: clip.thumbnail,
      prompt: p,
      provider: 'procedural-fallback',
      recipe: clip.recipe,
      type: 'ai',
    }
  }
}
