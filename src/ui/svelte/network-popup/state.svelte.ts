import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { Settings as SettingsType } from "@seelen-ui/lib/types";
import { type Hotspot, type RadioDevice, RadioDeviceKind, type WlanBssEntry } from "@seelen-ui/lib/types";
import { untrack } from "svelte";
import { locale } from "./i18n/index.ts";
import { AsyncActions } from "libs/ui/svelte/utils/AsyncActions.svelte.ts";
import { AsyncSection, type AsyncSectionStatus } from "libs/ui/svelte/utils/AsyncSection.svelte.ts";

export type { AsyncSectionStatus };

/** `scanning` lasts until the first result arrives, so an empty list is never ambiguous. */
export type ScanPhase = "idle" | "scanning" | "ready" | "error";

const NO_RADIOS: RadioDevice[] = [];

/** Delay between WLAN scans while the drawer is focused. */
const SCAN_INTERVAL_MS = 2000;
/** Time given to the first result of a scan before the drawer reports a scan failure. */
const SCAN_START_TIMEOUT_MS = 8_000;

const widget = Widget.getCurrent();
const actions = new AsyncActions();

let language: string | undefined;
/** Only used by the developer details of a network entry. */
let devtoolsEnabled = $state(false);
let settingsRevision = 0;

function applySettings(settings: SettingsType): void {
  settingsRevision++;
  devtoolsEnabled = settings.devTools;
  const value = settings.language;
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`network-popup: failed to load the "${value}" translations`, error);
  });
}

/** Settings are only used for the language and the developer details, so they never gate the shell. */
async function initSettings(): Promise<void> {
  try {
    // Awaiting the acknowledgement guarantees that the initial snapshot cannot override a newer event.
    await Settings.onChange((settings) => applySettings(settings));
    const revision = settingsRevision;
    const settings = await Settings.getAsync();
    if (revision === settingsRevision) applySettings(settings);
  } catch (error) {
    console.error("network-popup: failed to load settings", error);
  }
}

const radios = new AsyncSection(
  "network radios",
  () => invoke(SeelenCommand.GetRadios),
  (apply) => subscribe(SeelenEvent.RadiosChanged, ({ payload }) => apply(payload)),
);

const hotspot = new AsyncSection<Hotspot | null>(
  "network hotspot",
  () => invoke(SeelenCommand.GetNetworkHotspot),
  (apply) => subscribe(SeelenEvent.NetworkHotspotChanged, ({ payload }) => apply(payload)),
);

const sections = [radios, hotspot];

let wlanBssEntries = $state.raw<WlanBssEntry[]>([]);
let scanSubscription: Promise<unknown> | null = null;
function ensureScanSubscription(): Promise<unknown> {
  scanSubscription ??= subscribe(SeelenEvent.NetworkWlanScanned, ({ payload }) => applyScanResults(payload))
    .catch((error) => {
      scanSubscription = null;
      throw error;
    });
  return scanSubscription;
}

let visible = $state(widget.isVisible);
/** The drawer is only interactive while focused; scanning is pointless in the background. */
let focused = $state(true);
let scanPhase = $state<ScanPhase>("idle");
let selectedSsid = $state<string | null>(null);
let currentView = $state<"main" | "hotspot">("main");

/** Identifies the running scan loop, so a request that finishes after a stop is ignored. */
let scanSession = 0;
let scanInterval: ReturnType<typeof setInterval> | null = null;
let scanDeadline: ReturnType<typeof setTimeout> | null = null;
let scanInFlight = false;

function clearScanDeadline(): void {
  if (scanDeadline !== null) {
    clearTimeout(scanDeadline);
    scanDeadline = null;
  }
}

function stopScanning(phase: ScanPhase = "idle"): void {
  // Invalidating the session makes any in-flight request a no-op for the next loop.
  scanSession += 1;
  if (scanInterval !== null) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  clearScanDeadline();
  scanPhase = phase;
}

async function requestScan(session: number): Promise<void> {
  if (scanInFlight) {
    return;
  }
  scanInFlight = true;
  try {
    await ensureScanSubscription();
    if (session !== scanSession) return;
    await invoke(SeelenCommand.WlanScan);
  } catch (error) {
    console.error("network-popup: failed to scan for WLAN networks", error);
    if (session === scanSession) {
      stopScanning("error");
    }
  } finally {
    scanInFlight = false;
  }
}

