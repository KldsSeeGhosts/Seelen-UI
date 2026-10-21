import { getRootContainer } from "libs/ui/react/utils/index.ts";
import { mount } from "svelte";
import App from "./App.svelte";
import { Widget } from "@seelen-ui/lib";
import { cancelPendingOpen, onTriggered } from "./state/positioning.svelte.ts";

import "@seelen-ui/lib/styles/reset.css";

const widget = Widget.getCurrent();

await widget.init({ hideOnFocusLoss: true });
await widget.window.setFocusable(true);

let requestedOpen = false;
let preparingOpen = false;
let triggerVersion = 0;
widget.onVisibilityChanged((visible) => {
  // A prior hide may finish while the next opening is still waiting for placement.
  if (!visible && preparingOpen) return;
  requestedOpen = visible;
  if (!visible) cancelPendingOpen();
});

widget.onTrigger(async (args) => {
  const version = ++triggerVersion;
  requestedOpen = !requestedOpen;
  if (!requestedOpen) {
    preparingOpen = false;
    cancelPendingOpen();
    await widget.hide();
  } else {
    preparingOpen = true;
    try {
      await onTriggered(args.desiredPosition, () => {
        if (version === triggerVersion) preparingOpen = false;
      });
    } catch (error) {
      if (version === triggerVersion) requestedOpen = widget.isVisible;
      console.error("Failed to open app menu:", error);
    } finally {
      if (version === triggerVersion) preparingOpen = false;
    }
  }
});

mount(App, {
  target: getRootContainer(),
});
