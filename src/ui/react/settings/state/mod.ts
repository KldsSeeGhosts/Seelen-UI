import { invoke, SeelenCommand, SeelenEvent, subscribe } from "@seelen-ui/lib";
import { batch, computed, effect, signal } from "@preact/signals";
import { Modal } from "antd";
import { monitors } from "./system";
import { cloneDeep } from "lodash";
import i18n from "../i18n";
import { hasPermissionsChanges, restorePermissionsToLastSaved, savePermissions } from "./permissions";

const [defaultSettings, currentSettings, bundledAppConfigs, defaultMonitorConfig] = await Promise.all([
  invoke(SeelenCommand.StateGetDefaultSettings),
  invoke(SeelenCommand.StateGetSettings, { path: null }),
  invoke(SeelenCommand.StateGetSettingsByApp),
  invoke(SeelenCommand.StateGetDefaultMonitorSettings),
]);

export const DEFAULT_SETTINGS = defaultSettings;
export const settings = signal(currentSettings);
const initialSettings = signal(JSON.stringify(settings.value));
subscribe(SeelenEvent.StateSettingsChanged, ({ payload }) => {
  settings.value = payload;
  initialSettings.value = JSON.stringify(payload);
});

export const language = computed(() => settings.value.language);

const hasSettingsChanges = computed(() => initialSettings.value !== JSON.stringify(settings.value));
export const hasChanges = computed(() => hasSettingsChanges.value || hasPermissionsChanges.value);
export const needRestart = signal(false);

export const appsConfig = computed(() => [...bundledAppConfigs, ...settings.value.byApp]);

export async function saveSettings(): Promise<boolean> {
  try {
    if (hasPermissionsChanges.value) {
      await savePermissions();
    }
  } catch (error) {
    Modal.error({
      title: "Error on Save",
      content: String(error),
      centered: true,
    });
    return false;
  }

  if (!hasSettingsChanges.value) {
    return true;
  }

  const s = settings.value;

  const referenced = new Set<string>();
  const wallConfig = s.byWidget["@seelen/wallpaper-manager"];
  if (wallConfig?.defaultCollection) referenced.add(wallConfig.defaultCollection);
  Object.values(s.monitorsV3).forEach((m) => {
    if (m.wallpaperCollection) referenced.add(m.wallpaperCollection);
    Object.values(m.byWorkspace ?? {}).forEach((ws) => {
      if (ws.wallpaperCollection) referenced.add(ws.wallpaperCollection);
    });
  });

  const cleaned = {
    ...s,
    wallpaperCollections: s.wallpaperCollections.filter((c) => !c.hidden || referenced.has(c.id)),
  };

  try {
    settings.value = cleaned;
    await invoke(SeelenCommand.StateWriteSettings, {
      settings: cleaned,
    });
    initialSettings.value = JSON.stringify(cleaned);
  } catch (error) {
    Modal.error({
      title: "Error on Save",
      content: String(error),
      centered: true,
    });
    return false;
  }
  return true;
}

effect(() => {
  const current = settings.peek();
  const missing = monitors.value.filter((monitor) => !current.monitorsV3[monitor.id]);
  if (missing.length === 0) return;

  const sanitized = { ...current, monitorsV3: { ...current.monitorsV3 } };
  // Add automatic defaults to both snapshots without marking pending edits as saved.
  const saved = JSON.parse(initialSettings.peek()) as typeof current;
  for (const monitor of missing) {
    sanitized.monitorsV3[monitor.id] = cloneDeep(defaultMonitorConfig);
    saved.monitorsV3[monitor.id] ??= cloneDeep(defaultMonitorConfig);
  }
  batch(() => {
    settings.value = sanitized;
    initialSettings.value = JSON.stringify(saved);
  });
});

effect(() => {
  i18n.changeLanguage(language.value);
});

export function restoreToLastSaved() {
  settings.value = JSON.parse(initialSettings.value);
  restorePermissionsToLastSaved();
}
