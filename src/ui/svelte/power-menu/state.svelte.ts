import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { Settings as SettingsType, User } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import { monitors } from "libs/ui/svelte/runes/monitors.svelte.ts";
import { AsyncSection, type AsyncSectionStatus } from "libs/ui/svelte/utils/AsyncSection.svelte.ts";

export type { AsyncSectionStatus };

const widget = Widget.getCurrent();

let language: string | undefined;

function applyLanguage(value: string | undefined): void {
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`power-menu: failed to load the "${value}" translations`, error);
  });
}

/** Settings are only used to resolve the language, so they must never gate the menu shell. */
async function initSettings(): Promise<void> {
  try {
    // Awaiting the acknowledgement guarantees that the initial snapshot cannot override a newer event.
    await Settings.onChange((settings: SettingsType) => applyLanguage(settings.language));
    const settings = await Settings.getAsync();
    if (!language) {
      applyLanguage(settings.language);
    }
  } catch (error) {
    console.error("power-menu: failed to load settings", error);
  }
}

const user = new AsyncSection(
  "user",
  () => invoke(SeelenCommand.GetUser),
  (apply) => subscribe(SeelenEvent.UserChanged, ({ payload }) => apply(payload)),
);

const pendingUpdates = new AsyncSection(
  "pending updates",
  () => invoke(SeelenCommand.HasPendingOsUpdates),
);

/** Monitor data is shared with the other overlay widgets, so it is read through its own state. */
let monitorsStatus = $state<AsyncSectionStatus>("loading");
let monitorsLoading: Promise<void> | null = null;

const desktopRect = $derived.by(() => (monitorsStatus === "ready" ? monitors.desktopRect : null));
const primaryMonitor = $derived.by(() => monitorsStatus === "ready" ? monitors.primaryMonitor ?? null : null);

function loadMonitors(): Promise<void> {
  if (monitorsLoading) {
    return monitorsLoading;
  }
  monitorsStatus = "loading";
  monitorsLoading = monitors.init().then(() => {
    monitorsStatus = "ready";
  }).catch((error) => {
    console.error("power-menu: failed to load the monitors", error);
    monitorsStatus = "error";
  }).finally(() => {
    monitorsLoading = null;
  });
  return monitorsLoading;
}

$effect.root(() => {
  $effect(() => {
    const rect = desktopRect;
    if (!rect) {
      return;
    }
    widget.setPosition(rect).catch((error) => {
      console.error("power-menu: failed to position the overlay", error);
    });
  });
});

async function applyOverlayPosition(): Promise<void> {
  if (monitorsStatus !== "ready") await loadMonitors();
  const rect = desktopRect;
  if (!rect) {
    throw new Error("Cannot position power menu without monitor bounds");
  }
  try {
    await widget.setPosition(rect);
  } catch (error) {
    console.error("power-menu: failed to position the overlay", error);
  }
}

function refreshSections(): void {
  // The registry-backed profile and the update state can change while the menu is retained.
  void user.load(true);
  void pendingUpdates.load(true);
}

let requestedVisible = false;
let preparingOpen = false;
let triggerVersion = 0;

widget.onVisibilityChanged((visible) => {
  // A hide that was already in flight must not cancel the opening that follows it.
  if (!visible && preparingOpen) {
    return;
  }
  requestedVisible = visible;
});

widget.onTrigger(async ({ customArgs }) => {
  const version = ++triggerVersion;
  if (customArgs?.toggle === true && requestedVisible) {
    requestedVisible = false;
    preparingOpen = false;
    await widget.hide();
    return;
  }

  requestedVisible = true;
  preparingOpen = true;
  try {
    await applyOverlayPosition();
    if (version !== triggerVersion || !requestedVisible) {
      return;
    }
    refreshSections();
    await widget.show();
    if (version !== triggerVersion || !requestedVisible) {
      return;
    }
    await widget.focus();
  } catch (error) {
    if (version === triggerVersion) {
      requestedVisible = widget.isVisible;
    }
    console.error("power-menu: failed to open", error);
  } finally {
    if (version === triggerVersion) {
      preparingOpen = false;
    }
  }
});

class State {
  get user(): User | null {
    return user.value ?? null;
  }

  get userStatus(): AsyncSectionStatus {
    return user.state;
  }

  retryUser(): void {
    void user.load();
  }

  get hasPendingOsUpdates(): boolean {
    return pendingUpdates.value ?? false;
  }

  get monitorsStatus(): AsyncSectionStatus {
    return monitorsStatus;
  }

  retryMonitors(): void {
    void loadMonitors();
  }

  /** Frame of the popup over the primary monitor, or the whole overlay while monitors are unknown. */
  get popupFrame() {
    const monitor = primaryMonitor;
    if (!monitor) {
      return {
        x: 0,
        y: 0,
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
        scale: 1,
      };
    }
    const relativeRect = monitors.calculateDesktopRelativeRect(monitor.rect);
    return {
      x: relativeRect.left,
      y: relativeRect.top,
      // the size is reduced and later scaled to get the correct display by dpi aware
      width: (monitor.rect.right - monitor.rect.left) / monitor.scaleFactor,
      height: (monitor.rect.bottom - monitor.rect.top) / monitor.scaleFactor,
      scale: monitor.scaleFactor,
    };
  }
}

export const globalState = new State();

void initSettings();
void loadMonitors();
void user.load();
void pendingUpdates.load();
