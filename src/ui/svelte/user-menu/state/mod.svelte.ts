import { invoke, SeelenCommand, SeelenEvent, Settings, subscribe, Widget } from "@seelen-ui/lib";
import type { FolderType, User } from "@seelen-ui/lib/types";
import { locale } from "../i18n/index.ts";
import { knownFolders } from "./knownFolders.svelte.ts";

export type UserStatus = "loading" | "ready" | "error";

const widget = Widget.getCurrent();

let language: string | undefined;

function applyLanguage(value: string | undefined): void {
  if (!value || value === language) {
    return;
  }
  language = value;
  void locale.set(value).catch((error) => {
    console.error(`user-menu: failed to load the "${value}" translations`, error);
  });
}

/** Settings are only used to resolve the language, so they must never gate the menu shell. */
async function initSettings(): Promise<void> {
  try {
    // Awaiting the acknowledgement guarantees that the initial snapshot cannot override a newer event.
    await Settings.onChange((settings) => applyLanguage(settings.language));
    const settings = await Settings.getAsync();
    if (!language) {
      applyLanguage(settings.language);
    }
  } catch (error) {
    console.error("user-menu: failed to load settings", error);
  }
}

let user = $state<User | null>(null);
let userStatus = $state<UserStatus>("loading");
/** Incremented by every newer snapshot, so an older in-flight fetch can detect it was superseded. */
let userRevision = 0;
let userSubscription: Promise<void> | null = null;

function applyUserEvent(snapshot: User): void {
  userRevision += 1;
  user = snapshot;
  userStatus = "ready";
}

function ensureUserSubscription(): Promise<void> {
  userSubscription ??= subscribe(SeelenEvent.UserChanged, ({ payload }) => applyUserEvent(payload))
    .then(() => undefined)
    .catch((error) => {
      userSubscription = null;
      throw error;
    });
  return userSubscription;
}

async function fetchUser(): Promise<void> {
  const revision = ++userRevision;
  userStatus = "loading";
  try {
    await ensureUserSubscription();
  } catch (error) {
    console.error("user-menu: failed to subscribe to user changes", error);
    if (revision === userRevision) {
      userStatus = "error";
    }
    return;
  }

  try {
    const snapshot = await invoke(SeelenCommand.GetUser);
    if (revision !== userRevision) {
      return; // a newer event or request already provided the profile
    }
    user = snapshot;
    userStatus = "ready";
  } catch (error) {
    if (revision !== userRevision) {
      return;
    }
    console.error("user-menu: failed to load the user profile", error);
    userStatus = "error";
  }
}

let openCategory = $state<FolderType | null>(null);
widget.window.onFocusChanged(({ payload: focused }) => {
  if (!focused) {
    openCategory = null;
  }
});

class State {
  get user(): User | null {
    return user;
  }

  get userStatus(): UserStatus {
    return userStatus;
  }

  retryUser(): void {
    void fetchUser();
  }

  get openCategory(): FolderType | null {
    return openCategory;
  }
  set openCategory(value: FolderType | null) {
    openCategory = value;
    if (value) {
      knownFolders.ensureLoaded(value);
    }
  }
}

export const globalState = new State();

void initSettings();

function startLoading(): void {
  // GetUser refreshes the registry-backed profile; retaining the window must not retain
  // a stale picture/name indefinitely after the user changes Windows account settings.
  void fetchUser();
}

widget.onVisibilityChanged((visible) => {
  if (visible) startLoading();
});
if (widget.isVisible) startLoading();
