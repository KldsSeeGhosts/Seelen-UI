import { invoke, SeelenCommand, SeelenEvent, subscribe, Widget } from "@seelen-ui/lib";
import { type Rect, SeelenWegSide, type UserAppWindow, ZOrder } from "@seelen-ui/lib/types";
import { lazyRune } from "libs/ui/svelte/utils";

/** Time the pointer can stay out of the item and the preview before the preview closes. */
const CLOSE_DELAY_MS = 300;

const interactables = lazyRune<UserAppWindow[]>(() => invoke(SeelenCommand.GetUserAppWindows));
await subscribe(SeelenEvent.UserAppWindowsChanged, interactables.setByPayload);

const previews = lazyRune<Record<number, { data: string }>>(() => invoke(SeelenCommand.GetUserAppWindowsPreviews));
const previewSubscription = subscribe(SeelenEvent.UserAppWindowsPreviewsChanged, previews.setByPayload);

await interactables.init();
previewSubscription.then(() => previews.init()).catch((error) => {
  console.error("Failed to load dock thumbnails:", error);
});

let hwnds = $state<number[]>([]);
let position = $state<SeelenWegSide>(SeelenWegSide.Bottom);

// The preview is never focused (it would take the focus from the app being used), so it can't
// rely on losing focus to close. It closes when the pointer leaves both the item that opened it
// and the preview itself, or when the focused window changes.
let anchor: Rect | null = null;
let dockRect: Rect | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let stopWatchingPointer: (() => void) | null = null;
let openVersion = 0;
let opening = false;

const overlays = lazyRune(() => invoke(SeelenCommand.GetUserAppOverlays));
const overlaySubscription = subscribe(SeelenEvent.UserAppOverlaysChanged, ({ payload }) => {
  overlays.value = payload;
  if ((opening || Widget.self.isVisible) && hasOverlayConflict()) close();
});
overlaySubscription.catch((error) => console.error("Failed to watch dock preview overlays:", error));

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function hasOverlayConflict(): boolean {
  if (!overlays.isInitialized()) return false;
  return overlays.value.some(({ rect }) =>
    (dockRect !== null && intersects(rect, dockRect)) ||
    (anchor !== null && intersects(rect, anchor)) ||
    (Widget.self.isVisible && intersects(rect, Widget.self.rect))
  );
}

function isPointerInside(x: number, y: number): boolean {
  const preview = Widget.self.rect;
  const left = Math.min(preview.left, anchor?.left ?? preview.left);
  const top = Math.min(preview.top, anchor?.top ?? preview.top);
  const right = Math.max(preview.right, anchor?.right ?? preview.right);
  const bottom = Math.max(preview.bottom, anchor?.bottom ?? preview.bottom);
  // the box spans the gap between the item and the preview, so crossing it keeps the preview open
  return x >= left && x < right && y >= top && y < bottom;
}

function cancelClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function stopPreviewWork() {
  openVersion++;
  opening = false;
  cancelClose();
  stopWatchingPointer?.();
  stopWatchingPointer = null;
  anchor = null;
  dockRect = null;
}

function close() {
  stopPreviewWork();
  Widget.self.hide();
}
Widget.self.onVisibilityChanged((visible) => {
  if (!visible && !opening) stopPreviewWork();
});

async function checkCurrentPointer(version: number) {
  try {
    const [x, y] = await invoke(SeelenCommand.GetMousePosition);
    if (version !== openVersion || !Widget.self.isVisible) return;
    if (isPointerInside(x, y)) {
      cancelClose();
    } else if (!closeTimer) {
      closeTimer = setTimeout(close, CLOSE_DELAY_MS);
    }
  } catch (error) {
    console.error("Failed to read dock preview pointer:", error);
  }
}

function watchPointer() {
  if (stopWatchingPointer) return;

  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  stopWatchingPointer = () => {
    stopped = true;
    unsubscribe?.();
  };

  subscribe(SeelenEvent.GlobalMouseMove, ({ payload: [x, y] }) => {
    if (isPointerInside(x, y)) {
      cancelClose();
    } else if (!closeTimer) {
      closeTimer = setTimeout(close, CLOSE_DELAY_MS);
    }
  }).then((unsub) => {
    if (stopped) unsub();
    else unsubscribe = unsub;
  }).catch((error) => {
    stopWatchingPointer = null;
    console.error("Failed to watch dock preview pointer:", error);
  });
}

Widget.self.onTrigger(async ({ desiredPosition, alignX, alignY, customArgs }) => {
  if (customArgs?.cancelPending === true) {
    if (opening) {
      openVersion++;
      opening = false;
    }
    if (!Widget.self.isVisible) close();
    else {
      watchPointer();
      checkCurrentPointer(openVersion);
    }
    return;
  }
  const version = ++openVersion;
  opening = true;
  hwnds = (customArgs?.hwnds as number[]) ?? [];
  position = (customArgs?.position as SeelenWegSide) ?? SeelenWegSide.Bottom;
  anchor = (customArgs?.anchor as Rect) ?? null;
  dockRect = (customArgs?.dockRect as Rect) ?? null;
  cancelClose();

  try {
    await overlaySubscription;
    await overlays.init();
    if (version !== openVersion) return;
    if (hasOverlayConflict()) {
      close();
      return;
    }
    if (desiredPosition) {
      await Widget.self.adjustAndSetPosition(desiredPosition.x, desiredPosition.y, alignX, alignY);
    }
    if (version !== openVersion) return;
    await invoke(SeelenCommand.SetSelfZOrder, { zOrder: ZOrder.Top });
    if (version !== openVersion) return;
    await Widget.self.show();
    if (version !== openVersion) return;
    // Keep the corrective sizing pass for content/DPI changes during placement.
    await Widget.self.executeAutoSize();
    if (version !== openVersion) return;
    watchPointer();
    checkCurrentPointer(version);
  } catch (error) {
    if (version === openVersion) close();
    console.error("Failed to prepare dock preview:", error);
  } finally {
    if (version === openVersion) opening = false;
  }
});

subscribe(SeelenEvent.GlobalFocusChanged, () => {
  if (opening || stopWatchingPointer) close();
});

const currentInteractables = $derived(interactables.value?.filter((w) => hwnds.includes(w.hwnd)) ?? []);

class PreviewState {
  get currentInteractables() {
    return currentInteractables;
  }

  get previews(): typeof previews.value {
    return previews.isInitialized() ? previews.value : {};
  }

  get position() {
    return position;
  }

  close() {
    close();
  }
}

export const previewState = new PreviewState();
