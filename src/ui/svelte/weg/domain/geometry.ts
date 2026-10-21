import type { Rect, SeelenWegSide } from "@seelen-ui/lib/types";

/** A fullscreen window can be inset by its frame after DWM bounds are subtracted. */
const COVER_TOLERANCE = 2;

/**
 * Use the rendered dock's length, not the shell's full-edge reservation, for
 * collisions. Keep the edge strip's depth stable while auto-hide translates the
 * dock offscreen, so an overlapping window cannot trigger a hide/show loop.
 */
export function getDockOverlapRect(
  bounds: Rect,
  hitboxRect: Rect,
  webviewRect: Rect,
  position: SeelenWegSide,
  scaleFactor: number,
): Rect | null {
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;

  const rect = { ...hitboxRect };
  if (position === "Top" || position === "Bottom") {
    rect.left = Math.max(rect.left, webviewRect.left + Math.floor(bounds.left * scaleFactor));
    rect.right = Math.min(rect.right, webviewRect.left + Math.ceil(bounds.right * scaleFactor));
  } else {
    rect.top = Math.max(rect.top, webviewRect.top + Math.floor(bounds.top * scaleFactor));
    rect.bottom = Math.min(rect.bottom, webviewRect.top + Math.ceil(bounds.bottom * scaleFactor));
  }
  return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
}

export function rectanglesIntersect(a: Rect, b: Rect): boolean {
  return a.left < a.right && a.top < a.bottom && b.left < b.right && b.top < b.bottom &&
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function rectangleCovers(inner: Rect, outer: Rect): boolean {
  return inner.left <= outer.left + COVER_TOLERANCE &&
    inner.top <= outer.top + COVER_TOLERANCE &&
    inner.right >= outer.right - COVER_TOLERANCE &&
    inner.bottom >= outer.bottom - COVER_TOLERANCE;
}
