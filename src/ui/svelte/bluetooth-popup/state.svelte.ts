import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { Settings as SettingsType } from "@seelen-ui/lib/types";
import { type BluetoothDevice, type RadioDevice, RadioDeviceKind } from "@seelen-ui/lib/types";
import { untrack } from "svelte";
import { locale } from "./i18n/index.ts";
import { AsyncActions } from "libs/ui/svelte/utils/AsyncActions.svelte.ts";
import { AsyncSection, type AsyncSectionStatus } from "libs/ui/svelte/utils/AsyncSection.svelte.ts";

export type { AsyncSectionStatus };

export enum BluetoothOperation {
  Connecting = "connecting",
  Disconnecting = "disconnecting",
  Pairing = "pairing",
  Unpairing = "unpairing",
}

/** `scanning` lasts until the first result arrives, so an empty list is never ambiguous. */
export type ScanPhase = "idle" | "scanning" | "ready" | "error";

const NO_DEVICES: BluetoothDevice[] = [];

const widget = Widget.getCurrent();
const actions = new AsyncActions();

let language: string | undefined;
/** Only used by the developer details of a device. */
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
    console.error(`bluetooth-popup: failed to load the "${value}" translations`, error);
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
    console.error("bluetooth-popup: failed to load settings", error);
  }
}

const devices = new AsyncSection(
  "bluetooth devices",
  () => invoke(SeelenCommand.GetBluetoothDevices),
  (apply) => subscribe(SeelenEvent.BluetoothDevicesChanged, ({ payload }) => apply(payload)),
);

const radios = new AsyncSection(
  "bluetooth radios",
  () => invoke(SeelenCommand.GetRadios),
  (apply) => subscribe(SeelenEvent.RadiosChanged, ({ payload }) => apply(payload)),
);

const sections = [devices, radios];

let visible = $state(widget.isVisible);
/** Discovery is pointless while the drawer is hidden or while another window is focused. */
let focused = $state(true);
let scanPhase = $state<ScanPhase>("idle");
let selectedDeviceId = $state<string | null>(null);
let loadingDeviceId = $state<string | null>(null);
let loadingOperation = $state<BluetoothOperation | null>(null);
let scanTimer: ReturnType<typeof setTimeout> | null = null;

/** Latest requested discovery state. */
let scanIntent = false;
/** Last state the backend acknowledged, `null` while it is unknown after a failure. */
let reconciledIntent: boolean | null = null;
let reconciling = false;

function bluetoothEnabled(): boolean {
  return radios.value?.some(
    (radio) => radio.kind === RadioDeviceKind.Bluetooth && radio.isEnabled,
  ) ?? false;
}

/**
 * Applies the latest discovery intent. A start and a stop can overlap, so the loop always
 * finishes on the last requested state instead of letting an older command win.
 */
async function applyScanIntent(): Promise<void> {
  if (reconciling) {
    return; // the running loop picks up the newest intent
  }
  reconciling = true;
  try {
    while (reconciledIntent !== scanIntent) {
      const target = scanIntent;
      let failed = false;
      try {
        if (target) {
          await invoke(SeelenCommand.StartBluetoothScanning);
        } else {
          await invoke(SeelenCommand.StopBluetoothScanning);
        }
      } catch (error) {
        console.error(
          `bluetooth-popup: failed to ${target ? "start" : "stop"} the device scan`,
          error,
        );
        reconciledIntent = null;
        failed = true;
        if (target && scanIntent) {
          scanPhase = "error";
        }
      }
      if (failed) {
        if (scanIntent === target) {
          return; // retry only after a new intent, never in a tight loop
        }
        continue; // a newer intent arrived while the command was failing
      }
      reconciledIntent = target;
    }
  } finally {
    reconciling = false;
  }
}

function reconcileScanning(): void {
  const wasScanning = scanIntent;
  const shouldScan = visible && focused && bluetoothEnabled();
  scanIntent = shouldScan;
  if (!shouldScan) {
    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = null;
    scanPhase = "idle";
  } else if (!wasScanning || scanPhase === "error") {
    // A new discovery session stays in the scanning state until the first result arrives.
    scanPhase = "scanning";
    if (scanTimer !== null) clearTimeout(scanTimer);
    // Discovery has no completion event when it finds no devices.
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (scanIntent && scanPhase === "scanning") scanPhase = "ready";
    }, 8_000);
  }
  void applyScanIntent();
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

$effect.root(() => {
  $effect(() => {
    devices.value;
    untrack(() => {
      if (scanPhase === "scanning") {
        // The first result ends the indeterminate scanning state.
        scanPhase = "ready";
      }
    });
  });
});

function resetTransientView(): void {
  selectedDeviceId = null;
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
  get bluetoothRadio(): RadioDevice | undefined {
    return radios.value?.find((radio) => radio.kind === RadioDeviceKind.Bluetooth);
  }

  get devices(): BluetoothDevice[] {
    return devices.value ?? NO_DEVICES;
  }

  get devicesStatus(): AsyncSectionStatus {
    return devices.state;
  }

  get radiosStatus(): AsyncSectionStatus {
    return radios.state;
  }

  get scanPhase(): ScanPhase {
    return scanPhase;
  }

  get selectedDeviceId() {
    return selectedDeviceId;
  }
  set selectedDeviceId(value: string | null) {
    selectedDeviceId = value;
  }

  get loadingDeviceId() {
    return loadingDeviceId;
  }
  set loadingDeviceId(value: string | null) {
    loadingDeviceId = value;
  }

  get loadingOperation() {
    return loadingOperation;
  }
  set loadingOperation(value: BluetoothOperation | null) {
    loadingOperation = value;
  }

  get isDevtoolsEnabled(): boolean {
    return devtoolsEnabled;
  }

  get bluetoothRadioPending(): boolean {
    return actions.isPending("bluetooth-radio");
  }

  get actionFailed(): boolean {
    return actions.hasFailed();
  }

  retryDevices(): void {
    void devices.load();
  }

  retryRadios(): void {
    void radios.load();
  }

  retryScan(): void {
    if (!visible || !bluetoothEnabled()) {
      return;
    }
    scanIntent = false;
    reconcileScanning();
    scanIntent = true;
    reconciledIntent = null; // force a new start command even if the last one was acknowledged
    void applyScanIntent();
  }

  async toggleBluetoothRadio(): Promise<void> {
    const radio = this.bluetoothRadio;
    if (radios.state !== "ready" || !radio) {
      return;
    }
    await actions.run(
      "bluetooth-radio",
      () =>
        invoke(SeelenCommand.SetRadioState, {
          kind: RadioDeviceKind.Bluetooth,
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
