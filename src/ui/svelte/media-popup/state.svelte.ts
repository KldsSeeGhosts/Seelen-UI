import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { MediaDevice, MediaPlayer } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import { AsyncSection, type AsyncSectionStatus } from "libs/ui/svelte/utils/AsyncSection.svelte.ts";

export type { AsyncSectionStatus };

const NO_DEVICES: MediaDevice[] = [];
const NO_SESSIONS: MediaPlayer[] = [];

const widget = Widget.getCurrent();

let language: string | undefined;

function applyLanguage(value: string | undefined): void {
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`media-popup: failed to load the "${value}" translations`, error);
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
    console.error("media-popup: failed to load settings", error);
  }
}

const mediaDevices = new AsyncSection(
  "media devices",
  async () => {
    const [inputs, outputs] = await invoke(SeelenCommand.GetMediaDevices);
    return { inputs, outputs };
  },
  (apply) => subscribe(SeelenEvent.MediaDevices, ({ payload: [inputs, outputs] }) => apply({ inputs, outputs })),
);

const mediaSessions = new AsyncSection(
  "media sessions",
  () => invoke(SeelenCommand.GetMediaSessions),
  (apply) => subscribe(SeelenEvent.MediaSessions, ({ payload }) => apply(payload)),
);

/** Device enumeration can block the backend, and the thumbnail luminance is only needed
 * while the popup is on screen, so both are derived from the real visibility. */
let visible = $state(widget.isVisible);
let currentView = $state<"main" | "mixer">("main");
let selectedDeviceId = $state<string | null>(null);

class State {
  get inputs(): MediaDevice[] {
    return mediaDevices.value?.inputs ?? NO_DEVICES;
  }

  get outputs(): MediaDevice[] {
    return mediaDevices.value?.outputs ?? NO_DEVICES;
  }

  get sessions(): MediaPlayer[] {
    return mediaSessions.value ?? NO_SESSIONS;
  }

  get defaultInput(): MediaDevice | undefined {
    return this.inputs.find((d) => d.isDefaultMultimedia);
  }

  get defaultOutput(): MediaDevice | undefined {
    return this.outputs.find((d) => d.isDefaultMultimedia);
  }

  get devicesStatus(): AsyncSectionStatus {
    return mediaDevices.state;
  }

  get sessionsStatus(): AsyncSectionStatus {
    return mediaSessions.state;
  }

  get visible(): boolean {
    return visible;
  }

  get view() {
    return currentView;
  }

  set view(value: "main" | "mixer") {
    currentView = value;
  }

  get selectedDeviceId() {
    return selectedDeviceId;
  }

  set selectedDeviceId(value: string | null) {
    selectedDeviceId = value;
  }

  get selectedDevice(): MediaDevice | undefined {
    if (!selectedDeviceId) return undefined;
    return (
      this.inputs.find((d) => d.id === selectedDeviceId) ||
      this.outputs.find((d) => d.id === selectedDeviceId)
    );
  }

  retryDevices(): void {
    void mediaDevices.load();
  }

  retrySessions(): void {
    void mediaSessions.load();
  }
}

export const globalState = new State();

void initSettings();

let started = false;
function startLoading(): void {
  if (started) {
    return;
  }
  started = true;
  // Independent reads run concurrently, the shell is already mounted.
  void mediaDevices.load();
  void mediaSessions.load();
}

widget.onVisibilityChanged((value) => {
  visible = value;
  if (value) {
    startLoading();
  }
});
if (widget.isVisible) {
  startLoading();
}

widget.window.onFocusChanged((e) => {
  if (!e.payload) {
    // Reset state when popup loses focus
    currentView = "main";
    selectedDeviceId = null;
  }
});
