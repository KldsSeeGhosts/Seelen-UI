<script lang="ts">
  import { invoke, SeelenCommand, Widget } from "@seelen-ui/lib";
  import type { WidgetId } from "@seelen-ui/lib/types";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import RadioButtons from "./components/RadioButtons.svelte";
  import BrightnessControl from "./components/BrightnessControl.svelte";
  import MediaDevices from "./components/MediaDevices.svelte";
  import { state } from "./state.svelte";
  import { t } from "./i18n";

  function openAppSettings() {
    invoke(SeelenCommand.TriggerWidget, {
      payload: { id: "@seelen/settings" as WidgetId },
    });
  }

  function openPowerMenu() {
    invoke(SeelenCommand.TriggerWidget, {
      payload: { id: "@seelen/power-menu" as WidgetId },
    });
  }

  $effect(() => {
    Widget.getCurrent().ready();
  });
</script>

<div class={["slu-std-popover", "quick-settings"]}>
  <RadioButtons />

  {#if state.monitorsStatus === "ready"}
    <BrightnessControl />
  {:else}
    <section class="quick-settings-module" aria-busy={state.monitorsStatus === "loading"}>
      <span class="quick-settings-module-title">{$t("display")}</span>
      <span class="quick-settings-label">
        {$t(state.monitorsStatus === "loading" ? "loading" : "load_failed")}
      </span>
      {#if state.monitorsStatus === "error"}
        <button data-skin="default" onclick={() => state.retryMonitors()}>{$t("retry")}</button>
      {/if}
    </section>
  {/if}

  {#if state.mediaDevicesStatus === "ready"}
    <MediaDevices />
  {:else}
    <section class="quick-settings-module" aria-busy={state.mediaDevicesStatus === "loading"}>
      <span class="quick-settings-module-title">{$t("sound")}</span>
      <span class="quick-settings-label">
        {$t(state.mediaDevicesStatus === "loading" ? "loading" : "load_failed")}
      </span>
      {#if state.mediaDevicesStatus === "error"}
        <button data-skin="default" onclick={() => state.retryMediaDevices()}>{$t("retry")}</button>
      {/if}
    </section>
  {/if}

  <div class="quick-settings-footer">
    <button data-skin="transparent" onclick={openAppSettings} title={$t("app_settings")}>
      <Icon iconName="RiSettings4Fill" />
    </button>

    <button data-skin="transparent" onclick={openPowerMenu} title={$t("power")}>
      <Icon iconName="IoPower" />
    </button>
  </div>
</div>
