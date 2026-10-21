import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { AppNotification } from "@seelen-ui/lib/types";
import { NotificationsMode } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import { AsyncActions } from "libs/ui/svelte/utils/AsyncActions.svelte.ts";
import { AsyncSection, type AsyncSectionStatus } from "libs/ui/svelte/utils/AsyncSection.svelte.ts";

const NO_NOTIFICATIONS: AppNotification[] = [];
/** Relative timestamps only need to be re-derived once a minute while the popup is on screen. */
const CLOCK_INTERVAL_MS = 60_000;

let language: string | undefined;

function applyLanguage(value: string | undefined): void {
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`notifications: failed to load the "${value}" translations`, error);
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
    console.error("notifications: failed to load settings", error);
  }
}

const notifications = new AsyncSection(
  "notifications",
  () => invoke(SeelenCommand.GetNotifications),
  (apply) => subscribe(SeelenEvent.Notifications, ({ payload }) => apply(payload)),
);

const notificationsMode = new AsyncSection(
  "notifications mode",
  () => invoke(SeelenCommand.GetNotificationsMode),
  (apply) => subscribe(SeelenEvent.NotificationsModeChanged, ({ payload }) => apply(payload)),
);

const actions = new AsyncActions();

const sections = [notifications, notificationsMode];

/** Snapshot time used by the relative timestamps, refreshed on show and by the visible clock. */
let now = $state(Date.now());
/** Incremented on every show, so retained popups can reset their scroll offset. */
let showRevision = $state(0);
let clock: ReturnType<typeof setInterval> | null = null;

function stopClock(): void {
  if (clock !== null) {
    clearInterval(clock);
    clock = null;
  }
}

function startClock(): void {
  stopClock();
  // A retained popup shows labels left over from the previous open, refresh them immediately.
  now = Date.now();
  clock = setInterval(() => {
    now = Date.now();
  }, CLOCK_INTERVAL_MS);
}

class State {
  get notifications(): AppNotification[] {
    return notifications.value ?? NO_NOTIFICATIONS;
  }

  get notificationsStatus(): AsyncSectionStatus {
    return notifications.state;
  }

  get focusAssistMode(): NotificationsMode | undefined {
    return notificationsMode.value;
  }

  get focusAssistModeStatus(): AsyncSectionStatus {
    return notificationsMode.state;
  }

  get isDndActive(): boolean {
    return (this.focusAssistMode ?? NotificationsMode.All) !== NotificationsMode.All;
  }

  get now(): number {
    return now;
  }

  get showRevision(): number {
    return showRevision;
  }

  get focusAssistPending(): boolean {
    return actions.isPending("focus-assist");
  }

  get focusAssistFailed(): boolean {
    return actions.hasFailed("focus-assist");
  }

  retryNotifications(): void {
    void notifications.load();
  }

  retryFocusAssist(): void {
    void notificationsMode.load();
  }

  async toggleFocusAssist(): Promise<void> {
    const mode = notificationsMode.value;
    if (notificationsMode.state !== "ready" || mode === undefined) {
      return;
    }
    const target = mode !== NotificationsMode.All ? NotificationsMode.All : NotificationsMode.PriorityOnly;
    await actions.run(
      "focus-assist",
      () => invoke(SeelenCommand.SetNotificationsMode, { mode: target }),
      // the header switch must show the mode the backend really has after a rejection
      () => notificationsMode.load(true),
    );
  }
}

export const globalState = new State();

void initSettings();

let started = false;
function startLoading(): void {
  if (!started) {
    started = true;
    for (const section of sections) {
      void section.load();
    }
  }
  // Retained notifications keep the timestamps of when they were first rendered; both the
  // labels and the scroll offset are refreshed on every open.
  showRevision += 1;
  startClock();
}

Widget.self.onVisibilityChanged((visible) => {
  if (visible) {
    startLoading();
  } else {
    stopClock();
  }
});
if (Widget.self.isVisible) {
  startLoading();
}
