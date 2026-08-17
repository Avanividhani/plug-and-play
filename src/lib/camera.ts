/** Prefer external USB cameras (Logitech) over built-in laptop webcams. */

import { extractModelHint } from './displayNames'

export type CameraDevice = {
  deviceId: string
  groupId: string
  label: string
  /** Short model hint parsed from the OS label when available. */
  model: string | null
  kind: 'videoinput'
  isLogitech: boolean
  isBuiltin: boolean
  isVirtual: boolean
  preferred: boolean
}

export type AudioDevice = {
  deviceId: string
  groupId: string
  label: string
  model: string | null
  kind: 'audioinput' | 'audiooutput'
  /** Chromium/Electron `default` endpoint for this kind. */
  isDefault: boolean
  /** Chromium/Electron `communications` endpoint for this kind. */
  isCommunications: boolean
  /** Virtual, mapper, HDMI-display, VR, or other non-useful endpoint. */
  isClutter: boolean
}

const BUILTIN_PATTERNS =
  /integrated|facetime|built[- ]?in|laptop|iris|hd webcam|hd camera|surface camera|lenovo|dell camera|hp (hd|truevision)|chicony|realtime|front camera/i

const LOGITECH_PATTERNS = /logitech|c920|c922|c930|brio|streamcam|webcam c|hd pro|c270|c310|c505|c615/i

/**
 * VR headset phantoms — Windows often registers these as videoinput with no usable stream.
 * Always treated as virtual; hidden unless the user enables "Show virtual cameras".
 */
const VR_PHANTOM_CAMERA_PATTERNS =
  /meta\s*quest|oculus|vive|htc\s*vive|steam\s*vr|steamvr|open\s*xr|quest\s*(link|2|3|pro|s\b)|rift\s*(s\b|cv1)?/i

/** Soft virtual cams (OBS, etc.) — also hidden by default. */
const SOFT_VIRTUAL_CAMERA_PATTERNS =
  /virtual\s*cam|obs\s*virtual|manycam|xsplit|snap\s*camera|droidcam|iriun|nvidia\s*broadcast|mmhmm|youtube\s*live/i

const VIRTUAL_CAMERA_PATTERNS = new RegExp(
  `(?:${VR_PHANTOM_CAMERA_PATTERNS.source})|(?:${SOFT_VIRTUAL_CAMERA_PATTERNS.source})`,
  'i',
)

/**
 * Labels that are clearly audio endpoints. Some Windows installs expose speaker /
 * HDMI-audio names under the wrong media kind; never list these as cameras.
 */
const AUDIO_ONLY_LABEL_PATTERNS =
  /\b(speaker|speakers|headphone|headphones|headset|earphone|earphones|microphone|mic\b|audio\s*(device|endpoint|output|input)|realtek|hdmi\s*(audio|output)|digital\s*audio|spdif|optical\s*out|line\s*in|line\s*out|stereo\s*mix|what\s*u\s*hear)\b/i

export function classifyCamera(
  label: string,
): Pick<CameraDevice, 'isLogitech' | 'isBuiltin' | 'isVirtual' | 'preferred'> {
  const isVirtual = VIRTUAL_CAMERA_PATTERNS.test(label)
  const isLogitech = !isVirtual && LOGITECH_PATTERNS.test(label)
  const isBuiltin = !isLogitech && !isVirtual && BUILTIN_PATTERNS.test(label)
  // Prefer Logitech; otherwise any non-builtin physical cam; never prefer virtual/laptop cams
  const preferred = isLogitech || (!isBuiltin && !isVirtual && label.length > 0)
  return { isLogitech, isBuiltin, isVirtual, preferred }
}

/** True for VR headset leftovers that should never count as usable cameras. */
export function isVrPhantomCamera(label: string): boolean {
  return VR_PHANTOM_CAMERA_PATTERNS.test((label || '').trim())
}

function looksLikeAudioOnly(label: string): boolean {
  const raw = (label || '').trim()
  if (!raw) return false
  // VR headset leftovers are virtual cameras (hidden by default), not audio mislabels.
  if (isVrPhantomCamera(raw)) return false
  // Real webcams sometimes include "Microphone" in a composite name — keep those if webcam-like.
  if (/webcam|camera|logitech|c\d{3}|brio|facetime|integrated/i.test(raw)) return false
  if (AUDIO_ONLY_LABEL_PATTERNS.test(raw)) return true
  if (/oculus\s*virtual\s*audio|meta\s*quest.*\b(audio|speaker|headphone|microphone|mic)\b/i.test(raw)) {
    return true
  }
  return false
}

export type EnumerateCamerasOptions = {
  /** When false (default), drop virtual / VR phantom videoinputs from the list. */
  includeVirtual?: boolean
}

async function ensureMediaLabels(): Promise<void> {
  // Permission prompt so labels are populated (video only — do not open audio).
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    stream.getTracks().forEach((t) => t.stop())
  } catch {
    // may already have permission or no device yet
  }
}

export async function enumerateCameras(
  options: EnumerateCamerasOptions = {},
): Promise<CameraDevice[]> {
  const { includeVirtual = false } = options
  await ensureMediaLabels()

  const devices = await navigator.mediaDevices.enumerateDevices()
  const listed = devices
    .filter((d) => d.kind === 'videoinput')
    .filter((d) => !looksLikeAudioOnly(d.label || ''))
    .map((d) => {
      const label = (d.label || '').trim() || `Camera ${d.deviceId.slice(0, 8)}`
      const flags = classifyCamera(label)
      return {
        deviceId: d.deviceId,
        groupId: d.groupId || '',
        label,
        model: extractModelHint(label),
        kind: 'videoinput' as const,
        ...flags,
      }
    })
    .sort((a, b) => {
      if (a.isLogitech !== b.isLogitech) return a.isLogitech ? -1 : 1
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
      if (a.isVirtual !== b.isVirtual) return a.isVirtual ? 1 : -1
      if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? 1 : -1
      return a.label.localeCompare(b.label)
    })

  // Default: only real usable cameras — hide VR phantoms and soft virtual cams.
  if (!includeVirtual) {
    return listed.filter((c) => !c.isVirtual && !isVrPhantomCamera(c.label))
  }
  return listed
}

