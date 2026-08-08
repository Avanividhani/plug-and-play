import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  Display,
  protocol,
  net,
  safeStorage,
} from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BUNDLED_GEMINI_KEY,
  BUNDLED_POLLINATIONS_AQ,
  BUNDLED_POLLINATIONS_SK,
} from './bundledKeys'

/** Must run before app ready so <video>/<img> can stream custom-protocol media. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])

// Keep userData under package name so productName ("Plug and Play") does not relocate settings/keys.
app.setPath('userData', path.join(app.getPath('appData'), 'plug-and-play'))

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Packaged builds must never hit the Vite dev server (blank window on other PCs).
 * Dev-only: vite-plugin-electron sets VITE_DEV_SERVER_URL when spawning Electron.
 */
if (app.isPackaged) {
  delete process.env.VITE_DEV_SERVER_URL
}

/** Absolute path to the Vite renderer output folder (contains index.html). */
function resolveRendererDist(): string {
  const candidates = [
    path.join(__dirname, '../dist'),
    path.join(app.getAppPath(), 'dist'),
    // Unpacked / extraResources fallbacks
    path.join(process.resourcesPath, 'app.asar', 'dist'),
    path.join(process.resourcesPath, 'app', 'dist'),
    path.join(process.resourcesPath, 'dist'),
  ]
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir
    } catch {
      /* ignore */
    }
  }
  return candidates[0]
}

process.env.DIST = resolveRendererDist()

function getDevServerUrl(): string | undefined {
  if (app.isPackaged) return undefined
  const url = process.env.VITE_DEV_SERVER_URL?.trim()
  return url || undefined
}

function rendererIndexHtml(): string {
  return path.join(process.env.DIST || resolveRendererDist(), 'index.html')
}

let loadErrorDialogShown = false

function showRendererLoadError(detail: string) {
  const message =
    `Plug and Play could not load its UI.\n\n${detail}\n\n` +
    `Tried renderer at:\n${rendererIndexHtml()}\n\n` +
    `If this is a copied build, reinstall from "Plug and Play Setup 1.0.0.exe". ` +
    `Windows SmartScreen may block unsigned installs — choose More info → Run anyway.`
  console.error('[startup]', message)
  try {
    const logDir = app.getPath('userData')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(
      path.join(logDir, 'startup-error.log'),
      `\n[${new Date().toISOString()}] ${detail}\nDIST=${process.env.DIST}\n` +
        `isPackaged=${app.isPackaged}\nappPath=${app.getAppPath()}\n` +
        `__dirname=${__dirname}\n`,
      'utf8',
    )
  } catch {
    /* ignore */
  }
  if (loadErrorDialogShown) return
  loadErrorDialogShown = true
  const show = () => {
    void dialog.showMessageBox({
      type: 'error',
      title: 'Plug and Play — failed to start',
      message: 'Could not load the app UI',
      detail: message,
    })
  }
  if (app.isReady()) show()
  else void app.whenReady().then(show)
}

function attachRendererLoadGuards(win: BrowserWindow, label: string) {
  win.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      // -3 = ERR_ABORTED (common during redirects / hash nav); ignore
      if (errorCode === -3) return
      showRendererLoadError(
        `${label} failed to load (${errorCode}): ${errorDescription}\nURL: ${validatedURL || '(file)'}`,
      )
    },
  )
}

async function loadRenderer(
  win: BrowserWindow,
  opts?: { hash?: string },
): Promise<void> {
  const devUrl = getDevServerUrl()
  if (devUrl) {
    const target = opts?.hash ? `${devUrl}#${opts.hash}` : devUrl
    await win.loadURL(target)
    return
  }

  // Re-resolve after app ready so getAppPath()/resourcesPath are correct when packaged.
  process.env.DIST = resolveRendererDist()
  const indexHtml = rendererIndexHtml()
  if (!fs.existsSync(indexHtml)) {
    showRendererLoadError(`index.html missing at:\n${indexHtml}`)
    throw new Error(`Renderer missing: ${indexHtml}`)
  }
  await win.loadFile(indexHtml, opts?.hash ? { hash: opts.hash } : undefined)
}

/** id → absolute filesystem path for local media HTTP server */
const mediaFiles = new Map<string, string>()
let mediaServerPort = 0
let mediaServerPromise: Promise<number> | null = null

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

/**
 * Register a local file and return an http://127.0.0.1 URL playable from Vite (http) and
 * every BrowserWindow. Never returns file:// or blob: — those fail cross-window / mixed origin.
 */
function registerMediaFile(absPath: string): string {
  const resolved = path.resolve(absPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`Media file missing: ${resolved}`)
  }
  if (!mediaServerPort) {
    throw new Error('Media server is not running yet')
  }
  // Reuse id for the same absolute path so library URLs stay valid within a session.
  for (const [existingId, existingPath] of mediaFiles) {
    if (existingPath === resolved) {
      const url = `http://127.0.0.1:${mediaServerPort}/m/${existingId}`
      console.log('[media] reuse', url, '→', resolved)
      return url
    }
  }
  const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`
  mediaFiles.set(id, resolved)
  const url = `http://127.0.0.1:${mediaServerPort}/m/${id}`
  console.log('[media] register', url, '→', resolved)
  return url
}

/** Normalize picker / drag paths: accept absolute paths or file:// URLs. */
function resolveLocalMediaPath(filePath: string): string {
  const raw = String(filePath || '').trim()
  if (!raw) return ''
  if (/^file:/i.test(raw)) {
    try {
      return path.resolve(fileURLToPath(raw))
    } catch {
      return ''
    }
  }
  return path.resolve(raw)
}

/** Reject JSON/HTML error bodies saved as “.mp4”. */
function assertPlayableVideoBytes(bytes: Buffer, mime?: string, fileName?: string) {
  const wantVideo =
    (mime || '').toLowerCase().includes('video') ||
    /\.(mp4|webm|mov|mkv|m4v)$/i.test(fileName || '')
  if (!wantVideo || bytes.length < 32) return
  const head = bytes.subarray(0, 64)
  const asText = head.toString('utf8').trimStart()
  if (asText.startsWith('{') || asText.startsWith('<') || asText.startsWith('[')) {
    throw new Error('Downloaded media is not a video file (got text/HTML/JSON)')
  }
  // ISO BMFF / MP4: ....ftyp ; WebM: 0x1A45DFA3 ; EBML
  const isMp4 = bytes.length > 8 && bytes.toString('ascii', 4, 8) === 'ftyp'
  const isWebm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  const isRip = mime?.includes('webm') || /\.webm$/i.test(fileName || '')
  if (!isMp4 && !(isWebm || isRip)) {
    // Allow unknown containers (e.g. some .mov) if not obviously text.
    if (mime?.includes('mp4') || /\.mp4$/i.test(fileName || '')) {
      throw new Error('MP4 payload missing ftyp header — not a real video')
    }
  }
}

function startMediaServer(): Promise<number> {
  if (mediaServerPort > 0) return Promise.resolve(mediaServerPort)
  if (mediaServerPromise) return mediaServerPromise
  mediaServerPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        const parts = u.pathname.split('/').filter(Boolean)
        if (parts[0] !== 'm' || !parts[1]) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const filePath = mediaFiles.get(parts[1])
        if (!filePath || !fs.existsSync(filePath)) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const stat = fs.statSync(filePath)
        const mime = mimeFromPath(filePath)
        const range = req.headers.range
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range)
          if (!m) {
            res.writeHead(416, {
              'Content-Range': `bytes */${stat.size}`,
              'Access-Control-Allow-Origin': '*',
            })
            res.end()
            return
          }
          const start = Number(m[1])
          const end = m[2] !== undefined && m[2] !== '' ? Number(m[2]) : stat.size - 1
          const safeEnd = Math.min(Math.max(end, start), stat.size - 1)
          if (start < 0 || start >= stat.size || start > safeEnd) {
            res.writeHead(416, {
              'Content-Range': `bytes */${stat.size}`,
              'Access-Control-Allow-Origin': '*',
            })
            res.end()
            return
          }
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${safeEnd}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': safeEnd - start + 1,
            'Content-Type': mime,
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          })
          fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res)
          return
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': mime,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        fs.createReadStream(filePath).pipe(res)
      } catch {
        res.writeHead(500)
        res.end('Error')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        mediaServerPort = addr.port
        resolve(addr.port)
      } else {
        mediaServerPromise = null
        reject(new Error('Media server failed to bind'))
      }
    })
    server.on('error', (err) => {
      mediaServerPromise = null
      reject(err)
    })
  })
  return mediaServerPromise
}

