import { invoke, SeelenCommand, SeelenEvent, subscribe, Widget } from "@seelen-ui/lib";
import { type Rect, SeelenWegSide, type UserAppWindow, ZOrder } from "@seelen-ui/lib/types";
import { lazyRune } from "libs/ui/svelte/utils";

/** Time the pointer can stay out of the item and the preview before the preview closes. */
const CLOSE_DELAY_MS = 300;

const interactables = lazyRune<UserAppWindow[]>(() => invoke(SeelenCommand.GetUserAppWindows));
subscribe(SeelenEvent.UserAppWindowsChanged, interactables.setByPayload);

const previews = lazyRune<Record<number, { data: string }>>(() => invoke(SeelenCommand.GetUserAppWindowsPreviews));
subscribe(SeelenEvent.UserAppWindowsPreviewsChanged, previews.setByPayload);

await Promise.all([interactables.init(), previews.init()]);

let hwnds = $state<number[]>([]);
let position = $state<SeelenWegSide>(SeelenWegSide.Bottom);

// The preview is never focused (it would take the focus from the app being used), so it can't
// rely on losing focus to close. It closes when the pointer leaves both the item that opened it
// and the preview itself, or when the focused window changes.
let anchor: Rect | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let stopWatchingPointer: (() => void) | null = null;

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

function close() {
  cancelClose();
  stopWatchingPointer?.();
  stopWatchingPointer = null;
  anchor = null;
  Widget.self.hide();
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
  });
}

Widget.self.onTrigger(async ({ desiredPosition, alignX, alignY, customArgs }) => {
  hwnds = (customArgs?.hwnds as number[]) ?? [];
  position = (customArgs?.position as SeelenWegSide) ?? SeelenWegSide.Bottom;
  anchor = (customArgs?.anchor as Rect) ?? null;
  cancelClose();

  if (desiredPosition) {
    await Widget.self.adjustAndSetPosition(desiredPosition.x, desiredPosition.y, alignX, alignY);
  }
  await Widget.self.show();
  invoke(SeelenCommand.SetSelfZOrder, { zOrder: ZOrder.Top });
  // the content may have changed size after the position was computed
  await Widget.self.executeAutoSize();
  watchPointer();
});

subscribe(SeelenEvent.GlobalFocusChanged, () => {
  if (stopWatchingPointer) close();
});

const currentInteractables = $derived(interactables.value?.filter((w) => hwnds.includes(w.hwnd)) ?? []);

class PreviewState {
  get currentInteractables() {
    return currentInteractables;
  }

  get previews() {
    return previews;
  }

  get position() {
    return position;
  }

  close() {
    close();
  }
}

export const previewState = new PreviewState();
