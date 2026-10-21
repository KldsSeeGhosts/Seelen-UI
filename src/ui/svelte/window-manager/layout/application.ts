import { invoke, SeelenCommand } from "@seelen-ui/lib";
import type { Rect } from "@seelen-ui/lib/types";
import { toPhysicalPixels } from "libs/ui/react/utils";
import type { State } from "../state.svelte";

let positioningFrame: number | null = null;
let pendingPositioning: { x: number; y: number; border: number } | null = null;

export function cancelPendingPositioning() {
  if (positioningFrame !== null) {
    cancelAnimationFrame(positioningFrame);
    positioningFrame = null;
  }
  pendingPositioning = null;
}

export function requestPositioningOfLeaves(state: State) {
  if (state.paused) {
    cancelPendingPositioning();
    return;
  }

  // Read reactive inputs in the caller's effect, then measure the latest DOM once per frame.
  const { left: windowX, top: windowY } = state.widgetRect;
  const borderConfig = state.settings.border;
  const border = borderConfig.enabled ? borderConfig.width + borderConfig.offset : 0;
  pendingPositioning = { x: windowX, y: windowY, border };
  if (positioningFrame !== null) return;

  positioningFrame = requestAnimationFrame(() => {
    positioningFrame = null;
    const pending = pendingPositioning;
    pendingPositioning = null;
    if (pending) {
      positionLeaves(pending);
    }
  });
}

function positionLeaves({ x: windowX, y: windowY, border }: { x: number; y: number; border: number }) {
  let elements = document.querySelectorAll("[data-hwnd]");
  let positions: Record<string, Rect> = {};

  elements.forEach((element) => {
    let hwnd = (element as HTMLDivElement).dataset.hwnd!;

    const domRect = element.getBoundingClientRect();
    const top = windowY + toPhysicalPixels(domRect.top + border);
    const left = windowX + toPhysicalPixels(domRect.left + border);

    positions[hwnd] = {
      top,
      left,
      right: left + toPhysicalPixels(domRect.width - border * 2),
      bottom: top + toPhysicalPixels(domRect.height - border * 2),
    };
  });

  invoke(SeelenCommand.SetAppWindowsPositions, { positions }).catch((error) => {
    console.error("Failed to position tiled windows:", error);
  });
}