/** Ensure the Range media server is up before issuing http:// URLs. */
async function ensureMediaServer(): Promise<number> {
  if (mediaServerPort > 0) return mediaServerPort
  return startMediaServer()
}

/** Load KEY=VALUE pairs from project .env without requiring dotenv. */
function loadEnvFile() {
  const seen = new Set<string>()
  const candidates: string[] = []
  const push = (p: string) => {
    const resolved = path.resolve(p)
    if (seen.has(resolved)) return
    seen.add(resolved)
    candidates.push(resolved)
  }

  // vite-plugin-electron: compiled main is dist-electron/main.js → root is ..
  // Nested/outDir variants may need ../..
  push(path.resolve(__dirname, '../.env'))
  push(path.resolve(__dirname, '../.env.local'))
  push(path.resolve(__dirname, '../../.env'))
  push(path.resolve(__dirname, '../../.env.local'))
  // Electron app path (project root in dev; resources path when packaged).
  try {
    if (typeof app?.getAppPath === 'function') {
      const appPath = app.getAppPath()
      push(path.resolve(appPath, '.env'))
      push(path.resolve(appPath, '.env.local'))
      push(path.resolve(appPath, '..', '.env'))
      push(path.resolve(appPath, '..', '.env.local'))
    }
  } catch {
    /* app may be unavailable in odd load orders */
  }
  push(path.resolve(process.cwd(), '.env'))
  push(path.resolve(process.cwd(), '.env.local'))

  let loadedFrom: string | null = null
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) continue
        let key = trimmed.slice(0, eq).trim()
        if (key.startsWith('export ')) key = key.slice(7).trim()
        let value = trimmed.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        // Fill missing/empty env vars (do not override non-empty shell / CI overrides).
        if (!process.env[key]) process.env[key] = value
      }
      loadedFrom = file
      console.log('[env] loaded', file)
      // First existing file wins; later candidates are fallbacks only if none found.
      break
    } catch (e) {
      console.warn('[env] failed to read', file, e instanceof Error ? e.message : e)
    }
  }
  if (!loadedFrom) {
    console.warn(
      '[env] no .env found — looked in:',
      candidates.slice(0, 8).join(' | '),
    )
  }
  return loadedFrom
}
loadEnvFile()

/** Project-root .env path for writing API keys from the Content UI. */
function resolveProjectEnvPath(): string {
  const candidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ]
  try {
    if (typeof app?.getAppPath === 'function') {
      candidates.unshift(path.resolve(app.getAppPath(), '.env'))
    }
  } catch {
    /* ignore */
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return path.resolve(__dirname, '../.env')
}

/** Refuse absurd pastes that could blow memory / corrupt store files. */
const MAX_API_KEY_CHARS = 8192

function geminiKeyStorePath(): string {
  return path.join(app.getPath('userData'), 'gemini-api-key.dat')
}

function pollinationsKeyStorePath(): string {
  return path.join(app.getPath('userData'), 'pollinations-api-key.dat')
}

