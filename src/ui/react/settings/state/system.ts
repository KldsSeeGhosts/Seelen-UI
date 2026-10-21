import { lazySignal } from "libs/ui/react/utils/LazySignal";
import { invoke, SeelenCommand, SeelenEvent, subscribe, UIColors } from "@seelen-ui/lib";
import { effect, signal } from "@preact/signals";

export const uiColors = lazySignal(() => invoke(SeelenCommand.SystemGetColors));
const colorsSubscribed = subscribe(SeelenEvent.ColorsChanged, uiColors.setByPayload);

export const monitors = lazySignal(() => invoke(SeelenCommand.SystemGetMonitors));
const monitorsSubscribed = subscribe(SeelenEvent.SystemMonitorsChanged, monitors.setByPayload);
const [, , initialAutoStart] = await Promise.all([
  colorsSubscribed.then(() => uiColors.init()),
  monitorsSubscribed.then(() => monitors.init()),
  invoke(SeelenCommand.GetAutoStartStatus),
]);

effect(() => {
  new UIColors(uiColors.value).setAsCssVariables();
});

export const autostart = signal(initialAutoStart);
export async function setAutoStart(enabled: boolean) {
  await invoke(SeelenCommand.SetAutoStart, { enabled });
  autostart.value = enabled;
}
