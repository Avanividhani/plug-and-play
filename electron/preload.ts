import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type DisplayInfo = {
  id: number
  index: number
  /** OS / EDID friendly name when available — never invented by the app. */
  label: string
  manufacturer: string | null
  model: string | null
  serial: string | null
  bounds: { x: number; y: number; width: number; height: number }
  size: { width: number; height: number }
  scaleFactor: number
  isPrimary: boolean
}

export type DisplayChangeEvent = {
  kind: 'added' | 'removed' | 'metrics'
  display: DisplayInfo | null
  displays: DisplayInfo[]
  at: number
}

const api = {
  listDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke('displays:list'),
  openProjector: (displayId: number, index: number) =>
    ipcRenderer.invoke('projector:open', displayId, index),
  closeProjector: (displayId: number) => ipcRenderer.invoke('projector:close', displayId),
  closeAllProjectors: () => ipcRenderer.invoke('projector:closeAll'),
  broadcast: (channel: string, payload: unknown) =>
    ipcRenderer.invoke('projector:broadcast', channel, payload),
  sendToProjector: (projectorIndex: number, channel: string, payload: unknown) =>
    ipcRenderer.invoke('projector:send', projectorIndex, channel, payload),
  on: (channel: string, listener: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  platform: () => ipcRenderer.invoke('app:platform') as Promise<string>,
  /** Absolute path for a File from <input type="file"> (Electron only). */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  /** Write bytes to temp and return an http://127.0.0.1 media URL shared across windows. */
  persistMedia: (req: {
    base64?: string
    buffer?: ArrayBuffer
    mimeType?: string
    fileName?: string
  }) =>
    ipcRenderer.invoke('media:persist', req) as Promise<{
      ok: boolean
      url?: string
      error?: string
    }>,
  /** Convert a local absolute path to an http://127.0.0.1 media URL (no copy). */
  mediaUrlFromPath: (filePath: string) =>
    ipcRenderer.invoke('media:fromPath', filePath) as Promise<{
      ok: boolean
      url?: string
      error?: string
    }>,
  /** Local Range media server status (port / base URL). */
  mediaServerInfo: () =>
    ipcRenderer.invoke('media:serverInfo') as Promise<{
      ok: boolean
      port: number
      base: string | null
    }>,
  aiHttp: (req: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string | null
    bodyBase64?: string | null
    bodyMultipart?: { name: string; value: string }[] | null
    responseType?: 'json' | 'base64' | 'text'
  }) =>
    ipcRenderer.invoke('ai:http', req) as Promise<{
      ok: boolean
      status: number
      base64?: string
      contentType?: string
      json?: unknown
      text?: string
      error?: string
    }>,
  generateAi: (req: { prompt: string; kind: 'live' | 'still' | 'motion' }) =>
    ipcRenderer.invoke('ai:generate', req) as Promise<{
      ok: boolean
      item?: {
        id: string
        name: string
        type: 'image' | 'video' | 'ai'
        url: string
        thumbnail?: string
        prompt?: string
        source?: 'stable-diffusion' | 'procedural'
        recipe?: unknown
      }
      warning?: string
      error?: string
    }>,
  /** Never returns the full key — only configured + last4 (+ which provider). */
  getGeminiKeyStatus: () =>
    ipcRenderer.invoke('ai:getGeminiKeyStatus') as Promise<{
      configured: boolean
      last4: string | null
      provider?: 'gemini' | 'pollinations' | 'both' | null
      geminiConfigured?: boolean
      pollinationsConfigured?: boolean
    }>,
  setGeminiKey: (key: string) =>
    ipcRenderer.invoke('ai:setGeminiKey', key) as Promise<{
      ok: boolean
      configured?: boolean
      last4?: string
      provider?: 'gemini' | 'pollinations'
      error?: string
    }>,
}

contextBridge.exposeInMainWorld('lumen', api)

export type LumenAPI = typeof api
