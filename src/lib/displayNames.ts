/**
 * Human-readable display/projector names from OS labels.
 * Never invent brand names (e.g. Meta Quest) — only reflect what the OS reports.
 */

const GENERIC_DISPLAY = /^(display|screen|monitor)\s*\d*$/i

const PROJECTOR_VENDORS =
  /\b(acer|epson|benq|optoma|sony|lg|samsung|viewsonic|nec|casio|panasonic|sharp|dell|christie|barco|infocus|hitachi|vivitek)\b/i

export function friendlyDisplayName(label: string | undefined, index: number): string {
  const raw = (label || '').trim()
  if (!raw || GENERIC_DISPLAY.test(raw)) return `Projector ${index + 1}`
  const vendor = raw.match(PROJECTOR_VENDORS)?.[1]
  if (vendor && !/projector|monitor|display/i.test(raw)) {
    return `${vendor.charAt(0).toUpperCase()}${vendor.slice(1).toLowerCase()} projector`
  }
  return raw
}

/** Short model / id hint from a raw device label when present. */
export function extractModelHint(label: string): string | null {
  const raw = (label || '').trim()
  if (!raw) return null
  // Common webcam / display model tokens: C920, EB-X06, XGA, etc.
  const model = raw.match(
    /\b([A-Z]{1,4}[- ]?\d{2,4}[A-Z0-9]*)\b|\b(C\d{3,4}|Brio|StreamCam|EB-[A-Z0-9]+|WUXGA|WXGA|XGA)\b/i,
  )
  return model?.[0] ?? null
}

/** VR / virtual desktop displays that should not count as projectors. */
export function isVrPhantomDisplay(label: string, model?: string | null, manufacturer?: string | null): boolean {
  const hay = `${label || ''} ${model || ''} ${manufacturer || ''}`.trim()
  if (!hay) return false
  return /meta\s*quest|oculus|vive|htc\s*vive|steam\s*vr|steamvr|virtual\s*desktop|quest\s*link|open\s*xr/i.test(
    hay,
  )
}
