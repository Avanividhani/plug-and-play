import { computeHomography, type Homography, type Point } from './calibration'

export type ManualCalibrationRecord = {
  projectorId: number
  projectorIndex: number
  sourceCorners: Point[]
  draggedCornersPx: Point[]
  outputSize: { width: number; height: number }
  homography: Homography
  inverseHomography: Homography
  type: 'manual'
  updatedAt: number
}

const STORAGE_KEY = 'pnp-manual-projector-calibrations-v1'

function readAll(): Record<string, ManualCalibrationRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, ManualCalibrationRecord>
    return parsed || {}
  } catch {
    return {}
  }
}

function writeAll(next: Record<string, ManualCalibrationRecord>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore storage failures in demo mode
  }
}

export function computeManualHomography(
  contentCorners: Point[],
  draggedCorners: Point[],
): { homography: Homography; inverseHomography: Homography } {
  const homography = computeHomography(contentCorners, draggedCorners)
  const inverseHomography = computeHomography(draggedCorners, contentCorners)
  return { homography, inverseHomography }
}

export function save_manual_projector_calibration(
  projectorId: number,
  projectorIndex: number,
  outputSize: { width: number; height: number },
  draggedCornersPx: Point[],
): ManualCalibrationRecord {
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: outputSize.width, y: 0 },
    { x: outputSize.width, y: outputSize.height },
    { x: 0, y: outputSize.height },
  ]
  const { homography, inverseHomography } = computeManualHomography(src, draggedCornersPx)
  const rec: ManualCalibrationRecord = {
    projectorId,
    projectorIndex,
    sourceCorners: src,
    draggedCornersPx: draggedCornersPx.map((p) => ({ x: p.x, y: p.y })),
    outputSize: { ...outputSize },
    homography,
    inverseHomography,
    type: 'manual',
    updatedAt: Date.now(),
  }
  const all = readAll()
  all[String(projectorId)] = rec
  writeAll(all)
  return rec
}

export function loadManualProjectorCalibration(
  projectorId: number,
): ManualCalibrationRecord | null {
  const all = readAll()
  return all[String(projectorId)] ?? null
}

/**
 * Shared lookup-by-projector-id that can be extended with other calibration types.
 * This adds "manual" alongside existing mechanisms without mutating their format.
 */
export function loadCalibrationForProjector(
  projectorId: number,
): { type: 'manual'; record: ManualCalibrationRecord } | null {
  const manual = loadManualProjectorCalibration(projectorId)
  if (manual) return { type: 'manual', record: manual }
  return null
}