/**
 * Windows / Chromium ghost endpoints — hide unless "Show all audio devices".
 * Includes mappers, loopback, VR audio, virtual cables, display HDMI audio, HFP BT duplicates.
 */
const AUDIO_CLUTTER_PATTERNS =
  /microsoft\s*sound\s*mapper|primary\s*sound\s*(driver|capture)|wave\s*mapper|stereo\s*mix|what\s*u\s*hear|meta\s*quest|oculus|vb[- ]?audio|voicemeeter|cable\s*(input|output)|virtual\s*(cable|audio)|nvidia.+(hdmi|high\s*definition\s*audio)|amd\s*hdmi|intel.+\bdisplay\s*audio|hdmi(\s*audio|\s*output)?|display\s*audio|digital\s*audio.+(hdmi|dp|display)|steam\s*streaming|hands[- ]?free(\s*ag)?\s*audio/i

function stripAudioRolePrefix(label: string): string {
  return label.replace(/^(default|communications)\s*[-–—:]\s*/i, '').trim()
}

function normalizeAudioLabel(label: string): string {
  return stripAudioRolePrefix(label).replace(/\s+/g, ' ').toLowerCase()
}

export function isAudioClutter(label: string): boolean {
  const raw = (label || '').trim()
  if (!raw) return false
  const core = stripAudioRolePrefix(raw)
  return AUDIO_CLUTTER_PATTERNS.test(core) || AUDIO_CLUTTER_PATTERNS.test(raw)
}

function sortAudioDevices(a: AudioDevice, b: AudioDevice): number {
  if (a.kind !== b.kind) return a.kind === 'audiooutput' ? -1 : 1
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
  if (a.isCommunications !== b.isCommunications) return a.isCommunications ? -1 : 1
  return a.label.localeCompare(b.label)
}

/** Deduplicate by kind + normalized label; prefer default → communications → first. */
function dedupeAudioDevices(list: AudioDevice[]): AudioDevice[] {
  const rank = (d: AudioDevice) => (d.isDefault ? 0 : d.isCommunications ? 1 : 2)
  const best = new Map<string, AudioDevice>()
  for (const d of list) {
    const key = `${d.kind}:${normalizeAudioLabel(d.label)}`
    const prev = best.get(key)
    if (!prev || rank(d) < rank(prev)) best.set(key, d)
  }
  return [...best.values()].sort(sortAudioDevices)
}

/**
 * Default list: Chromium `default` (+ `communications` when the underlying
 * endpoint differs). Falls back to non-clutter physical endpoints if defaults
 * are missing (e.g. labels not yet granted).
 */
export function filterMeaningfulAudio(devices: AudioDevice[]): AudioDevice[] {
  const meaningful: AudioDevice[] = []
  for (const kind of ['audiooutput', 'audioinput'] as const) {
    const ofKind = devices.filter((d) => d.kind === kind)
    const def = ofKind.find((d) => d.isDefault)
    const comm = ofKind.find((d) => d.isCommunications)
    if (def) meaningful.push(def)
    if (
      comm &&
      (!def || normalizeAudioLabel(comm.label) !== normalizeAudioLabel(def.label))
    ) {
      meaningful.push(comm)
    }
  }
  if (meaningful.length > 0) return meaningful.sort(sortAudioDevices)

  return dedupeAudioDevices(devices.filter((d) => !d.isClutter && !d.isDefault && !d.isCommunications))
}

export type EnumerateAudioOptions = {
  /** When true, return every OS endpoint (still annotated). Default false. */
  includeAll?: boolean
}

export async function enumerateAudioDevices(
  options: EnumerateAudioOptions = {},
): Promise<AudioDevice[]> {
  const { includeAll = false } = options
  await ensureMediaLabels()
  const devices = await navigator.mediaDevices.enumerateDevices()
  const listed = devices
    .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
    .map((d) => {
      const label =
        (d.label || '').trim() ||
        `${d.kind === 'audiooutput' ? 'Speaker' : 'Microphone'} ${d.deviceId.slice(0, 8)}`
      const id = (d.deviceId || '').toLowerCase()
      return {
        deviceId: d.deviceId,
        groupId: d.groupId || '',
        label,
        model: extractModelHint(label),
        kind: d.kind as 'audioinput' | 'audiooutput',
        isDefault: id === 'default',
        isCommunications: id === 'communications',
        isClutter: isAudioClutter(label),
      }
    })
    .sort(sortAudioDevices)

  if (includeAll) return listed
  return filterMeaningfulAudio(listed)
}

export function pickBestCamera(cameras: CameraDevice[]): CameraDevice | null {
  if (!cameras.length) return null
  const logitech = cameras.find((c) => c.isLogitech)
  if (logitech) return logitech
  const preferred = cameras.find((c) => c.preferred && !c.isBuiltin && !c.isVirtual)
  if (preferred) return preferred
  const external = cameras.find((c) => !c.isBuiltin && !c.isVirtual)
  return external ?? cameras.find((c) => !c.isVirtual) ?? cameras[0]
}

export async function openCamera(
  deviceId: string,
  constraints?: MediaTrackConstraints,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      ...constraints,
    },
  })
}

export function watchDeviceChanges(onChange: () => void): () => void {
  const handler = () => onChange()
  navigator.mediaDevices.addEventListener('devicechange', handler)
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler)
}
