import { Widget } from "@seelen-ui/lib";
import type { PhysicalMonitor } from "@seelen-ui/lib/types";
import { globalState } from "./mod.svelte";
import { StartDisplayMode } from "../constants";
import { tick } from "svelte";

let desiredPosition = $state<{ x: number; y: number } | null>(null);
let placement: Promise<void> = Promise.resolve();
let triggerVersion = 0;

export function cancelPendingOpen() {
  triggerVersion++;
}

// Monitor under the cursor position that triggered the menu, falling back to primary
let monitorToShow = $derived.by(() => {
  const pos = desiredPosition;
  let targetMonitor: PhysicalMonitor | undefined;

  if (pos) {
    targetMonitor = globalState.monitors.find(
      (m) =>
        m.rect.left <= pos.x &&
        pos.x < m.rect.right &&
        m.rect.top <= pos.y &&
        pos.y < m.rect.bottom,
    );
  }

  // Fallback to primary monitor if not found or not specified
  if (!targetMonitor) {
    targetMonitor = globalState.monitors.find((m) => m.isPrimary) || globalState.monitors[0];
  }

  return targetMonitor;
});

async function placeCenteredToMonitor(targetMonitor: PhysicalMonitor): Promise<void> {
  const widget = Widget.getCurrent();
  const monitorWidth = targetMonitor.rect.right - targetMonitor.rect.left;
  const monitorHeight = targetMonitor.rect.bottom - targetMonitor.rect.top;

  // globalState.displayMode === StartDisplayMode.Fullscreen
  let x = targetMonitor.rect.left;
  let y = targetMonitor.rect.top;
  let width = monitorWidth;
  let height = monitorHeight;

  if (globalState.displayMode === StartDisplayMode.Normal) {
    width = Math.min(monitorWidth * 0.55, 1200 * targetMonitor.scaleFactor);
    height = Math.min(monitorHeight * 0.55, 1200 * targetMonitor.scaleFactor);

    const monitorCenterX = targetMonitor.rect.left + monitorWidth / 2;
    const monitorCenterY = targetMonitor.rect.top + monitorHeight / 2;

    x = monitorCenterX - width / 2;
    y = monitorCenterY - height / 2;
  }

  await widget.setPosition({
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
  });
}

$effect.root(() => {
  $effect(() => {
    globalState.displayMode;
    if (monitorToShow) {
      placement = placeCenteredToMonitor(monitorToShow);
      placement.catch((error) => console.error("Failed to position app menu:", error));
    }
  });
});

export async function onTriggered(
  cursorPosition?: { x: number; y: number } | null,
  beforeShow?: () => void,
) {
  const version = ++triggerVersion;
  desiredPosition = cursorPosition ?? null;

  globalState.view = globalState.defaultView;
  globalState.version++; // trigger reactive updates

  // Let the placement effect consume the new monitor before exposing the window.
  await tick();
  await placement;
  if (version !== triggerVersion) return;
  beforeShow?.();
  await Widget.self.show();
  if (version === triggerVersion) await Widget.self.focus();
}
