import type { Rect } from "@seelen-ui/lib/types";
import { getDockOverlapRect } from "../domain/geometry.ts";
import { settingsState } from "./settings.svelte.ts";
import { systemState } from "./system.svelte.ts";

let overlapRect = $state<Rect | null>(null);

class DockGeometry {
  get overlapRect(): Rect | null {
    return overlapRect;
  }
}

export const dockGeometry = new DockGeometry();

/** Attachment dependencies also refresh the measurement after monitor/edge changes. */
export function observeDockGeometry(element: HTMLElement): () => void {
  const { hitboxRect, webviewRect } = settingsState.widgetRect;
  const position = settingsState.position;
  const scaleFactor = systemState.currentMonitor.scaleFactor;

  const measure = () => {
    overlapRect = getDockOverlapRect(
      element.getBoundingClientRect(),
      hitboxRect,
      webviewRect,
      position,
      scaleFactor,
    );
  };

  const observer = new ResizeObserver(measure);
  observer.observe(element, { box: "border-box" });
  observer.observe(document.documentElement);
  measure();

  return () => {
    observer.disconnect();
    overlapRect = null;
  };
}
