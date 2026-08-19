/** Pixel drag length at which a select-tool gesture becomes a box, not a click. */
export const BOX_SELECT_THRESHOLD_PX = 4;

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export interface BoxSelectRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Axis-aligned screen box from drag start to the current pointer, or null if still a click. */
export function boxSelectRect(start: PixelPoint, current: PixelPoint): BoxSelectRect | null {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (Math.hypot(dx, dy) < BOX_SELECT_THRESHOLD_PX) {
    return null;
  }
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    width: Math.abs(dx),
    height: Math.abs(dy),
  };
}
