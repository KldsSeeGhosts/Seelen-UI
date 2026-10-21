import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, type UnSubscriber, Widget } from "@seelen-ui/lib";
import type { Hotspot, MediaDevice, PhysicalMonitor, RadioDevice } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import { AsyncActions } from "libs/ui/svelte/utils/AsyncActions.svelte.ts";

export type SectionStatus = "loading" | "ready" | "error";

const NO_MEDIA_DEVICES: MediaDevice[] = [];
const NO_RADIOS: RadioDevice[] = [];
const NO_MONITORS: PhysicalMonitor[] = [];

interface SectionSnapshot<T> {
  data: T | undefined;
  status: SectionStatus;
}

// Reactive values stay at module scope; the classes below only provide access and actions.
const snapshots = $state({
  mediaDevices: { data: undefined, status: "loading" } as SectionSnapshot<{
    inputs: MediaDevice[];
    outputs: MediaDevice[];
  }>,
  radios: { data: undefined, status: "loading" } as SectionSnapshot<RadioDevice[]>,
  hotspot: { data: undefined, status: "loading" } as SectionSnapshot<Hotspot | null>,
  monitors: { data: undefined, status: "loading" } as SectionSnapshot<PhysicalMonitor[]>,
  darkMode: { data: undefined, status: "loading" } as SectionSnapshot<boolean>,
  nightLight: { data: undefined, status: "loading" } as SectionSnapshot<boolean>,
});

/**
 * Optional data of the popup. Loading runs in the background so the shell can render first.
 * An event received while the initial fetch is in flight is newer and wins over its response.
 */
class Section<T> {
  /** Incremented by every applied snapshot, so out-of-order responses can be discarded. */
  private revision = 0;
  private subscription: Promise<void> | null = null;

  constructor(
    private readonly name: string,
    private readonly fetch: () => Promise<T>,
    private readonly snapshot: SectionSnapshot<T>,
    private readonly listen?: (apply: (value: T) => void) => Promise<UnSubscriber>,
  ) {}

  get data(): T | undefined {
    return this.snapshot.data;
  }

  get status(): SectionStatus {
    return this.snapshot.status;
  }

  private ensureSubscription(): Promise<void> {
    if (!this.listen) {
      return Promise.resolve();
    }
    this.subscription ??= this.listen((value) => this.apply(value))
      .then(() => undefined)
      .catch((error) => {
        this.subscription = null;
        throw error;
      });
    return this.subscription;
  }

  private apply(value: T): void {
    this.revision += 1;
    this.snapshot.data = value;
    this.snapshot.status = "ready";
  }

  async load(refresh = false): Promise<void> {
    const revision = ++this.revision;
    if (!refresh || this.snapshot.data === undefined) {
      this.snapshot.status = "loading";
    }

    try {
      // Awaiting the acknowledgement guarantees no background update is missed before the fetch.
      await this.ensureSubscription();
    } catch (error) {
      console.error(`quick-settings: failed to subscribe to ${this.name}`, error);
      if (revision === this.revision) {
        this.snapshot.status = "error";
      }
      return;
    }

    try {
      const snapshot = await this.fetch();
      if (revision !== this.revision) {
        return; // an event or a newer request already provided the data
      }
      this.snapshot.data = snapshot;
      this.snapshot.status = "ready";
    } catch (error) {
      if (revision !== this.revision) {
        return;
      }
      console.error(`quick-settings: failed to load ${this.name}`, error);
      this.snapshot.status = "error";
    }
  }

  set(value: T): void {
    this.apply(value);
  }
}

let language: string | undefined;

function applyLanguage(value: string | undefined): void {
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`quick-settings: failed to load the "${value}" translations`, error);
  });
}

/** Settings are only used to resolve the language, so they must never gate the popup shell. */
async function initSettings(): Promise<void> {
  try {
    // Awaiting the acknowledgement guarantees that the initial snapshot cannot override a newer event.
    await Settings.onChange((settings) => applyLanguage(settings.language));
    const settings = await Settings.getAsync();
    if (!language) {
      applyLanguage(settings.language);
    }
  } catch (error) {
    console.error("quick-settings: failed to load settings", error);
  }
}

const mediaDevices = new Section(
  "media devices",
  async () => {
    const [inputs, outputs] = await invoke(SeelenCommand.GetMediaDevices);
    return { inputs, outputs };
  },
  snapshots.mediaDevices,
  (apply) => subscribe(SeelenEvent.MediaDevices, ({ payload: [inputs, outputs] }) => apply({ inputs, outputs })),
);

