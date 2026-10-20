import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import { type Hotspot, RadioDeviceKind, type WlanBssEntry } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import { lazyRune } from "libs/ui/svelte/utils/LazyRune.svelte.ts";

let widget = Widget.getCurrent();

const settings = lazyRune(() => Settings.getAsync());
Settings.onChange((s) => (settings.value = s));
await settings.init();

const isDevtoolsEnabled = $derived(settings.value.devTools);

$effect.root(() => {
  $effect(() => {
    locale.set(settings.value.language);
  });
});

let wlanBssEntries = $state<WlanBssEntry[]>([]);
subscribe(SeelenEvent.NetworkWlanScanned, ({ payload }) => {
  wlanBssEntries = payload;
});

let radios = lazyRune(() => invoke(SeelenCommand.GetRadios));
subscribe(SeelenEvent.RadiosChanged, radios.setByPayload);
await radios.init();

let hotspot = lazyRune(() => invoke(SeelenCommand.GetNetworkHotspot));
subscribe(SeelenEvent.NetworkHotspotChanged, hotspot.setByPayload);
await hotspot.init();

/** Delay between WLAN scans while the popup is focused. */
const SCAN_INTERVAL_MS = 2000;

let isScanning = $state(false);
let selectedSsid = $state<string | null>(null);
let currentView = $state<"main" | "hotspot">("main");

// A scan can take longer than the interval, so only one can be in flight at a time.
let isScanInFlight = false;

async function requestScan() {
  if (isScanInFlight) {
    return;
  }

  isScanInFlight = true;
  try {
    await invoke(SeelenCommand.WlanScan);
  } catch (error) {
    console.error("Failed to scan for WLAN networks:", error);
  } finally {
    isScanInFlight = false;
  }
}

widget.window.onFocusChanged((e) => {
  if (e.payload) {
    isScanning = true;
  } else {
    isScanning = false;
    selectedSsid = null;
    currentView = "main";
  }
});

$effect.root(() => {
  $effect(() => {
    const wifiEnabled = radios.value.some(
      (radio) => radio.kind === RadioDeviceKind.WiFi && radio.isEnabled,
    );

    if (!isScanning || !wifiEnabled) {
      return;
    }

    requestScan();
    const interval = setInterval(requestScan, SCAN_INTERVAL_MS);
    return () => clearInterval(interval);
  });
});

class State {
  get wifiRadio() {
    return radios.value.find((radio) => radio.kind === RadioDeviceKind.WiFi);
  }

  get wlanBssEntries() {
    return wlanBssEntries;
  }

  get hotspot(): Hotspot | null {
    return hotspot.value;
  }

  get view() {
    return currentView;
  }

  set view(value: "main" | "hotspot") {
    currentView = value;
  }

  get isScanning() {
    return isScanning;
  }

  set isScanning(value: boolean) {
    isScanning = value;
  }

  get selectedSsid() {
    return selectedSsid;
  }

  set selectedSsid(value: string | null) {
    selectedSsid = value;
  }

  get isDevtoolsEnabled() {
    return isDevtoolsEnabled;
  }
}

export const globalState = new State();
