import { invoke, SeelenCommand } from "@seelen-ui/lib";
import { Alignment, SeelenWegSide, type UserAppWindow, type WidgetId } from "@seelen-ui/lib/types";
import { settingsState } from "./state/settings.svelte.ts";

/** Time the pointer has to rest on an item before its preview opens. */
const HOVER_DELAY_MS = 350;
/** Shorter delay when moving between items while a preview was just open. */
const HOVER_SWITCH_DELAY_MS = 100;
const HOVER_SWITCH_WINDOW_MS = 800;

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let openedByHover = false;
let lastHoverEnd = 0;

/**
 * Opens the preview once the pointer rests on the item. The preview closes itself when the pointer
 * leaves both the item and the preview, so the dock only has to cancel a pending open.
 */
export function scheduleHoverPreview(itemEl: HTMLElement, getWindows: () => UserAppWindow[]) {
  cancelHoverPreview();

  const switching = Date.now() - lastHoverEnd < HOVER_SWITCH_WINDOW_MS;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    const windows = getWindows();
    if (windows.length === 0) return;

    openedByHover = true;
    triggerPreviewWidget(itemEl, windows);
  }, switching ? HOVER_SWITCH_DELAY_MS : HOVER_DELAY_MS);
}

export function cancelHoverPreview() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (openedByHover) {
    openedByHover = false;
    lastHoverEnd = Date.now();
    // Replace a queued cold open without closing a preview the pointer is entering.
    invoke(SeelenCommand.TriggerWidget, {
      payload: {
        id: "@seelen/weg-preview" as WidgetId,
        customArgs: { cancelPending: true },
      },
    }).catch((error) => console.error("Failed to cancel pending dock preview:", error));
  }
}

export function triggerPreviewWidget(itemEl: HTMLElement, windows: UserAppWindow[]) {
  const dockSide = settingsState.position;

  const elRect = itemEl.getBoundingClientRect();
  const viewRect = settingsState.widgetRect.hitboxRect;

  const toPhysical = (n: number) => Math.round(n * globalThis.devicePixelRatio);

  let x: number;
  let y: number;
  let alignX: Alignment;
  let alignY: Alignment;

  switch (dockSide) {
    case SeelenWegSide.Bottom:
      x = viewRect.left + toPhysical(elRect.left + elRect.width / 2);
      y = viewRect.top;
      alignX = Alignment.Center;
      alignY = Alignment.End;
      break;
    case SeelenWegSide.Top:
      x = viewRect.left + toPhysical(elRect.left + elRect.width / 2);
      y = viewRect.bottom;
      alignX = Alignment.Center;
      alignY = Alignment.Start;
      break;
    case SeelenWegSide.Left:
      x = viewRect.right;
      y = viewRect.top + toPhysical(elRect.top + elRect.height / 2);
      alignX = Alignment.Start;
      alignY = Alignment.Center;
      break;
    case SeelenWegSide.Right:
      x = viewRect.left;
      y = viewRect.top + toPhysical(elRect.top + elRect.height / 2);
      alignX = Alignment.End;
      alignY = Alignment.Center;
      break;
  }

  // the item in screen coordinates, so the preview can tell when the pointer left it.
  // CSS coordinates start at the corner of the webview, which is larger than the hitbox.
  const { webviewRect } = settingsState.widgetRect;
  const anchor = {
    left: webviewRect.left + toPhysical(elRect.left),
    top: webviewRect.top + toPhysical(elRect.top),
    right: webviewRect.left + toPhysical(elRect.right),
    bottom: webviewRect.top + toPhysical(elRect.bottom),
  };

  invoke(SeelenCommand.TriggerWidget, {
    payload: {
      id: "@seelen/weg-preview" as WidgetId,
      desiredPosition: { x, y },
      alignX,
      alignY,
      customArgs: {
        hwnds: windows.map((w) => w.hwnd),
        position: dockSide,
        anchor,
        dockRect: viewRect,
      },
    },
  }).catch((error) => console.error("Failed to open dock preview:", error));
}