const radios = new Section(
  "radios",
  () => invoke(SeelenCommand.GetRadios),
  snapshots.radios,
  (apply) => subscribe(SeelenEvent.RadiosChanged, ({ payload }) => apply(payload)),
);

const hotspot = new Section<Hotspot | null>(
  "hotspot",
  () => invoke(SeelenCommand.GetNetworkHotspot),
  snapshots.hotspot,
  (apply) => subscribe(SeelenEvent.NetworkHotspotChanged, ({ payload }) => apply(payload)),
);

const monitors = new Section(
  "monitors",
  () => invoke(SeelenCommand.SystemGetMonitors),
  snapshots.monitors,
  (apply) => subscribe(SeelenEvent.SystemMonitorsChanged, ({ payload }) => apply(payload)),
);

const darkMode = new Section(
  "dark mode",
  () => invoke(SeelenCommand.SystemGetDarkMode),
  snapshots.darkMode,
  (apply) => subscribe(SeelenEvent.DarkModeChanged, ({ payload }) => apply(payload)),
);

const nightLight = new Section(
  "night light",
  () => invoke(SeelenCommand.SystemGetNightLightEnabled),
  snapshots.nightLight,
);

const sections = [mediaDevices, radios, hotspot, monitors, darkMode, nightLight];

/** In-flight radio-grid actions; a control stays disabled until its own action settles. */
const actions = new AsyncActions();

class State {
  get mediaInputs(): MediaDevice[] {
    return mediaDevices.data?.inputs ?? NO_MEDIA_DEVICES;
  }
  get mediaOutputs(): MediaDevice[] {
    return mediaDevices.data?.outputs ?? NO_MEDIA_DEVICES;
  }
  get radios(): RadioDevice[] {
    return radios.data ?? NO_RADIOS;
  }
  get hotspot(): Hotspot | null {
    return hotspot.data ?? null;
  }
  get monitors(): PhysicalMonitor[] {
    return monitors.data ?? NO_MONITORS;
  }
  get darkMode(): boolean {
    return darkMode.data ?? false;
  }
  get nightLightEnabled(): boolean {
    return nightLight.data ?? false;
  }
  set nightLightEnabled(value: boolean) {
    nightLight.set(value);
  }

  get mediaDevicesStatus(): SectionStatus {
    return mediaDevices.status;
  }
  get radiosStatus(): SectionStatus {
    return radios.status;
  }
  get hotspotStatus(): SectionStatus {
    return hotspot.status;
  }
  get monitorsStatus(): SectionStatus {
    return monitors.status;
  }
  get darkModeStatus(): SectionStatus {
    return darkMode.status;
  }
  get nightLightStatus(): SectionStatus {
    return nightLight.status;
  }

  /** Only failures with a visible control in the radio grid own a retry affordance. */
  get radioControlsFailed(): boolean {
    return radios.status === "error" || hotspot.status === "error" ||
      darkMode.status === "error" || nightLight.status === "error";
  }

  isActionPending(key: string): boolean {
    return actions.isPending(key);
  }

  hasActionFailed(key?: string): boolean {
    return actions.hasFailed(key);
  }

  /**
   * Runs a control action once and disables it meanwhile. On failure the affected data is read
   * again, so the control ends up showing what the backend really has.
   */
  runAction(
    key: string,
    action: () => Promise<unknown>,
    recover?: () => Promise<unknown> | unknown,
  ): Promise<boolean> {
    return actions.run(key, action, recover);
  }

  refreshRadios(): Promise<void> {
    return radios.load(true);
  }

  refreshHotspot(): Promise<void> {
    return hotspot.load(true);
  }

  refreshMonitors(): Promise<void> {
    return monitors.load(true);
  }

  refreshDarkMode(): Promise<void> {
    return darkMode.load(true);
  }

  refreshNightLight(): Promise<void> {
    return nightLight.load(true);
  }

  retryRadioControls(): void {
    for (const section of [radios, hotspot, darkMode, nightLight]) {
      if (section.status === "error") {
        void section.load();
      }
    }
  }

  retryMonitors(): void {
    void monitors.load();
  }

  retryMediaDevices(): void {
    void mediaDevices.load();
  }
}

export const state = new State();

void initSettings();

let started = false;
function startLoading(): void {
  if (started) {
    // Night light has no push subscription; a retained popup still needs a fresh read.
    void nightLight.load(true);
    return;
  }
  started = true;
  for (const section of sections) {
    void section.load();
  }
}

// Optional device enumeration starts with the first show request, after mounting the shell.
const widget = Widget.self;
widget.onVisibilityChanged((visible) => {
  if (visible) startLoading();
});
if (widget.isVisible) startLoading();
