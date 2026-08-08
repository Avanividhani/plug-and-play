/** Prefer external USB cameras (Logitech) over built-in laptop webcams. */

export type CameraDevice = {
  deviceId: string
  label: string
  kind: 'videoinput'
  isLogitech: boolean
  isBuiltin: boolean
  preferred: boolean
}

const BUILTIN_PATTERNS =
  /integrated|facetime|built[- ]?in|laptop|iris|hd webcam|hd camera|surface camera|lenovo|dell camera|hp (hd|truevision)|chicony|realtime|front camera/i

const LOGITECH_PATTERNS = /logitech|c920|c922|c930|brio|streamcam|webcam c|hd pro|c270|c310|c505|c615/i

export function classifyCamera(label: string): Pick<CameraDevice, 'isLogitech' | 'isBuiltin' | 'preferred'> {
  const isLogitech = LOGITECH_PATTERNS.test(label)
  const isBuiltin = !isLogitech && BUILTIN_PATTERNS.test(label)
  // Prefer Logitech; otherwise any non-builtin; never prefer obvious laptop cams
  const preferred = isLogitech || (!isBuiltin && label.length > 0)
  return { isLogitech, isBuiltin, preferred }
}

export async function enumerateCameras(): Promise<CameraDevice[]> {
  // Permission prompt so labels are populated
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    stream.getTracks().forEach((t) => t.stop())
  } catch {
    // may already have permission or no device yet
  }

  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d) => {
      const label = d.label || `Camera ${d.deviceId.slice(0, 6)}`
      const flags = classifyCamera(label)
      return {
        deviceId: d.deviceId,
        label,
        kind: 'videoinput' as const,
        ...flags,
      }
    })
    .sort((a, b) => {
      if (a.isLogitech !== b.isLogitech) return a.isLogitech ? -1 : 1
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
      if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? 1 : -1
      return a.label.localeCompare(b.label)
    })
}

export function pickBestCamera(cameras: CameraDevice[]): CameraDevice | null {
  if (!cameras.length) return null
  const logitech = cameras.find((c) => c.isLogitech)
  if (logitech) return logitech
  const preferred = cameras.find((c) => c.preferred && !c.isBuiltin)
  if (preferred) return preferred
  const external = cameras.find((c) => !c.isBuiltin)
  return external ?? cameras[0]
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
