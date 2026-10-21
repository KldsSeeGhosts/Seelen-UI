import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { Settings as SettingsType, SystemLanguage } from "@seelen-ui/lib/types";
import { locale } from "./i18n/index.ts";
import { AsyncActions } from "libs/ui/svelte/utils/AsyncActions.svelte.ts";
import { AsyncSection, type AsyncSectionStatus } from "libs/ui/svelte/utils/AsyncSection.svelte.ts";

export type { AsyncSectionStatus };

const NO_LANGUAGES: SystemLanguage[] = [];

const widget = Widget.getCurrent();
const actions = new AsyncActions();

let language: string | undefined;

function applyLanguage(value: string | undefined): void {
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`keyboard-selector: failed to load the "${value}" translations`, error);
  });
}

/** Settings are only used to resolve the language, so they must never gate the selector shell. */
async function initSettings(): Promise<void> {
  try {
    // Awaiting the acknowledgement guarantees that the initial snapshot cannot override a newer event.
    await Settings.onChange((settings: SettingsType) => applyLanguage(settings.language));
    const settings = await Settings.getAsync();
    if (!language) {
      applyLanguage(settings.language);
    }
  } catch (error) {
    console.error("keyboard-selector: failed to load settings", error);
  }
}

const languages = new AsyncSection(
  "keyboard languages",
  () => invoke(SeelenCommand.SystemGetLanguages),
  (apply) => subscribe(SeelenEvent.SystemLanguagesChanged, ({ payload }) => apply(payload)),
);

class State {
  get actionFailed(): boolean {
    return actions.hasFailed();
  }
  get langs(): SystemLanguage[] {
    return languages.value ?? NO_LANGUAGES;
  }

  get languagesStatus(): AsyncSectionStatus {
    return languages.state;
  }

  retryLanguages(): void {
    void languages.load();
  }

  isPending(handle: string): boolean {
    return actions.isPending(`layout:${handle}`);
  }

  async selectLayout(id: string, handle: string): Promise<void> {
    const applied = await actions.run(
      `layout:${handle}`,
      () => invoke(SeelenCommand.SystemSetKeyboardLayout, { id, handle }),
    );
    // The drawer closes only after Windows accepted the layout.
    if (applied) {
      await widget.hide();
    }
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
  void languages.load();
}

widget.onVisibilityChanged((visible) => {
  if (visible) {
    startLoading();
  }
});
if (widget.isVisible) {
  startLoading();
}
