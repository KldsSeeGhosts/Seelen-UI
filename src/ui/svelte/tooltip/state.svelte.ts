import { invoke, SeelenCommand, SeelenEvent, subscribe, Widget } from "@seelen-ui/lib";
import { ZOrder } from "@seelen-ui/lib/types";
import { tick } from "svelte";

let tooltipText = $state<string | null>(null);
/** The native window is only shown once the final text has been measured and positioned. */
let visible = $state(false);
/**
 * Incremented by every trigger and hide. Each awaiting step checks it, so a slow trigger can
 * never position or show over a newer one (or over an already requested hide).
 */
let generation = 0;

const showing = $derived(visible && !!tooltipText);

function hide() {
  generation += 1;
  tooltipText = null;
  visible = false;
}

Widget.self.onTrigger(async ({ desiredPosition, alignX, alignY, customArgs }) => {
  const run = ++generation;

  if (!customArgs?.show) {
    tooltipText = null;
    visible = false;
    return;
  }

  const text = String(customArgs?.text ?? "") || null;
  if (!text) {
    tooltipText = null;
    visible = false;
    return;
  }

  // The window is still hidden here. Rendering the final text first makes the autosizer
  // measure the size the tooltip will be shown with, instead of the previous tooltip's.
  tooltipText = text;
  await tick();
  if (run !== generation) {
    return;
  }

  try {
    if (Widget.self.isReady) {
      await Widget.self.executeAutoSize();
      if (run !== generation) {
        return;
      }
    }
  } catch (error) {
    console.error("tooltip: failed to resize to its content", error);
  }

  if (desiredPosition) {
    try {
      await Widget.self.adjustAndSetPosition(desiredPosition.x, desiredPosition.y, alignX, alignY);
    } catch (error) {
      console.error("tooltip: failed to position itself", error);
    }
    if (run !== generation) {
      return;
    }
    invoke(SeelenCommand.SetSelfZOrder, { zOrder: ZOrder.Top }).catch((error) => {
      console.error("tooltip: failed to raise itself", error);
    });
  }

  if (run !== generation) {
    return;
  }
  visible = true;
});

// The widget that triggered the tooltip (dock/toolbar) can lose the mouse
// without ever emitting a hide (e.g. `pointerleave` missed).
// As a safety net, close the tooltip whenever the focused app/window changes —
// that always means the user has moved on, regardless of which window (if any)
// held OS focus before.
let focusedAppHwnd = $state<number | null>(null);
subscribe(SeelenEvent.GlobalFocusChanged, ({ payload: focused }) => {
  focusedAppHwnd = focused.hwnd;
});

$effect.root(() => {
  let initialized = false;
  $effect(() => {
    focusedAppHwnd;
    if (!initialized) {
      initialized = true;
      return;
    }
    hide();
  });

  $effect(() => {
    if (showing) {
      Widget.self.show().catch((error) => console.error("tooltip: failed to show", error));
    } else {
      Widget.self.hide().catch((error) => console.error("tooltip: failed to hide", error));
    }
  });
});

class State {
  get text() {
    return tooltipText;
  }

  get showing() {
    return showing;
  }
}

export const state = new State();
