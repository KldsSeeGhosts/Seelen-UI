import { SeelenCommand, SeelenEvent, subscribe, type UnSubscriber } from "../../handlers/mod.ts";

import type { GenericWidgetSettings, Settings as ISettings } from "@seelen-ui/types";
import { newFromInvoke } from "../../utils/State.ts";
import { invoke } from "../../handlers/mod.ts";
import { Widget } from "../widget/mod.ts";

// Share startup bursts without making later reads indefinitely stale after a missed event.
const SNAPSHOT_MAX_AGE_MS = 1000;

let snapshot: ISettings | undefined;
let snapshotAt = -Infinity;
let snapshotRevision = 0;
let pendingSnapshot: Promise<ISettings> | undefined;
let subscription: Promise<UnSubscriber> | undefined;
const listeners = new Set<(settings: Settings) => void>();

function ensureSubscription(): Promise<UnSubscriber> {
  subscription ??= subscribe(SeelenEvent.StateSettingsChanged, ({ payload }) => {
    snapshot = structuredClone(payload);
    snapshotAt = performance.now();
    snapshotRevision += 1;
    for (const listener of listeners) {
      try {
        listener(new Settings(structuredClone(payload)));
      } catch (error) {
        console.error("Settings listener failed:", error);
      }
    }
  }).catch((error) => {
    subscription = undefined;
    throw error;
  });
  return subscription;
}

async function getSnapshot(): Promise<ISettings> {
  await ensureSubscription();
  if (snapshot && performance.now() - snapshotAt < SNAPSHOT_MAX_AGE_MS) {
    return snapshot;
  }
  if (!pendingSnapshot) {
    const revision = snapshotRevision;
    pendingSnapshot = invoke(SeelenCommand.StateGetSettings, { path: null }).then((initial) => {
      // A settings event received during the fetch is newer than its response.
      if (snapshotRevision === revision) {
        snapshot = structuredClone(initial);
        snapshotAt = performance.now();
      }
      return snapshot ?? initial;
    }).finally(() => {
      pendingSnapshot = undefined;
    });
  }
  return pendingSnapshot;
}

export interface Settings extends ISettings {}
export class Settings {
  constructor(public inner: ISettings) {
    Object.assign(this, this.inner);
  }

  static default(): Promise<Settings> {
    return newFromInvoke(this, SeelenCommand.StateGetDefaultSettings);
  }

  static async getAsync(): Promise<Settings> {
    // Settings consumers may edit their copy before saving it.
    return new Settings(structuredClone(await getSnapshot()));
  }

  static async onChange(cb: (payload: Settings) => void): Promise<UnSubscriber> {
    listeners.add(cb);
    try {
      await ensureSubscription();
    } catch (error) {
      listeners.delete(cb);
      throw error;
    }
    return () => {
      listeners.delete(cb);
    };
  }

  static loadCustom(path: string): Promise<Settings> {
    return newFromInvoke(this, SeelenCommand.StateGetSettings, { path });
  }

  /**
   * Returns the settings for the current widget, taking in care of the replicas
   * the returned object will be a merge of:
   * - the default settings set on the widget definition
   * - the stored user settings
   * - the instance patch settings (if apply)
   * - the monitor patch settings (if apply)
   */
  getCurrentWidgetConfig(): GenericWidgetSettings {
    const currentWidget = Widget.getCurrent();

    const widgetId = currentWidget.id;
    const { monitorId, instanceId } = currentWidget.decoded;

    const root = this.inner.byWidget[widgetId];
    const instance = instanceId ? root?.$instances?.[instanceId] : undefined;
    const monitor = monitorId ? this.inner.monitorsV3[monitorId]?.byWidget[widgetId] : undefined;

    return {
      ...currentWidget.getDefaultConfig(),
      ...(root || {}),
      ...(instance || {}),
      ...(monitor || {}),
    };
  }

  /** Will store the settings on disk */
  save(): Promise<void> {
    return invoke(SeelenCommand.StateWriteSettings, { settings: this.inner });
  }
}
