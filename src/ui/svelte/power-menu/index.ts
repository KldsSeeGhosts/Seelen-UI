import { getRootContainer } from "libs/ui/react/utils/index.ts";
import { mount } from "svelte";
import App from "./app.svelte";
import { Widget } from "@seelen-ui/lib";

import "@seelen-ui/lib/styles/reset.css";

const widget = Widget.getCurrent();
await widget.init({ normalizeDevicePixelRatio: true, hideOnFocusLoss: true });
await widget.window.setResizable(false);
// The menu owns Escape and dismisses itself on focus loss, so its window must accept focus.
await widget.window.setFocusable(true);

mount(App, {
  target: getRootContainer(),
});
