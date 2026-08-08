/** Map pointer / overlay coords through object-fit:contain video letterboxing. */

export type ContentBox = {
  /** offset of video content inside the wrap (CSS px) */
  offsetX: number
  offsetY: number
  contentW: number
  contentH: number
  wrapW: number
  wrapH: number
}

export function getContainedVideoBox(
  wrapW: number,
  wrapH: number,
  videoW: number,
  videoH: number,
): ContentBox {
  const vw = Math.max(1, videoW)
  const vh = Math.max(1, videoH)
  const videoAspect = vw / vh
  const wrapAspect = wrapW / Math.max(1, wrapH)

  let contentW: number
  let contentH: number
  let offsetX: number
  let offsetY: number

  if (wrapAspect > videoAspect) {
    // pillarbox (bars left/right)
    contentH = wrapH
    contentW = wrapH * videoAspect
    offsetX = (wrapW - contentW) / 2
    offsetY = 0
  } else {
    // letterbox (bars top/bottom)
    contentW = wrapW
    contentH = wrapW / videoAspect
    offsetX = 0
    offsetY = (wrapH - contentH) / 2
  }

  return { offsetX, offsetY, contentW, contentH, wrapW, wrapH }
}

/** Client pointer → normalized camera coords (0–1 in video image space). */
export function clientToVideoNorm(
  clientX: number,
  clientY: number,
  wrapRect: DOMRect,
  box: ContentBox,
): { x: number; y: number } | null {
  if (box.contentW < 1 || box.contentH < 1) return null
  const x = (clientX - wrapRect.left - box.offsetX) / box.contentW
  const y = (clientY - wrapRect.top - box.offsetY) / box.contentH
  if (x < -0.02 || y < -0.02 || x > 1.02 || y > 1.02) return null
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  }
}

/** Normalized camera → wrap-local CSS pixels for overlay drawing. */
export function videoNormToWrap(nx: number, ny: number, box: ContentBox) {
  return {
    x: box.offsetX + nx * box.contentW,
    y: box.offsetY + ny * box.contentH,
  }
}