function startScanning(): void {
  stopScanning();
  const session = ++scanSession;
  scanPhase = "scanning";
  void requestScan(session);
  scanInterval = setInterval(() => {
    void requestScan(session);
  }, SCAN_INTERVAL_MS);
  scanDeadline = setTimeout(() => {
    scanDeadline = null;
    if (session !== scanSession || scanPhase !== "scanning") {
      return;
    }
    // The first scan never reported a result: show the failure instead of an empty list.
    stopScanning("error");
  }, SCAN_START_TIMEOUT_MS);
}

function applyScanResults(entries: WlanBssEntry[]): void {
  wlanBssEntries = entries;
  if (scanPhase === "scanning" || scanPhase === "error") {
    // The first result ends the indeterminate scanning state.
    clearScanDeadline();
    scanPhase = "ready";
  }
}

function reconcileScanning(): void {
  const wifiEnabled = radios.value?.some(
    (radio) => radio.kind === RadioDeviceKind.WiFi && radio.isEnabled,
  ) ?? false;
  if (!visible || !focused || !wifiEnabled) {
    if (scanInterval !== null || scanPhase === "scanning") {
      stopScanning();
    }
    return;
  }
  if (scanInterval === null) {
    startScanning();
  }
}

$effect.root(() => {
  $effect(() => {
    // Reconcile only when the radio list, the visibility or the focus changes.
    radios.value;
    visible;
    focused;
    untrack(reconcileScanning);
  });
});

function resetTransientView(): void {
  selectedSsid = null;
  currentView = "main";
}

let started = false;
function startLoading(): void {
  if (started) {
    return;
  }
  started = true;
  // Independent reads run concurrently, the shell is already mounted.
  for (const section of sections) {
    void section.load();
  }
}

class State {
  get wifiRadio(): RadioDevice | undefined {
    return radios.value?.find((radio) => radio.kind === RadioDeviceKind.WiFi);
  }

  get radios(): RadioDevice[] {
    return radios.value ?? NO_RADIOS;
  }

  get radiosStatus(): AsyncSectionStatus {
    return radios.state;
  }

  get hotspotStatus(): AsyncSectionStatus {
    return hotspot.state;
  }

  get hotspot(): Hotspot | null {
    return hotspot.value ?? null;
  }

  get wlanBssEntries(): WlanBssEntry[] {
    return wlanBssEntries;
  }

  get scanPhase(): ScanPhase {
    return scanPhase;
  }

  get view() {
    return currentView;
  }

  set view(value: "main" | "hotspot") {
    currentView = value;
  }

  get selectedSsid() {
    return selectedSsid;
  }

  set selectedSsid(value: string | null) {
    selectedSsid = value;
  }

  get isDevtoolsEnabled(): boolean {
    return devtoolsEnabled;
  }

  get wifiRadioPending(): boolean {
    return actions.isPending("wifi-radio");
  }

  get actionFailed(): boolean {
    return actions.hasFailed();
  }

  get hotspotPending(): boolean {
    return actions.isPending("hotspot");
  }

  retryHotspot(): void {
    void hotspot.load();
  }

  async toggleHotspot(): Promise<void> {
    const current = hotspot.value;
    if (!current) return;
    await actions.run(
      "hotspot",
      () => invoke(SeelenCommand.SetNetworkHotspotState, { enabled: current.state !== "on" }),
      () => hotspot.load(true),
    );
  }

  retryRadios(): void {
    void radios.load();
  }

  retryScan(): void {
    if (!visible || scanInterval !== null) {
      return;
    }
    startScanning();
  }

  async toggleWifiRadio(): Promise<void> {
    const radio = this.wifiRadio;
    if (radios.state !== "ready" || !radio) {
      return;
    }
    await actions.run(
      "wifi-radio",
      () =>
        invoke(SeelenCommand.SetRadioState, {
          kind: RadioDeviceKind.WiFi,
          enabled: !radio.isEnabled,
        }),
      // the switch must show the state the backend really has after a rejection
      () => radios.load(true),
    );
  }
}

export const globalState = new State();

void initSettings();

widget.onVisibilityChanged((value) => {
  visible = value;
  if (value) {
    startLoading();
  } else {
    resetTransientView();
  }
});
if (widget.isVisible) {
  startLoading();
}

widget.window.onFocusChanged(({ payload }) => {
  focused = payload;
  if (!payload) {
    // The drawer hides right after losing focus.
    resetTransientView();
  }
});
