import {
  applyHomography,
  captureFrame,
  computeHomography,
  detectBrightMarkers,
  type Homography,
} from './calibration'
import type { NormPoint } from './surfaceDetect'
import { selectionToProjectorQuad } from './seeMatch'

export const ALIGN_MARGIN = 0.08

export type CamProjAlign = {
  camToProj: Homography
  projToCam: Homography
  camMarkers: NormPoint[]
  projMarkers: NormPoint[]
  rms: number
  at: number
}

export function projectorAlignMarkers(margin = ALIGN_MARGIN): NormPoint[] {
  return [
    { x: margin, y: margin },
    { x: 1 - margin, y: margin },
    { x: 1 - margin, y: 1 - margin },
    { x: margin, y: 1 - margin },
  ]
}

export function solveCamProjAlign(video: HTMLVideoElement): CamProjAlign {
  const frame = captureFrame(video)
  const found = detectBrightMarkers(frame, 4)
  if (found.length < 4) {
    throw new Error(
      'Could not see the projector markers in the camera. Dim the lights, aim the Logitech at the projected surface, retry.',
    )
  }

  const camMarkers: NormPoint[] = found.map((p) => ({
    x: p.x / frame.width,
    y: p.y / frame.height,
  }))
  const projMarkers = projectorAlignMarkers()

  const camToProj = computeHomography(camMarkers, projMarkers)
  const projToCam = computeHomography(projMarkers, camMarkers)

  let err = 0
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(camToProj, camMarkers[i])
    err += (p.x - projMarkers[i].x) ** 2 + (p.y - projMarkers[i].y) ** 2
  }

  return {
    camToProj,
    projToCam,
    camMarkers,
    projMarkers,
    rms: Math.sqrt(err / 4),
    at: Date.now(),
  }
}

/** Map user camera selection → projector points via Match homography. */
export function cameraCornersToProjector(
  corners: NormPoint[],
  align: CamProjAlign | null,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): NormPoint[] {
  return selectionToProjectorQuad(corners, align, offset)
}
