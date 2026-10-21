import { Settings, Widget } from "@seelen-ui/lib";
import type { Settings as SettingsType, StartOfWeek } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import moment from "moment";

const momentJsLangMap: { [key: string]: string } = {
  no: "nb",
};

const startDayMap: Record<StartOfWeek, number> = {
  Sunday: 0,
  Monday: 1,
  Saturday: 6,
};

const widget = Widget.getCurrent();

let settings = $state<SettingsType | null>(null);
let viewMode = $state<"month" | "year">("month");
/** The highlighted current day, refreshed on every open: a retained popup must not keep an old day. */
let today = $state.raw(moment());

let language: string | undefined;
/** The settings that were already applied to moment and the translations. */
let appliedSettings = "";
/** Incremented by every applied event so a stale initial read cannot override a newer one. */
let settingsRevision = 0;

function toMomentLang(lang: string): string {
  return momentJsLangMap[lang] || lang.toLowerCase();
}

function applySettings(value: SettingsType): void {
  settingsRevision += 1;
  settings = value;

  const signature = `${value.language}|${value.startOfWeek}`;
  if (signature === appliedSettings) {
    return;
  }
  appliedSettings = signature;

  const momentLang = toMomentLang(value.language);
  moment.updateLocale(momentLang, {
    week: { dow: startDayMap[value.startOfWeek] ?? 0 },
    postformat: (str: string) => str,
  });

  if (value.language !== language) {
    language = value.language;
    void locale.set(value.language).catch((error) => {
      console.error(`calendar-popup: failed to load the "${value.language}" translations`, error);
    });
  }
}

/** Settings only provide the language and the first day of the week, so they never gate the shell. */
async function initSettings(): Promise<void> {
  try {
    // Awaiting the acknowledgement guarantees that the initial snapshot cannot override a newer event.
    await Settings.onChange((value) => applySettings(value));
    const revision = settingsRevision;
    const value = await Settings.getAsync();
    if (revision === settingsRevision) {
      applySettings(value);
    }
  } catch (error) {
    console.error("calendar-popup: failed to load settings", error);
  }
}

let todayTimer: ReturnType<typeof setTimeout> | null = null;

function stopTodayTimer(): void {
  if (todayTimer !== null) {
    clearTimeout(todayTimer);
    todayTimer = null;
  }
}

function refreshToday(): void {
  today = moment();
  stopTodayTimer();
  // A retained popup can stay open over midnight, so schedule the next day change.
  const untilMidnight = moment().endOf("day").add(1, "millisecond").diff(moment());
  todayTimer = setTimeout(refreshToday, Math.max(untilMidnight, 1000));
}

class State {
  get viewMode() {
    return viewMode;
  }
  set viewMode(value: "month" | "year") {
    viewMode = value;
  }
  get settings() {
    return settings;
  }
  get today() {
    return today;
  }
  get momentLang() {
    return toMomentLang(settings?.language ?? "en");
  }
}

export const globalState = new State();

void initSettings();

widget.onVisibilityChanged((visible) => {
  if (visible) {
    // The retained popup can have been hidden since before midnight.
    refreshToday();
  } else {
    stopTodayTimer();
  }
});
if (widget.isVisible) {
  refreshToday();
}
