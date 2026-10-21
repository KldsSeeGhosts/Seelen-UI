import { overlaySnapshot } from "./getters.svelte.ts";
import { dockGeometry } from "./geometry.svelte.ts";
import { systemState } from "./system.svelte.ts";
import { rectangleCovers, rectanglesIntersect } from "../domain/geometry.ts";

/**
 * Windows that are not in the normal task list but are visible over this dock or over
 * the whole monitor (capture/recording controls, non-activating transcription
 * overlays). Seelen's own menus and previews are filtered out natively.
 */
const _overlaysOnDock = $derived.by(() => {
  const hitbox = dockGeometry.overlapRect;
  return hitbox ? overlaySnapshot.value.filter((overlay) => rectanglesIntersect(hitbox, overlay.rect)) : [];
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
