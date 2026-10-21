import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { Settings as SettingsType, SysTrayIcon } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import { AsyncSection, type AsyncSectionStatus } from "libs/ui/svelte/utils/AsyncSection.svelte.ts";

export type { AsyncSectionStatus };

/** Icons of the shell itself: they belong to the toolbar and not to the tray overflow. */
const GUIDS_TO_IGNORE = [
  "7820ae73-23e3-4229-82c1-e41cb67d5b9c", // speaker volume icon
  "7820ae74-23e3-4229-82c1-e41cb67d5b9c", // network icon
  "7820ae75-23e3-4229-82c1-e41cb67d5b9c", // battery icon
];

const NO_ICONS: SysTrayIcon[] = [];

/** Time the native order is given to be reflected before falling back to the live list. */
const ORDER_CONFIRM_TIMEOUT_MS = 2_000;

const tray = new AsyncSection(
  "system tray icons",
  () => invoke(SeelenCommand.GetSystemTrayIcons),
  (apply) => subscribe(SeelenEvent.SystemTrayChanged, ({ payload }) => apply(payload)),
);

let language: string | undefined;

function applyLanguage(value: string | undefined): void {
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`system-tray: failed to load the "${value}" translations`, error);
  });
}

/** Settings are only used to resolve the language, so they must never gate the tray shell. */
async function initSettings(): Promise<void> {
  try {
    // Awaiting the acknowledgement guarantees that the initial snapshot cannot override a newer event.
    await Settings.onChange((settings: SettingsType) => applyLanguage(settings.language));
    const settings = await Settings.getAsync();
    if (!language) {
      applyLanguage(settings.language);
    }
  } catch (error) {
    console.error("system-tray: failed to load settings", error);
  }
}

const items = $derived(
  (tray.value ?? NO_ICONS).filter(
    (item) => item.isVisible && (!item.guid || !GUIDS_TO_IGNORE.includes(item.guid)),
  ),
);

let dragging = $state(false);
/** Rendered order: the live icons while idle, the dragged order while the user drags. */
let order = $state.raw<SysTrayIcon[]>([]);
/** Order requested from the native tray, kept until the live list reflects it. */
let pendingOrder: string[] | null = null;
let orderWatchdog: ReturnType<typeof setTimeout> | null = null;

function keysOf(list: SysTrayIcon[]): string[] {
  return list.map((item) => item.registryKey);
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function clearOrderWatchdog(): void {
  if (orderWatchdog !== null) {
    clearTimeout(orderWatchdog);
    orderWatchdog = null;
  }
}

$effect.root(() => {
  $effect(() => {
    const live = items;
    if (dragging) {
      // Replacing the rendered order mid-drag would cancel it, so updates wait for the drop.
      return;
    }
    if (pendingOrder) {
      if (!sameOrder(keysOf(live), pendingOrder)) {
        return; // wait for the requested order to come back from the native tray
      }
      pendingOrder = null;
      clearOrderWatchdog();
    }
    order = live;
  });
});

class State {
  get items(): SysTrayIcon[] {
    return items;
  }

  /** Icons as currently displayed; the dragged order while a drag is in progress. */
  get order(): SysTrayIcon[] {
    return order;
  }

  get status(): AsyncSectionStatus {
    return tray.state;
  }

  get dragging(): boolean {
    return dragging;
  }

  retry(): void {
    void tray.load();
  }

  beginDrag(): void {
    dragging = true;
    order = items;
  }

  previewDrag(next: SysTrayIcon[]): void {
    order = next;
  }

  /** Applies the list that was deferred during the drag, then stores the resulting order. */
  endDrag(canceled: boolean): void {
    const byKey = new Map(items.map((item) => [item.registryKey, item]));
    const retained = order.flatMap((item) => byKey.has(item.registryKey) ? [byKey.get(item.registryKey)!] : []);
    const retainedKeys = new Set(keysOf(retained));
    order = [...retained, ...items.filter((item) => !retainedKeys.has(item.registryKey))];
    const draggedOrder = keysOf(order);
    dragging = false;

    if (canceled || sameOrder(draggedOrder, keysOf(items))) {
      pendingOrder = null;
      clearOrderWatchdog();
      order = items;
      return;
    }

    pendingOrder = draggedOrder;
    clearOrderWatchdog();
    orderWatchdog = setTimeout(() => {
      orderWatchdog = null;
      pendingOrder = null;
      order = items;
    }, ORDER_CONFIRM_TIMEOUT_MS);

    invoke(SeelenCommand.SetSystemTrayIconsOrder, { keys: draggedOrder }).catch((error) => {
      console.error("system-tray: failed to save the icon order", error);
      if (pendingOrder && sameOrder(pendingOrder, draggedOrder)) {
        pendingOrder = null;
        clearOrderWatchdog();
        order = items; // show the real order again
      }
    });
  }
}

export const state = new State();

void initSettings();

let started = false;
function startLoading(): void {
  if (started) {
    return;
  }
  started = true;
  void tray.load();
}

Widget.self.onVisibilityChanged((visible) => {
  if (visible) {
    startLoading();
  } else if (dragging) {
    state.endDrag(true);
  }
});
if (Widget.self.isVisible) {
  startLoading();
}
