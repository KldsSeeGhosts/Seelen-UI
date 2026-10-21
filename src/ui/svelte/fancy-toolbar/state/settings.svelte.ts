import { RuntimeStyleSheet, Widget } from "@seelen-ui/lib";
import {
  Alignment,
  type AppBarEdge,
  type FancyToolbarSettings,
  FancyToolbarSide,
  HideMode,
  type WidgetId,
} from "@seelen-ui/lib/types";
import { isTouchPrimary } from "libs/ui/svelte/utils/signals.svelte.ts";
import { locale } from "../i18n/index.ts";
import { declareDocumentAsLayeredHitbox } from "libs/ui/react/utils/layered.ts";
import { systemState } from "./system.svelte.ts";
import { settings as _settings } from "./getters.svelte.ts";
import { dateState } from "libs/ui/svelte/runes/date.svelte.ts";
import { rootEffectAsync } from "libs/ui/svelte/utils/RootEffect.svelte.ts";
import { appBarState as appBar } from "libs/ui/svelte/utils/AppBar.svelte.ts";

let isWidgetReady = $state(false);
const settings = $derived({
  ..._settings.value.byWidget["@seelen/fancy-toolbar"],
  ..._settings.value.monitorsV3[Widget.self.decoded.monitorId!]?.byWidget["@seelen/fancy-toolbar" as WidgetId],
} as FancyToolbarSettings);

const desiredWidgetRect = $derived.by(() => {
  const { itemSize, margin, padding } = settingsState;
  const height = Math.round(
    (itemSize + padding * 2 + margin * 2) * systemState.currentMonitor.scaleFactor,
  );
  const rect = { ...systemState.currentMonitor.rect };

  if (settingsState.position === FancyToolbarSide.Top) {
    rect.bottom = systemState.currentMonitor.rect.top + height;
  } else if (settingsState.position === FancyToolbarSide.Bottom) {
    rect.top = systemState.currentMonitor.rect.bottom - height;
  }
  return rect;
});

const widgetRect = $derived(
  (settings.hideMode === HideMode.Never || isTouchPrimary.value) && appBar.rect ? appBar.rect : desiredWidgetRect,
);

class SettingsState {
  tooltipY = $derived(
    settingsState.position === FancyToolbarSide.Bottom ? settingsState.widgetRect.top : settingsState.widgetRect.bottom,
  );

  popupAlignY = $derived(
    settingsState.position === FancyToolbarSide.Bottom ? Alignment.End : Alignment.Start,
  );

  get isReady() {
    return isWidgetReady;
  }

  set isReady(v: boolean) {
    isWidgetReady = v;
  }

  get widgetRect() {
    return widgetRect;
  }

  get value() {
    return settings;
  }

  get allByWidget() {
    return _settings.value.byWidget;
  }

  get itemSize(): number {
    return this.value.itemSize;
  }
  get margin(): number {
    return this.value.margin;
  }
  get padding(): number {
    return this.value.padding;
  }
  get position(): FancyToolbarSide {
    return this.value.position;
  }
  get hideMode(): HideMode {
    return this.value.hideMode;
  }
  get delayToHide(): number {
    return this.value.delayToHide;
  }
  get delayToShow(): number {
    return this.value.delayToShow;
  }
}

export const settingsState = new SettingsState();

$effect.root(() => {
  $effect(() => {
    locale.set(_settings.value.language);
    dateState.setLang(_settings.value.language);
    dateState.setFormat(_settings.value.dateFormat);
  });
});

async function updateWidgetPosition() {
  const rect = desiredWidgetRect;
  const isTouch = isTouchPrimary.value;
  const hideMode = settingsState.hideMode;
  const position = settingsState.position;
  const isReady = settingsState.isReady;

  if (!isReady) {
    return;
  }

  await appBar.sync(rect, position as unknown as AppBarEdge, hideMode === HideMode.Never || isTouch);
}

Widget.self.attachPosition();
Widget.self.preReadyTasks.push(rootEffectAsync(updateWidgetPosition));
Widget.self.preReadyTasks.push(rootEffectAsync(() => Widget.self.setPosition(widgetRect)));

$effect.root(() => {
  $effect(() => {
    const { itemSize, margin, padding } = settingsState;
    const sheet = new RuntimeStyleSheet("@config/fancy-toolbar");
    sheet.addVariable("--config-item-size", `${itemSize}px`);
    sheet.addVariable("--config-margin", `${margin}px`);
    sheet.addVariable("--config-padding", `${padding}px`);
    sheet.addVariable("--config-height", `${itemSize + padding * 2 + margin * 2}px`);
    sheet.applyToDocument();
  });

  $effect(() => {
    if (isTouchPrimary.value) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;
    declareDocumentAsLayeredHitbox({
      getPhysicalRect: () => {
        const r = widgetRect;
        return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
      },
    }).then((unlistenFn) => {
      if (disposed) unlistenFn();
      else unlisten = unlistenFn;
    }).catch(console.error);

    return () => {
      disposed = true;
      unlisten?.();
    };
  });
});