function readEncryptedKeyFile(file: string): string {
  try {
    if (!fs.existsSync(file)) return ''
    const buf = fs.readFileSync(file)
    if (buf.length === 0) return ''
    let encryptionOk = false
    try {
      encryptionOk = safeStorage.isEncryptionAvailable()
    } catch {
      encryptionOk = false
    }
    if (encryptionOk) {
      try {
        return safeStorage.decryptString(buf).trim()
      } catch {
        return buf.toString('utf8').trim()
      }
    }
    return buf.toString('utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Persist a key under userData. Prefer OS encryption; if unavailable or encrypt
 * throws, write plaintext with restrictive mode — never let encrypt crash Save.
 */
function writeEncryptedKeyFile(file: string, key: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let encryptionOk = false
  try {
    encryptionOk = safeStorage.isEncryptionAvailable()
  } catch {
    encryptionOk = false
  }
  if (encryptionOk) {
    try {
      const encrypted = safeStorage.encryptString(key)
      fs.writeFileSync(file, encrypted, { mode: 0o600 })
      return
    } catch (e) {
      console.warn(
        '[ai] key save failed: safeStorage.encryptString — falling back to plaintext userData',
        e instanceof Error ? e.message : e,
      )
    }
  }
  fs.writeFileSync(file, key, { encoding: 'utf8', mode: 0o600 })
}

/** userData override (encrypted when safeStorage is available). Prefer process.env when set. */
function readSavedGeminiKey(): string {
  return readEncryptedKeyFile(geminiKeyStorePath())
}

function writeSavedGeminiKey(key: string): void {
  writeEncryptedKeyFile(geminiKeyStorePath(), key)
}

function readSavedPollinationsKey(): string {
  return readEncryptedKeyFile(pollinationsKeyStorePath())
}

function writeSavedPollinationsKey(key: string): void {
  writeEncryptedKeyFile(pollinationsKeyStorePath(), key)
}

/**
 * Writing the project .env while `vite` + vite-plugin-electron are running makes
 * Vite restart the server and kill the Electron main process — looks like a
 * force quit right after Save. userData key files are enough for persistence.
 */
function shouldWriteProjectEnv(): boolean {
  return !getDevServerUrl()
}

function upsertEnvKeyLine(
  envKey: string,
  key: string,
  comment: string,
): string | null {
  if (!shouldWriteProjectEnv()) {
    console.log('[ai] skipping project .env write (Vite dev — avoids Electron restart)')
    return null
  }
  try {
    const envPath = resolveProjectEnvPath()
    let text = ''
    try {
      if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, 'utf8')
    } catch {
      text = ''
    }
    const line = `${envKey}=${key}`
    const re = new RegExp(`^${envKey}=.*$`, 'm')
    if (re.test(text)) {
      text = text.replace(re, line)
    } else {
      text = `${text.replace(/\s*$/, '')}\n\n# ${comment}\n${line}\n`
    }
    fs.mkdirSync(path.dirname(envPath), { recursive: true })
    fs.writeFileSync(envPath, text, { encoding: 'utf8', mode: 0o600 })
    return envPath
  } catch (e) {
    console.warn(
      '[ai] key save failed: .env write',
      e instanceof Error ? e.message : e,
    )
    return null
  }
}

function upsertEnvGeminiKey(key: string): string | null {
  return upsertEnvKeyLine('GEMINI_API_KEY', key, 'Google AI Studio (Motion graphic)')
}

function upsertEnvPollinationsKey(key: string): string | null {
  return upsertEnvKeyLine(
    'POLLINATIONS_API_KEY',
    key,
    'Pollinations (Motion video fallback + still/live images)',
  )
}

let controlWindow: BrowserWindow | null = null

type ProjectorEntry = {
  displayId: number
  projectorIndex: number
  win: BrowserWindow
}

/** Keyed by display id */
const projectorByDisplay = new Map<number, ProjectorEntry>()
/** Keyed by logical projector index (0 = left, 1 = right, …) */
const projectorByIndex = new Map<number, ProjectorEntry>()

/** Encode an absolute filesystem path as a cross-window playable URL. */
function toMediaUrl(absPath: string): string {
  return registerMediaFile(absPath)
}

function mediaUrlToPath(mediaUrl: string): string | null {
  try {
    // http://127.0.0.1:port/m/<id>
    if (mediaUrl.startsWith('http://127.0.0.1:') || mediaUrl.startsWith('http://localhost:')) {
      const u = new URL(mediaUrl)
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts[0] === 'm' && parts[1]) return mediaFiles.get(parts[1]) ?? null
    }
    const u = new URL(mediaUrl)
    if (u.protocol !== 'media:') return null
    const token = u.pathname.replace(/^\//, '')
    if (!token) return null
    return Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

function extFromMime(mime?: string, fileName?: string): string {
  const fromName = fileName ? path.extname(fileName) : ''
  if (fromName) return fromName
  const m = (mime || '').toLowerCase()
  if (m.includes('mp4')) return '.mp4'
  if (m.includes('webm')) return '.webm'
  if (m.includes('quicktime')) return '.mov'
  if (m.includes('png')) return '.png'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('gif')) return '.gif'
  if (m.includes('webp')) return '.webp'
  if (m.includes('image/')) return '.img'
  if (m.includes('video/')) return '.mp4'
  return '.bin'
}

/** Write bytes under userData/media and return an http://127.0.0.1 playback URL. */
function persistMediaBytes(bytes: Buffer, mime?: string, fileName?: string): string {
  assertPlayableVideoBytes(bytes, mime, fileName)
  const dir = path.join(app.getPath('userData'), 'media')
  fs.mkdirSync(dir, { recursive: true })
  const ext = extFromMime(mime, fileName)
  const file = path.join(
    dir,
    `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  )
  fs.writeFileSync(file, bytes)
  return registerMediaFile(file)
}

function displayToInfo(d: Display, index: number) {
  return {
    id: d.id,
    index,
    label: d.label || `Display ${index + 1}`,
    bounds: d.bounds,
    size: d.size,
    scaleFactor: d.scaleFactor,
    isPrimary: d.id === screen.getPrimaryDisplay().id,
  }
}

function listDisplays() {
  return screen.getAllDisplays().map((d, i) => displayToInfo(d, i))
}

function emitDisplayChange(kind: 'added' | 'removed' | 'metrics', display?: Display) {
  const payload = {
    kind,
    display: display
      ? displayToInfo(
          display,
          screen.getAllDisplays().findIndex((x) => x.id === display.id),
        )
      : null,
    displays: listDisplays(),
    at: Date.now(),
  }
  controlWindow?.webContents.send('devices:display-change', payload)
  for (const entry of projectorByDisplay.values()) {
    if (!entry.win.isDestroyed()) entry.win.webContents.send('devices:display-change', payload)
  }
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Plug and Play',
    backgroundColor: '#0a0c0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow localhost media http:// Range streaming into library <video>.
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  attachRendererLoadGuards(controlWindow, 'Control window')
  void loadRenderer(controlWindow).catch((e) => {
    showRendererLoadError(e instanceof Error ? e.message : String(e))
  })

  controlWindow.on('closed', () => {
    controlWindow = null
    for (const entry of [...projectorByDisplay.values()]) {
      if (!entry.win.isDestroyed()) entry.win.close()
    }
    projectorByDisplay.clear()
    projectorByIndex.clear()
  })
}

function openProjector(
  displayId: number,
  projectorIndex: number,
): Promise<{ ok: boolean; reused?: boolean; error?: string }> {
  const displays = screen.getAllDisplays()
  const display = displays.find((d) => d.id === displayId)
  if (!display) return Promise.resolve({ ok: false, error: 'Display not found' })

  const existing = projectorByDisplay.get(displayId)
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus()
    return Promise.resolve({ ok: true, reused: true })
  }

  const isOnlyDisplay = displays.length === 1
  const win = new BrowserWindow({
    x: display.bounds.x + (isOnlyDisplay ? 80 : 0),
    y: display.bounds.y + (isOnlyDisplay ? 80 : 0),
    width: isOnlyDisplay ? Math.min(1280, display.bounds.width - 160) : display.bounds.width,
    height: isOnlyDisplay ? Math.min(720, display.bounds.height - 160) : display.bounds.height,
    fullscreen: !isOnlyDisplay,
    frame: isOnlyDisplay,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: `Plug and Play · Projector ${projectorIndex + 1}`,
    alwaysOnTop: isOnlyDisplay,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // file:// videos must draw to canvas for projection mapping.
      webSecurity: false,
      // Autoplay muted <video> on projector without a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  if (!isOnlyDisplay) win.setMenuBarVisibility(false)

  const entry: ProjectorEntry = { displayId, projectorIndex, win }
  win.on('closed', () => {
    projectorByDisplay.delete(displayId)
    projectorByIndex.delete(projectorIndex)
    controlWindow?.webContents.send('projector:closed', { displayId, projectorIndex })
  })

  projectorByDisplay.set(displayId, entry)
  projectorByIndex.set(projectorIndex, entry)

  // Wait until the renderer is ready so projector:layers / mode are not dropped.
  // Flash white once here — do not re-send white on later navigations (would wipe content mode).
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; reused?: boolean; error?: string }) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      console.warn('[projector] open timed out waiting for load', projectorIndex)
      finish({ ok: true, reused: false })
    }, 10000)

    win.webContents.once('did-finish-load', () => {
      win.webContents.send('projector:mode', { mode: 'white' })
      // React must mount + subscribe to IPC before layers are safe to send.
      setTimeout(() => {
        clearTimeout(timer)
        finish({ ok: true, reused: false })
      }, 300)
    })

    win.webContents.once('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      clearTimeout(timer)
      const err = `Projector failed to load (${code}): ${desc}`
      showRendererLoadError(err)
      finish({ ok: false, error: err })
    })

    attachRendererLoadGuards(win, `Projector ${projectorIndex + 1}`)
    void loadRenderer(win, { hash: `/projector/${projectorIndex}` }).catch((e) => {
      clearTimeout(timer)
      const err = e instanceof Error ? e.message : String(e)
      showRendererLoadError(err)
      finish({ ok: false, error: err })
    })
  })
}

function closeProjector(displayId: number) {
  const entry = projectorByDisplay.get(displayId)
  if (entry && !entry.win.isDestroyed()) entry.win.close()
  if (entry) {
    projectorByDisplay.delete(displayId)
    projectorByIndex.delete(entry.projectorIndex)
  }
  return { ok: true }
}

app.whenReady().then(async () => {
  // Re-resolve renderer after ready (packaged appPath / resourcesPath are definitive).
  process.env.DIST = resolveRendererDist()
  console.log(
    `[startup] packaged=${app.isPackaged} DIST=${process.env.DIST} ` +
      `index=${fs.existsSync(rendererIndexHtml())} appPath=${app.getAppPath()}`,
  )

  // Re-load after ready so app.getAppPath() is reliable, before any AI generate handlers run.
  loadEnvFile()
  try {
    await ensureMediaServer()
    console.log(`[media] local server on http://127.0.0.1:${mediaServerPort}`)
  } catch (e) {
    console.error('[media] failed to start local server', e)
  }

  protocol.handle('media', (request) => {
    try {
      const filePath = mediaUrlToPath(request.url)
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(filePath).href)
    } catch {
      return new Response('Error', { status: 500 })
    }
  })

  // Only open the UI after the media server is up (or after a failed attempt logged above).
  createControlWindow()

  screen.on('display-added', (_e, display) => emitDisplayChange('added', display))
  screen.on('display-removed', (_e, display) => emitDisplayChange('removed', display))
  screen.on('display-metrics-changed', (_e, display) => emitDisplayChange('metrics', display))

  ipcMain.handle('displays:list', () => listDisplays())
  ipcMain.handle('projector:open', (_e, displayId: number, index: number) =>
    openProjector(displayId, index),
  )
  ipcMain.handle('projector:close', (_e, displayId: number) => closeProjector(displayId))
  ipcMain.handle('projector:closeAll', () => {
    for (const id of [...projectorByDisplay.keys()]) closeProjector(id)
    return { ok: true }
  })
  ipcMain.handle('projector:broadcast', (_e, channel: string, payload: unknown) => {
    for (const entry of projectorByDisplay.values()) {
      if (!entry.win.isDestroyed()) entry.win.webContents.send(channel, payload)
    }
    controlWindow?.webContents.send(channel, payload)
    return { ok: true }
  })
  ipcMain.handle(
    'projector:send',
    (_e, projectorIndex: number, channel: string, payload: unknown) => {
      const entry = projectorByIndex.get(projectorIndex)
      if (entry && !entry.win.isDestroyed()) {
        entry.win.webContents.send(channel, payload)
        return { ok: true }
      }
      return { ok: false, error: 'Projector window not open' }
    },
  )
  ipcMain.handle('app:platform', () => process.platform)

  ipcMain.handle('media:serverInfo', async () => {
    try {
      const port = await ensureMediaServer()
      return {
        ok: port > 0,
        port,
        base: port > 0 ? `http://127.0.0.1:${port}` : null,
      }
    } catch {
      return { ok: false, port: 0, base: null }
    }
  })

  /** Persist uploaded / generated bytes so projector windows can play them (not blob:). */
  ipcMain.handle(
    'media:persist',
    async (
      _e,
      req: {
        base64?: string
        buffer?: ArrayBuffer
        mimeType?: string
        fileName?: string
      },
    ) => {
      try {
        await ensureMediaServer()
        let bytes: Buffer | null = null
        if (req?.buffer) bytes = Buffer.from(req.buffer)
        else if (req?.base64) bytes = Buffer.from(req.base64, 'base64')
        if (!bytes || bytes.length === 0) return { ok: false, error: 'No media data' }
        const url = persistMediaBytes(bytes, req.mimeType, req.fileName)
        return { ok: true, url }
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : 'Failed to save media',
        }
      }
    },
  )
  /** Point http media server at an existing local file (upload via file picker). */
  ipcMain.handle('media:fromPath', async (_e, filePath: string) => {
    try {
      await ensureMediaServer()
      const resolved = resolveLocalMediaPath(filePath)
      if (!resolved || !fs.existsSync(resolved)) {
        return { ok: false, error: `File not found: ${String(filePath || '').slice(0, 180)}` }
      }
      const url = toMediaUrl(resolved)
      return { ok: true, url }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'Invalid path',
      }
    }
  })

  const uid = () => `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  /** Pollinations: AQ.… (legacy) or sk_/pk_ from enter.pollinations.ai — never send to Gemini. */
  const looksLikePollinationsKey = (k: string) => /^(AQ\.|sk_|pk_)/i.test(k.trim())
  const looksLikeGeminiKey = (k: string) => {
    const t = k.trim()
    if (!t || looksLikePollinationsKey(t)) return false
    // Google AI Studio / Generative Language keys typically start with AIza.
    if (/^AIza/i.test(t)) return true
    // Allow other non-Pollinations keys if explicitly set (some Google keys differ).
    return t.length >= 20 && !/\s/.test(t) && !/^(AQ\.|sk_|pk_)/i.test(t)
  }
  const isUsablePollinationsCandidate = (k: string) => {
    const t = k.trim()
    if (!t || looksLikeGeminiKey(t)) return false
    if (looksLikePollinationsKey(t)) return true
    return t.length >= 16 && !/\s/.test(t)
  }
  /** Log-safe hint: yes/no + prefix + last4 — never the full key. */
  const keyHint = (k: string) => {
    if (!k) return 'no'
    const prefix = /^sk_/i.test(k)
      ? 'sk_'
      : /^AQ\./i.test(k)
        ? 'AQ'
        : /^pk_/i.test(k)
          ? 'pk_'
          : /^AIza/i.test(k)
            ? 'AIza'
            : '?'
    return `yes ${prefix}…${k.slice(-4)}`
  }
  /**
   * Collect env → userData → bundled, then prefer sk_ over AQ for video.
   * Packaged builds rely on bundled defaults when .env is absent.
   */
  const resolvePollinationsKey = () => {
    const candidates: string[] = []
    const push = (raw: string) => {
      const t = String(raw || '').trim()
      if (!isUsablePollinationsCandidate(t)) return
      if (!candidates.includes(t)) candidates.push(t)
    }
    push(process.env.POLLINATIONS_API_KEY || '')
    push(process.env.AI_VIDEO_API_KEY || '')
    push(readSavedPollinationsKey())
    push(BUNDLED_POLLINATIONS_SK)
    push(BUNDLED_POLLINATIONS_AQ)
    const sk = candidates.find((k) => /^sk_/i.test(k))
    if (sk) return sk
    const pk = candidates.find((k) => /^pk_/i.test(k))
    if (pk) return pk
    const aq = candidates.find((k) => /^AQ\./i.test(k))
    if (aq) return aq
    return candidates[0] || ''
  }
  const resolveGeminiKey = () => {
    // Prefer process.env (loadEnvFile / shell), then userData, then bundled AIza only.
    const fromEnv = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim()
    if (looksLikeGeminiKey(fromEnv)) return fromEnv
    if (fromEnv) {
      console.warn(
        '[ai] GEMINI/GOOGLE_API_KEY looks like a Pollinations key — ignored for Gemini/Veo (use AIza… only)',
      )
    }
    const saved = readSavedGeminiKey()
    if (looksLikeGeminiKey(saved)) return saved
    const bundled = String(BUNDLED_GEMINI_KEY || '').trim()
    if (looksLikeGeminiKey(bundled)) return bundled
    return ''
  }
  // Snapshot at startup for nested helpers; ai:generate re-resolves after loadEnvFile().
  let VIDEO_API_KEY = resolvePollinationsKey()
  let GEMINI_API_KEY = resolveGeminiKey()
  console.log(
    `[ai] keys: Gemini=${keyHint(GEMINI_API_KEY)} Pollinations=${keyHint(VIDEO_API_KEY)} packaged=${app.isPackaged}`,
  )
  const titleFromPrompt = (prompt: string) =>
    (prompt.trim().replace(/\s+/g, ' ').slice(0, 48) || 'AI content')
  const hashPrompt = (prompt: string) => {
    let h = 2166136261
    for (let i = 0; i < prompt.length; i++) {
      h ^= prompt.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return h >>> 0
  }
  const pickLiveStyle = (prompt: string, seed: number) => {
    const p = prompt.toLowerCase()
    if (/ocean|wave|fluid|water|liquid|river/.test(p)) return 'liquid'
    if (/fire|ember|spark|lava|magma|flame/.test(p)) return 'embers'
    if (/aurora|northern|glow|dream|fog|mist/.test(p)) return 'aurora'
    if (/neon|pulse|beat|music|party|club/.test(p)) return 'pulse'
    if (/scan|tech|cyber|glitch|matrix|hud/.test(p)) return 'scan'
    if (/ribbon|silk|fabric|flow|stream/.test(p)) return 'ribbons'
    const styles = ['aurora', 'liquid', 'embers', 'ribbons', 'pulse', 'field', 'scan']
    return styles[seed % styles.length]
  }
  const motionPrompt = (prompt: string) =>
    [
      'Cinematic seamless looping motion graphics for architectural projection mapping.',
      'Continuous camera-free motion, rich light movement, no text, no watermark, no freeze-frame.',
      'Smooth looping animation, vivid colors, abstract and atmospheric.',
      `Subject: ${prompt.trim()}`,
    ].join(' ')
  const toDataUrl = (base64: string, contentType?: string) =>
    `data:${contentType || 'application/octet-stream'};base64,${base64}`
  const uaHeader =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  const sliceMsg = (s: string, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n)
  /** Parse Gemini/Veo JSON error bodies into actionable UI text. */
  const describeGeminiHttpError = (status: number, text: string, json?: any): string => {
    const apiMsg = String(json?.error?.message || json?.message || text || '').trim()
    const lower = apiMsg.toLowerCase()
    if (!GEMINI_API_KEY) {
      return 'Gemini API key missing'
    }
    if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED|API key/i.test(apiMsg)) {
      return `Gemini auth failed (${status}): ${sliceMsg(apiMsg || 'invalid API key', 80)}. Use an AIza… key.`
    }
    if (
      status === 429 ||
      /RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(apiMsg) ||
      /exceeded your current quota/i.test(lower)
    ) {
      return `Gemini quota exceeded: ${sliceMsg(apiMsg || 'rate limit / quota', 80)}`
    }
    if (/billing|payment|enable billing|billable/i.test(apiMsg)) {
      return `Gemini billing required: ${sliceMsg(apiMsg, 80)}`
    }
    if (status === 404 || /not found for API version|is not supported for predictLongRunning/i.test(apiMsg)) {
      return `Gemini model not available (404): ${sliceMsg(apiMsg || 'model missing', 70)}`
    }
    if (/personGeneration/i.test(apiMsg)) {
      return `Gemini personGeneration rejected: ${sliceMsg(apiMsg, 70)}`
    }
    if (/safety|blocked|rai/i.test(apiMsg)) {
      return `Gemini blocked by safety filters: ${sliceMsg(apiMsg, 70)}`
    }
    return `Gemini failed (${status}): ${sliceMsg(apiMsg || 'unknown error', 80)}`
  }
  /** Shorten provider errors for UI (keep actionable detail; max ~120 chars). */
  const shortCloudError = (raw: string): string => {
    const t = String(raw || '')
    // Never surface Pollinations SQL / community_endpoint dumps in Motion (or any) UI.
    if (/community_endpoint|Failed query|SELECT\s+"/i.test(t)) {
      return 'Pollinations server error — try again or use a sk_ key from enter.pollinations.ai'
    }
    if (/Add GEMINI_API_KEY|Gemini API key missing/i.test(t)) {
      return 'Gemini API key missing'
    }
    if (/Pollinations API key missing/i.test(t)) {
      return 'Pollinations API key missing — bundled/env key unavailable'
    }
    if (/Insufficient (pollen )?balance|PAYMENT_REQUIRED|402/i.test(t) && /pollinations|pollen/i.test(t)) {
      return 'Pollinations: no Pollen balance — top up at https://enter.pollinations.ai'
    }
    if (/AQ\.|legacy AQ|gen\.pollinations.*reject|sk_ key/i.test(t) && /pollinations|401|auth/i.test(t)) {
      return sliceMsg(t, 120)
    }
    if (/Pollinations auth failed|Pollinations video failed/i.test(t)) {
      return sliceMsg(t, 120)
    }
    if (/Authentication required|401/i.test(t) && /pollinations|Bearer|Authorization/i.test(t)) {
      return 'Pollinations auth failed — use sk_… from enter.pollinations.ai/keys (AQ may be rejected)'
    }
    if (/quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(t)) return sliceMsg(t, 120)
    if (/billing/i.test(t)) return sliceMsg(t, 120)
    if (/Gemini auth failed|Gemini model not available|Gemini quota|Gemini billing|Gemini blocked|Gemini personGeneration|Gemini failed/i.test(t)) {
      return sliceMsg(t, 120)
    }
    if (/not found for API version|is not supported for predictLongRunning|404/i.test(t) && /veo|Gemini|models\//i.test(t)) {
      return 'Gemini model not available — try GEMINI_VIDEO_MODEL=veo-3.1-fast-generate-preview'
    }
    return sliceMsg(t, 120)
  }
  /** Node http(s) GET that re-sends Authorization on every redirect hop (fetch strips it). */
  const fetchBinaryPreserveAuth = (
    url: string,
    headers?: Record<string, string>,
  ): Promise<{
    ok: boolean
    status: number
    base64: string
    contentType: string
    text: string
  }> =>
    new Promise((resolve) => {
      const baseHeaders: Record<string, string> = {
        'User-Agent': uaHeader,
        ...(headers ?? {}),
      }
      let hops = 0
      const go = (current: string) => {
        if (hops++ > 8) {
          resolve({
            ok: false,
            status: 0,
            base64: '',
            contentType: 'application/octet-stream',
            text: 'Too many redirects',
          })
          return
        }
        let parsed: URL
        try {
          parsed = new URL(current)
        } catch {
          resolve({
            ok: false,
            status: 0,
            base64: '',
            contentType: 'application/octet-stream',
            text: 'Invalid URL',
          })
          return
        }
        const lib = parsed.protocol === 'http:' ? http : https
        const req = lib.get(
          current,
          { headers: baseHeaders, timeout: 180000 },
          (res) => {
            const status = res.statusCode || 0
            const loc = res.headers.location
            if (loc && [301, 302, 303, 307, 308].includes(status)) {
              res.resume()
              go(new URL(loc, current).toString())
              return
            }
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
            res.on('end', () => {
              const buf = Buffer.concat(chunks)
              const base64 = buf.toString('base64')
              const contentType =
                String(res.headers['content-type'] || 'application/octet-stream').split(';')[0] ||
                'application/octet-stream'
              resolve({
                ok: status >= 200 && status < 300,
                status,
                base64,
                contentType,
                text: status >= 200 && status < 300 ? '' : buf.toString('utf8').slice(0, 240),
              })
            })
            res.on('error', (e) => {
              resolve({
                ok: false,
                status: 0,
                base64: '',
                contentType: 'application/octet-stream',
                text: e.message,
              })
            })
          },
        )
        req.on('timeout', () => {
          req.destroy()
          resolve({
            ok: false,
            status: 0,
            base64: '',
            contentType: 'application/octet-stream',
            text: 'Request timeout',
          })
        })
        req.on('error', (e) => {
          resolve({
            ok: false,
            status: 0,
            base64: '',
            contentType: 'application/octet-stream',
            text: e.message,
          })
        })
      }
      go(url)
    })
  const fetchBinary = async (
    url: string,
    headers?: Record<string, string>,
    opts?: { preserveAuthRedirects?: boolean },
  ) => {
    // Chromium/net.fetch strips Authorization on cross-origin redirects; use Node http when Bearer is required.
    if (opts?.preserveAuthRedirects) {
      return fetchBinaryPreserveAuth(url, headers)
    }
    const res = await net.fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': uaHeader,
        ...(headers ?? {}),
      },
      redirect: 'follow',
    })
    const ab = await res.arrayBuffer()
    const base64 = Buffer.from(ab).toString('base64')
    return {
      ok: res.ok,
      status: res.status,
      base64,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      text:
        !res.ok && base64
          ? Buffer.from(ab).toString('utf8').slice(0, 240)
          : '',
    }
  }
  const fetchJson = async (
    url: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const res = await net.fetch(url, {
      method,
      headers: {
        'User-Agent': uaHeader,
        'Content-Type': 'application/json',
        ...(headers ?? {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text }
  }
  const geminiAuthHeaders = (): Record<string, string> => ({
    'x-goog-api-key': GEMINI_API_KEY,
  })
  const withGeminiKey = (url: string) => {
    if (!GEMINI_API_KEY) return url
    if (/[?&]key=/.test(url)) return url
    return url.includes('?')
      ? `${url}&key=${encodeURIComponent(GEMINI_API_KEY)}`
      : `${url}?key=${encodeURIComponent(GEMINI_API_KEY)}`
  }
  const extractGeminiVideoUri = (payload: any): string | null => {
    if (!payload || typeof payload !== 'object') return null
    // Official Veo path: response.generateVideoResponse.generatedSamples[0].video.uri
    const samples =
      payload?.response?.generateVideoResponse?.generatedSamples ||
      payload?.generateVideoResponse?.generatedSamples ||
      payload?.response?.generatedSamples
    if (Array.isArray(samples)) {
      for (const s of samples) {
        const uri = s?.video?.uri || s?.uri
        if (typeof uri === 'string' && uri) return uri
      }
    }
    const queue: any[] = [payload]
    while (queue.length) {
      const node = queue.shift()
      if (!node || typeof node !== 'object') continue
      const uri =
        (typeof node.video?.uri === 'string' && node.video.uri) ||
        (typeof node.uri === 'string' &&
        (node.uri.includes('files/') || node.uri.includes('generativelanguage'))
          ? node.uri
          : null)
      if (uri) return uri
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push(v)
      }
    }
    return null
  }
  const downloadGeminiFile = async (uri: string) => {
    // Docs: x-goog-api-key and/or ?key=; preserve auth across redirects.
    const headers = geminiAuthHeaders()
    let downloaded = await fetchBinary(withGeminiKey(uri), headers, {
      preserveAuthRedirects: true,
    })
    if (!downloaded.ok || downloaded.base64.length < 2000) {
      downloaded = await fetchBinary(uri, headers, { preserveAuthRedirects: true })
    }
    return downloaded
  }
  const extractGeminiVideo = async (
    payload: any,
  ): Promise<{ base64: string; contentType: string } | null> => {
    if (!payload || typeof payload !== 'object') return null
    const queue: any[] = [payload]
    while (queue.length) {
      const node = queue.shift()
      if (!node || typeof node !== 'object') continue
      const b64 =
        (typeof node.inlineData?.data === 'string' && node.inlineData.data) ||
        (typeof node.video?.bytesBase64Encoded === 'string' && node.video.bytesBase64Encoded) ||
        (typeof node.bytesBase64Encoded === 'string' && node.bytesBase64Encoded)
      if (b64 && b64.length > 1000) {
        const contentType =
          node.inlineData?.mimeType || node.video?.mimeType || node.mimeType || 'video/mp4'
        return { base64: b64, contentType }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push(v)
      }
    }
    const uri = extractGeminiVideoUri(payload)
    if (!uri) return null
    const downloaded = await downloadGeminiFile(uri)
    if (!downloaded.ok || downloaded.base64.length < 2000) {
      throw new Error(
        `Gemini video download failed (${downloaded.status}): ${downloaded.text || downloaded.contentType}`,
      )
    }
    const contentType = downloaded.contentType.includes('video')
      ? downloaded.contentType
      : 'video/mp4'
    return { base64: downloaded.base64, contentType }
  }
  const listGeminiVeoModels = async (): Promise<string[]> => {
    try {
      const listUrl = withGeminiKey(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      )
      const listed = await fetchJson(listUrl, 'GET', undefined, geminiAuthHeaders())
      if (!listed.ok || !Array.isArray(listed.json?.models)) return []
      const found: string[] = []
      for (const m of listed.json.models) {
        const name = String(m?.name || '').replace(/^models\//, '')
        if (!name.toLowerCase().includes('veo')) continue
        const methods: string[] = Array.isArray(m?.supportedGenerationMethods)
          ? m.supportedGenerationMethods.map(String)
          : []
        // Prefer models that advertise predictLongRunning; include other veo if methods unknown.
        if (methods.length && !methods.includes('predictLongRunning')) continue
        found.push(name)
      }
      // Prefer fast / 3.1 / 3.0 preview ids first
      const rank = (id: string) => {
        const s = id.toLowerCase()
        if (s.includes('3.1') && s.includes('fast')) return 0
        if (s.includes('3.1')) return 1
        if (s.includes('3.0') && s.includes('fast')) return 2
        if (s.includes('3.0')) return 3
        if (s.includes('2.0')) return 90
        return 50
      }
      return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    } catch {
      return []
    }
  }
  const generateGeminiVideo = async (prompt: string) => {
    if (!GEMINI_API_KEY) {
      throw new Error(
        'Gemini API key missing',
      )
    }
    // Current Veo models (2026). Skip veo-2 (often 404 / region-limited).
    const preferred = [
      process.env.GEMINI_VIDEO_MODEL,
      'veo-3.1-fast-generate-preview',
      'veo-3.1-generate-preview',
      'veo-3.1-lite-generate-preview',
      'veo-3.0-fast-generate-001',
      'veo-3.0-generate-001',
      'veo-3.0-fast-generate-preview',
      'veo-3.0-generate-preview',
    ].filter((m): m is string => Boolean(m) && !/^veo-2(\.|$)/i.test(String(m)))
    const discovered = await listGeminiVeoModels()
    const models = [
      ...preferred,
      ...discovered.filter((m) => !preferred.includes(m) && !/^veo-2/i.test(m)),
    ]
    // Veo accepts "4" | "6" | "8" (string).
    const durationRaw = String(process.env.GEMINI_VIDEO_DURATION || '6')
    const durationSeconds = ['4', '6', '8'].includes(durationRaw) ? durationRaw : '6'
    const aspectRatio = process.env.GEMINI_VIDEO_ASPECT_RATIO || '16:9'
    const enhanced = motionPrompt(prompt)
    // Official curl samples often omit parameters. EU/UK/CH require allow_adult (not allow_all).
    type ParamSet =
      | { label: string; parameters?: Record<string, string> }
    const paramSets: ParamSet[] = [
      { label: 'defaults' },
      {
        label: 'allow_adult',
        parameters: { durationSeconds, aspectRatio, personGeneration: 'allow_adult' },
      },
      {
        label: 'allow_all',
        parameters: { durationSeconds, aspectRatio, personGeneration: 'allow_all' },
      },
    ]
    const authHeaders = geminiAuthHeaders()
    let lastUsefulError = 'Gemini video start failed'
    console.log(`[ai] Veo: trying models=${models.slice(0, 5).join(', ')}…`)
    for (const model of models) {
      for (const paramSet of paramSets) {
        const requestBody: Record<string, unknown> = {
          instances: [{ prompt: enhanced }],
        }
        if (paramSet.parameters) requestBody.parameters = paramSet.parameters
        const base =
          process.env.GEMINI_VIDEO_BASE_URL ||
          `https://generativelanguage.googleapis.com/v1beta/models/${model}`
        const createUrl = withGeminiKey(`${base}:predictLongRunning`)
        console.log(`[ai] Veo start model=${model} params=${paramSet.label}`)
        const started = await fetchJson(createUrl, 'POST', requestBody, authHeaders)
        if (!started.ok) {
          const detail = describeGeminiHttpError(started.status, started.text, started.json)
          console.warn(`[ai] Veo start failed ${model}/${paramSet.label}:`, detail)
          if (started.status === 404) {
            lastUsefulError = detail
            break // next model
          }
          if (
            started.status === 400 &&
            /personGeneration/i.test(String(started.text || started.json?.error?.message || ''))
          ) {
            lastUsefulError = detail
            continue
          }
          if (started.status === 401 || started.status === 403) {
            throw new Error(detail)
          }
          if (started.status === 429 || /quota|RESOURCE_EXHAUSTED|billing/i.test(detail)) {
            throw new Error(detail)
          }
          lastUsefulError = detail
          // Try next param set for same model on generic 400s
          if (started.status === 400) continue
          break
        }
        try {
          const immediate = await extractGeminiVideo(started.json)
          if (immediate) {
            console.log(`[ai] Veo immediate video from ${model} (${immediate.base64.length} b64 chars)`)
            return immediate
          }
        } catch (e) {
          lastUsefulError = e instanceof Error ? e.message : 'Gemini extract failed'
        }
        const opName = started.json?.name || started.json?.operation?.name || ''
        if (!opName) {
          lastUsefulError = `Gemini ${model} returned no operation`
          break
        }
        const opUrl = withGeminiKey(
          opName.startsWith('http')
            ? opName
            : `https://generativelanguage.googleapis.com/v1beta/${opName}`,
        )
        const timeoutMs = Number(process.env.GEMINI_VIDEO_TIMEOUT_MS || 240000)
        const startedAt = Date.now()
        console.log(`[ai] Veo polling ${opName} (timeout ${timeoutMs}ms)`)
        while (Date.now() - startedAt < timeoutMs) {
          const polled = await fetchJson(opUrl, 'GET', undefined, authHeaders)
          if (polled.ok) {
            if (polled.json?.error) {
              lastUsefulError = describeGeminiHttpError(
                polled.status || 500,
                polled.text,
                polled.json?.error ? { error: polled.json.error } : polled.json,
              )
              console.warn('[ai] Veo op error:', lastUsefulError)
              break
            }
            try {
              const out = await extractGeminiVideo(polled.json)
              if (out) {
                console.log(`[ai] Veo ready from ${model} (${out.base64.length} b64 chars)`)
                return out
              }
            } catch (e) {
              lastUsefulError = e instanceof Error ? e.message : 'Gemini download failed'
              if (polled.json?.done === true) break
            }
            if (polled.json?.done === true) {
              const rai =
                polled.json?.response?.generateVideoResponse?.raiMediaFilteredReasons ||
                polled.json?.response?.generateVideoResponse?.raiMediaFilteredCount
              lastUsefulError = rai
                ? `Gemini blocked by safety filters: ${sliceMsg(JSON.stringify(rai))}`
                : `Gemini ${model} finished with no video bytes`
              console.warn('[ai]', lastUsefulError)
              break
            }
          } else if (polled.status === 401 || polled.status === 403) {
            throw new Error(describeGeminiHttpError(polled.status, polled.text, polled.json))
          }
          await new Promise((r) => setTimeout(r, 5000))
        }
        // Operation was accepted — do not retry other param sets for this model.
        break
      }
    }
    throw new Error(lastUsefulError)
  }
  const pollinationsAuthHeaders = (): Record<string, string> => {
    // Bearer is required by gen.pollinations.ai (401 without it). Always set when key exists.
    const headers: Record<string, string> = {
      Referer: 'https://pollinations.ai/',
      Origin: 'https://pollinations.ai',
      Accept: '*/*',
    }
    if (VIDEO_API_KEY) {
      headers.Authorization = `Bearer ${VIDEO_API_KEY}`
    }
    return headers
  }

  const describePollinationsHttpError = (
    status: number,
    text: string,
    contentType?: string,
  ): string => {
    const raw = String(text || '').trim()
    let msg = raw
    try {
      const j = JSON.parse(raw)
      msg = String(j?.error?.message || j?.message || j?.error || raw)
    } catch {
      /* keep raw */
    }
    const compact = sliceMsg(msg.replace(/\s+/g, ' '), 90)
    if (status === 401 || status === 403 || /Authentication required|UNAUTHORIZED/i.test(msg)) {
      if (/^AQ\./i.test(VIDEO_API_KEY)) {
        return `401 AQ key rejected by gen.pollinations.ai — create sk_ at enter.pollinations.ai/keys`
      }
      return `Pollinations auth failed (${status}): ${compact || 'invalid key'}`
    }
    if (status === 402 || /Insufficient (pollen )?balance|PAYMENT_REQUIRED/i.test(msg)) {
      return `Pollinations: insufficient Pollen balance — top up at enter.pollinations.ai`
    }
    if (/community_endpoint|Failed query|SELECT\s+"/i.test(msg)) {
      return `Pollinations server error (${status})`
    }
    if (contentType && /html/i.test(contentType)) return `Pollinations failed (${status})`
    return `Pollinations failed (${status}): ${compact || 'unknown'}`
  }

  const generatePollinationsImage = async (prompt: string) => {
    if (!VIDEO_API_KEY) {
      throw new Error(
        'Pollinations API key missing — bundled/env key unavailable',
      )
    }
    const q = encodeURIComponent(prompt.trim())
    const seed = Date.now() % 100000
    // Docs: Authorization Bearer + optional ?key= (not api_key)
    const keyQ = `&key=${encodeURIComponent(VIDEO_API_KEY)}`
    const candidates = [
      `https://gen.pollinations.ai/image/${q}?model=flux&nologo=true&seed=${seed}${keyQ}`,
      `https://image.pollinations.ai/prompt/${q}?width=1024&height=1024&nologo=true&seed=${seed}${keyQ}`,
      `https://image.pollinations.ai/prompt/${q}?width=768&height=768&nologo=true&seed=${seed}${keyQ}`,
    ]
    const headers = pollinationsAuthHeaders()
    if (!headers.Authorization) {
      throw new Error('Pollinations auth failed — check POLLINATIONS_API_KEY')
    }
    let lastDetail = ''
    for (const url of candidates) {
      const out = await fetchBinary(url, headers, { preserveAuthRedirects: true })
      if (out.ok && out.base64.length > 800 && out.contentType.includes('image')) return out
      lastDetail = describePollinationsHttpError(out.status, out.text, out.contentType)
    }
    throw new Error(`Cloud image generation unavailable (${lastDetail})`)
  }

  /**
   * Motion video via Pollinations gen.pollinations.ai/video/{prompt}.
   * Auth: Authorization Bearer + ?key=. Models: wan-fast, p-video, seedance-pro, nova-reel, wan.
   * Note: legacy AQ.… keys are often rejected by gen.* (need sk_); image.* may accept AQ but needs Pollen.
   */
  const generatePollinationsVideo = async (prompt: string) => {
    if (!VIDEO_API_KEY) {
      throw new Error(
        'Pollinations API key missing — bundled/env key unavailable',
      )
    }
    const q = encodeURIComponent(motionPrompt(prompt))
    const keyQ = `&key=${encodeURIComponent(VIDEO_API_KEY)}`
    const headers = pollinationsAuthHeaders()
    const isLegacyAq = /^AQ\./i.test(VIDEO_API_KEY)
    // Prefer cheap/fast models first; durations must match model constraints.
    const attempts: { model: string; duration: number; host: 'gen' | 'image' }[] = [
      { model: 'wan-fast', duration: 4, host: 'gen' },
      { model: 'p-video', duration: 4, host: 'gen' },
      { model: 'seedance-pro', duration: 4, host: 'gen' },
      { model: 'nova-reel', duration: 6, host: 'gen' },
      { model: 'wan', duration: 5, host: 'gen' },
    ]
    if (isLegacyAq) {
      // gen.pollinations.ai rejects AQ; image.pollinations.ai still authenticates AQ keys.
      for (const model of ['wan-fast', 'p-video', 'seedance-pro'] as const) {
        attempts.push({ model, duration: 4, host: 'image' })
      }
    }

    let lastUsefulError = ''
    let sawAqReject = false
    let sawNoPollen = false

    for (const attempt of attempts) {
      const url =
        attempt.host === 'gen'
          ? `https://gen.pollinations.ai/video/${q}?model=${attempt.model}&duration=${attempt.duration}&aspectRatio=16:9${keyQ}`
          : `https://image.pollinations.ai/prompt/${q}?model=${attempt.model}&duration=${attempt.duration}&aspectRatio=16:9&nologo=true${keyQ}`
      console.log(
        `[ai] Pollinations video try model=${attempt.model} host=${attempt.host}`,
      )
      const out = await fetchBinary(url, headers, { preserveAuthRedirects: true })
      const detail = describePollinationsHttpError(out.status, out.text, out.contentType)
      if (/401 AQ key rejected|Authentication required/i.test(detail)) sawAqReject = true
      if (/insufficient Pollen|402/i.test(detail)) sawNoPollen = true

      const bufHead = out.base64
        ? Buffer.from(out.base64, 'base64').subarray(0, 12)
        : Buffer.alloc(0)
      const isMp4 =
        bufHead.length >= 8 && bufHead.subarray(4, 8).toString('ascii') === 'ftyp'
      const looksVideo =
        out.ok &&
        out.base64.length > 8000 &&
        (isMp4 || /video|mp4|octet-stream/i.test(out.contentType))

      if (looksVideo) {
        const headChar = bufHead.subarray(0, 1).toString('utf8')
        if (headChar === '{' || headChar === '<') {
          lastUsefulError = detail || `non-video body from ${attempt.model}`
          continue
        }
        console.log(
          `[ai] Pollinations video OK model=${attempt.model} host=${attempt.host} (${out.base64.length} b64 chars)`,
        )
        return { base64: out.base64, contentType: 'video/mp4' }
      }

      lastUsefulError = detail || `${out.status} ${out.contentType}`
      console.warn(
        `[ai] Pollinations video fail ${attempt.model}/${attempt.host}:`,
        lastUsefulError,
      )
    }

    if (sawAqReject || (isLegacyAq && /401|auth/i.test(lastUsefulError))) {
      throw new Error(
        'Pollinations AQ key rejected by video API — create sk_ key at enter.pollinations.ai/keys',
      )
    }
    if (sawNoPollen) {
      throw new Error(
        'Pollinations: insufficient Pollen balance — top up at https://enter.pollinations.ai',
      )
    }
    throw new Error(
      lastUsefulError || 'Pollinations video failed — no working model/endpoint',
    )
  }

  /** Proxy image generation HTTP from main (avoids renderer CORS). */
  ipcMain.handle(
    'ai:http',
    async (
      _e,
      req: {
        url: string
        method?: string
        headers?: Record<string, string>
        body?: string | null
        bodyBase64?: string | null
        bodyMultipart?: { name: string; value: string }[] | null
        responseType?: 'json' | 'base64' | 'text'
      },
    ) => {
      try {
        const method = req.method ?? 'GET'
        const headers: Record<string, string> = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          ...(req.headers ?? {}),
        }
        let body: BodyInit | undefined

        if (req.bodyMultipart && req.bodyMultipart.length > 0) {
          const form = new FormData()
          for (const part of req.bodyMultipart) form.append(part.name, part.value)
          body = form
          delete headers['Content-Type']
          delete headers['content-type']
        } else if (req.bodyBase64) {
          body = Buffer.from(req.bodyBase64, 'base64')
        } else if (req.body != null) {
          body = req.body
        }

        // Prefer Electron net.fetch (Chromium stack) — Node fetch often gets CF 403
        const res = await net.fetch(req.url, { method, headers, body })
        const responseType = req.responseType ?? 'base64'
        if (responseType === 'json') {
          const json = await res.json()
          return { ok: res.ok, status: res.status, json }
        }
        if (responseType === 'text') {
          const text = await res.text()
          return { ok: res.ok, status: res.status, text }
        }
        const ab = await res.arrayBuffer()
        const base64 = Buffer.from(ab).toString('base64')
        const contentType = res.headers.get('content-type') || 'application/octet-stream'
        // Surface API error text when status is not OK
        let text: string | undefined
        if (!res.ok && contentType.includes('json')) {
          try {
            text = Buffer.from(ab).toString('utf8').slice(0, 240)
          } catch {
            /* ignore */
          }
        }
        return { ok: res.ok, status: res.status, base64, contentType, text }
      } catch (e) {
        return {
          ok: false,
          status: 0,
          error: e instanceof Error ? e.message : 'Request failed',
        }
      }
    },
  )

  ipcMain.handle('ai:getGeminiKeyStatus', async () => {
    loadEnvFile()
    GEMINI_API_KEY = resolveGeminiKey()
    VIDEO_API_KEY = resolvePollinationsKey()
    const geminiConfigured = !!GEMINI_API_KEY
    const pollinationsConfigured = !!VIDEO_API_KEY
    const configured = geminiConfigured || pollinationsConfigured
    // Prefer showing the provider Motion will try first (Gemini), else Pollinations.
    const activeKey = GEMINI_API_KEY || VIDEO_API_KEY
    const provider = geminiConfigured
      ? pollinationsConfigured
        ? ('both' as const)
        : ('gemini' as const)
      : pollinationsConfigured
        ? ('pollinations' as const)
        : (null as null)
    return {
      configured,
      last4: activeKey ? activeKey.slice(-4) : null,
      provider,
      geminiConfigured,
      pollinationsConfigured,
    }
  })

  ipcMain.handle('ai:setGeminiKey', async (_e, rawKey: unknown) => {
    try {
      const key = String(rawKey ?? '').trim()
      if (!key) {
        return {
          ok: false as const,
          error: 'Paste a Google AIza… or Pollinations AQ…/sk_… key',
        }
      }
      if (key.length > MAX_API_KEY_CHARS) {
        return {
          ok: false as const,
          error: `Key is too long (max ${MAX_API_KEY_CHARS} characters)`,
        }
      }
      if (/[\r\n\0]/.test(key)) {
        return {
          ok: false as const,
          error: 'Key must be a single line (no newlines)',
        }
      }

      // Route by prefix: never put AQ/sk_/pk_ into GEMINI_API_KEY.
      if (looksLikePollinationsKey(key)) {
        process.env.POLLINATIONS_API_KEY = key
        writeSavedPollinationsKey(key)
        const envPath = upsertEnvPollinationsKey(key)
        VIDEO_API_KEY = resolvePollinationsKey()
        console.log(
          '[ai] POLLINATIONS_API_KEY saved (userData' +
            (envPath ? ` + .env ${envPath}` : '') +
            ')',
        )
        return {
          ok: true as const,
          configured: true as const,
          last4: key.slice(-4),
          provider: 'pollinations' as const,
        }
      }
      if (!looksLikeGeminiKey(key)) {
        return {
          ok: false as const,
          error:
            'Invalid key — use AIza… (aistudio.google.com/apikey) or AQ…/sk_… (enter.pollinations.ai)',
        }
      }
      process.env.GEMINI_API_KEY = key
      writeSavedGeminiKey(key)
      const envPath = upsertEnvGeminiKey(key)
      GEMINI_API_KEY = resolveGeminiKey()
      console.log(
        '[ai] GEMINI_API_KEY saved (userData' +
          (envPath ? ` + .env ${envPath}` : '') +
          ')',
      )
      return {
        ok: true as const,
        configured: true as const,
        last4: key.slice(-4),
        provider: 'gemini' as const,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save key'
      console.error('[ai] key save failed:', msg)
      return {
        ok: false as const,
        error: msg,
      }
    }
  })

  ipcMain.handle(
    'ai:generate',
    async (_e, req: { prompt: string; kind: 'live' | 'still' | 'motion' }) => {
      try {
        // Re-read project .env + userData so newly pasted keys are picked up.
        loadEnvFile()
        VIDEO_API_KEY = resolvePollinationsKey()
        GEMINI_API_KEY = resolveGeminiKey()

        const prompt = (req?.prompt || '').trim()
        const kind = req?.kind || 'live'
        if (!prompt) return { ok: false, error: 'Enter a prompt' }
        const seed = hashPrompt(prompt)

        if (kind === 'motion') {
          // Order: Gemini Veo (AIza) → Pollinations video (AQ/sk_) → ask for a key.
          if (!GEMINI_API_KEY && !VIDEO_API_KEY) {
            return {
              ok: false,
              error:
                'Motion needs a cloud key — none resolved (bundled/env/userData empty)',
            }
          }

          const tryPersistVideo = async (
            base64: string,
            contentType: string,
            fileHint: string,
            via: string,
          ) => {
            await ensureMediaServer()
            const url = persistMediaBytes(
              Buffer.from(base64, 'base64'),
              contentType || 'video/mp4',
              fileHint,
            )
            console.log(`[ai] Motion graphic OK via ${via} →`, url)
            return {
              ok: true as const,
              item: {
                id: uid(),
                name: `${titleFromPrompt(prompt)} · video`,
                type: 'video' as const,
                url,
                thumbnail: url,
                prompt,
                source: 'stable-diffusion' as const,
              },
            }
          }

          let lastError = ''
          if (GEMINI_API_KEY) {
            try {
              const g = await generateGeminiVideo(prompt)
              return await tryPersistVideo(g.base64, g.contentType, 'gemini.mp4', 'Gemini/Veo')
            } catch (e) {
              lastError = shortCloudError(
                e instanceof Error ? e.message : 'Gemini video failed',
              )
              console.warn('[ai] Motion Gemini failed, trying Pollinations…', lastError)
              if (!VIDEO_API_KEY) {
                console.error('[ai] Motion graphic hard-fail:', lastError)
                return { ok: false, error: lastError }
              }
            }
          }

          if (VIDEO_API_KEY) {
            try {
              const v = await generatePollinationsVideo(prompt)
              return await tryPersistVideo(
                v.base64,
                v.contentType,
                'pollinations.mp4',
                'Pollinations',
              )
            } catch (e) {
              lastError = shortCloudError(
                e instanceof Error ? e.message : 'Pollinations video failed',
              )
              console.error('[ai] Motion graphic hard-fail:', lastError)
              return { ok: false, error: lastError }
            }
          }

          return { ok: false, error: lastError || 'Motion video generation failed' }
        }

        const img = await generatePollinationsImage(prompt)
        const imageUrl = toDataUrl(img.base64, img.contentType)
        if (kind === 'still') {
          return {
            ok: true,
            item: {
              id: uid(),
              name: titleFromPrompt(prompt),
              type: 'image',
              url: imageUrl,
              thumbnail: imageUrl,
              prompt,
              source: 'stable-diffusion',
            },
          }
        }

        return {
          ok: true,
          item: {
            id: uid(),
            name: `${titleFromPrompt(prompt)} · live`,
            type: 'ai',
            url: imageUrl,
            thumbnail: imageUrl,
            prompt,
            source: 'stable-diffusion',
            recipe: {
              palette: ['#3dd6c6', '#5b8def', '#0a0c0f', '#e8edf4'],
              mode: 'livingArt',
              liveStyle: pickLiveStyle(prompt, seed),
              speed: 0.55 + ((seed >> 3) % 50) / 100,
              density: 0.55 + ((seed >> 9) % 50) / 100,
              seed,
            },
          },
        }
      } catch (e) {
        return {
          ok: false,
          error: shortCloudError(
            e instanceof Error ? e.message : 'Generation failed',
          ),
        }
      }
    },
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
