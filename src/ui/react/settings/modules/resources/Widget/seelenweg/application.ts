import { invoke, SeelenCommand } from "@seelen-ui/lib";
import { settings } from "../../../../state/mod";
import type { SeelenWegSettings, WidgetId } from "@seelen-ui/lib/types";
import { patchWidgetConfig, patchWidgetMonitorConfig } from "../application.ts";

/**
 * Patches the SeelenWeg configuration with partial updates.
 * This helper function simplifies updating the weg settings by handling
 * the nested structure automatically.
 *
 * @example
 * patchWegConfig({ enabled: true, margin: 10 });
 */
export function patchWegConfig(patch: Partial<SeelenWegSettings>, monitorId?: string) {
  if (monitorId) {
    patchWidgetMonitorConfig(monitorId, "@seelen/weg" as WidgetId, patch);
  } else {
    patchWidgetConfig("@seelen/weg" as WidgetId, patch);
  }
}

/**
 * Gets the current SeelenWeg configuration
 */
export function getWegConfig(monitorId?: string): SeelenWegSettings {
  return {
    ...settings.value.byWidget["@seelen/weg"],
    ...(monitorId ? settings.value.monitorsV3[monitorId]?.byWidget["@seelen/weg" as WidgetId] : {}),
  } as SeelenWegSettings;
}

/**
 * Imports pinned items from Windows taskbar
 */
export async function importFromWindowsTaskbar(): Promise<number> {
  return await invoke(SeelenCommand.WegImportPinnedTaskbarItems);
}
