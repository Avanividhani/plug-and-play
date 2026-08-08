"""
Manual 4-corner projector calibration (no camera path).

This module is intentionally isolated from gray-code/camera calibration.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import cv2
import numpy as np


Point2 = Sequence[float]


@dataclass
class ManualCalibration:
    projector_id: int
    homography: np.ndarray
    content_corners: np.ndarray
    dragged_corners: np.ndarray


def compute_manual_homography(
    content_corners: Iterable[Point2],
    dragged_corners: Iterable[Point2],
) -> np.ndarray:
    """
    content_corners: source content rectangle corners, e.g. [[0,0],[w,0],[w,h],[0,h]]
    dragged_corners: corresponding destination corners in projector pixel coordinates
    """
    src = np.array(list(content_corners), dtype=np.float32)
    dst = np.array(list(dragged_corners), dtype=np.float32)
    if src.shape != (4, 2) or dst.shape != (4, 2):
        raise ValueError("compute_manual_homography expects exactly 4 source and 4 destination points")
    return cv2.getPerspectiveTransform(src, dst)


def save_manual_projector_calibration(
    projector_id: int,
    content_corners: Iterable[Point2],
    dragged_corners: Iterable[Point2],
) -> ManualCalibration:
    """
    Storage adapter hook for manual calibrations.
    The caller is responsible for persisting this dataclass to disk/db.
    """
    src = np.array(list(content_corners), dtype=np.float32)
    dst = np.array(list(dragged_corners), dtype=np.float32)
    H = compute_manual_homography(src, dst)
    return ManualCalibration(
        projector_id=projector_id,
        homography=H,
        content_corners=src,
        dragged_corners=dst,
    )

