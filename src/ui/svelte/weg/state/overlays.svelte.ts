import type { Rect } from "@seelen-ui/lib/types";
import { overlaySnapshot } from "./getters.svelte.ts";
import { settingsState } from "./settings.svelte.ts";
import { systemState } from "./system.svelte.ts";

/** A fullscreen window can be inset by its frame after DWM bounds are subtracted. */
const COVER_TOLERANCE = 2;

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

/**
 * Windows that are not in the normal task list but are visible over this dock or over
 * the whole monitor (capture/recording controls, non-activating transcription
 * overlays). Seelen's own menus and previews are filtered out natively.
 */
const _overlaysOnDock = $derived.by(() => {
  const hitbox = settingsState.widgetRect.hitboxRect;
  return overlaySnapshot.value.filter((overlay) => rectanglesIntersect(hitbox, overlay.rect));
});

const _overlayCoversScreen = $derived.by(() => {
  const monitor = systemState.currentMonitor.rect;
  return overlaySnapshot.value.some((overlay) => rectangleCovers(overlay.rect, monitor));
});

class OverlayState {
  /** A visible foreign overlay intersects the dock hitbox. */
  get overlapsDock(): boolean {
    return _overlaysOnDock.length > 0;
  }

  /** A visible foreign overlay covers this monitor. */
  get coversScreen(): boolean {
    return _overlayCoversScreen;
  }
}

export const overlayState = new OverlayState();
