<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { HotspotState, RadioDeviceKind, type RadioDevice } from "@seelen-ui/lib/types";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { state, type SectionStatus } from "../state.svelte";
  import type { IconName } from "libs/ui/icons";
  import { t } from "../i18n";

  const hdrMonitors = $derived(state.monitors.filter((m) => m.hdr !== null && m.hdr !== undefined));
  const hdrEnabled = $derived(hdrMonitors.length > 0 && hdrMonitors.every((m) => m.hdr));

  const darkModeStatus = $derived(state.darkModeStatus);
  const nightLightStatus = $derived(state.nightLightStatus);
  const darkModePending = $derived(state.isActionPending("dark-mode"));
  const nightLightPending = $derived(state.isActionPending("night-light"));

  function radioActionKey(radio: RadioDevice): string {
    return `radio:${radio.id}`;
  }

  function getRadioIcon(kind: RadioDeviceKind): IconName {
    switch (kind) {
      case RadioDeviceKind.WiFi:
        return "IoWifiSharp";
      case RadioDeviceKind.Bluetooth:
        return "IoBluetooth";
      case RadioDeviceKind.MobileBroadband:
        return "IoPhonePortraitSharp";
      case RadioDeviceKind.FM:
        return "IoRadio";
      case RadioDeviceKind.Other:
        return "IoRadioButtonOnSharp";
    }
  }

  function getRadioLabel(kind: RadioDeviceKind): string {
    switch (kind) {
      case "WiFi":
        return "Wi-Fi";
      case "Bluetooth":
        return "Bluetooth";
      case "MobileBroadband":
        return $t("mobile_broadband");
      case "FM":
        return $t("fm_radio");
      default:
        return $t("unknown");
    }
  }

  function statusLabel(status: SectionStatus, active: boolean): string {
    switch (status) {
      case "loading":
        return $t("loading");
      case "error":
        return $t("unavailable");
      case "ready":
        return active ? $t("enabled") : $t("disabled");
    }
  }

  function toggleRadio(radio: RadioDevice) {
    const enabled = !radio.isEnabled;
    void state.runAction(
      radioActionKey(radio),
      () => invoke(SeelenCommand.SetRadioState, { kind: radio.kind, enabled }),
      () => state.refreshRadios(),
    );
  }

  function toggleHotspot() {
    const hotspot = state.hotspot;
    if (!hotspot) return;
    const enabled = hotspot.state !== HotspotState.on;
    void state.runAction(
      "hotspot",
      () => invoke(SeelenCommand.SetNetworkHotspotState, { enabled }),
      () => state.refreshHotspot(),
    );
  }

  function toggleHdr() {
    const enabled = !hdrEnabled;
    const monitorIds = hdrMonitors.map((monitor) => monitor.id);
    void state.runAction(
      "hdr",
      () =>
        Promise.all(monitorIds.map((id) => invoke(SeelenCommand.SetMonitorHdr, { id, state: enabled }))),
      () => state.refreshMonitors(),
    );
  }

  function toggleDarkMode() {
    if (darkModeStatus !== "ready") return;
    const enabled = !state.darkMode;
    void state.runAction(
      "dark-mode",
      () => invoke(SeelenCommand.SystemSetDarkMode, { enabled }),
      () => state.refreshDarkMode(),
    );
  }

  function toggleNightLight() {
    if (nightLightStatus !== "ready") return;
    const enabled = !state.nightLightEnabled;
    void state.runAction(
      "night-light",
      async () => {
        await invoke(SeelenCommand.SystemSetNightLightEnabled, { enabled });
        state.nightLightEnabled = enabled;
      },
      () => state.refreshNightLight(),
    );
  }
</script>

<div class="radio-buttons-container">
  {#each state.radios as radio (radio.id)}
    <button
      class="radio-button"
      data-active={radio.isEnabled}
      disabled={state.isActionPending(radioActionKey(radio))}
      aria-busy={state.isActionPending(radioActionKey(radio))}
      onclick={() => toggleRadio(radio)}
      title={`${radio.name} - ${radio.isEnabled ? $t("enabled") : $t("disabled")}`}
    >
      <span class="radio-button-icon">
        <Icon iconName={getRadioIcon(radio.kind)} />
      </span>
      <span class="radio-button-text">
        <span class="radio-button-label">{getRadioLabel(radio.kind)}</span>
        <span class="radio-button-state">{radio.isEnabled ? $t("enabled") : $t("disabled")}</span>
      </span>
    </button>
  {/each}

  {#if state.hotspot}
    <button
      class="radio-button"
      data-active={state.hotspot.state === HotspotState.on}
      disabled={state.hotspot.state === HotspotState.inTransition ||
        state.isActionPending("hotspot")}
      aria-busy={state.isActionPending("hotspot")}
      onclick={toggleHotspot}
      title={`${$t("hotspot")} - ${state.hotspot.state === HotspotState.on ? $t("enabled") : $t("disabled")}`}
    >
      <span class="radio-button-icon">
        <Icon iconName="MdWifiTethering" />
      </span>
      <span class="radio-button-text">
        <span class="radio-button-label">{$t("hotspot")}</span>
        <span class="radio-button-state">
          {state.hotspot.state === HotspotState.on ? $t("enabled") : $t("disabled")}
        </span>
      </span>
    </button>
  {/if}

  {#if hdrMonitors.length > 0}
    <button
      class="radio-button"
      data-active={hdrEnabled}
      disabled={state.isActionPending("hdr")}
      aria-busy={state.isActionPending("hdr")}
      onclick={toggleHdr}
      title={`${$t("hdr")} -${hdrEnabled ? $t("enabled") : $t("disabled")}`}
    >
      <span class="radio-button-icon">
        <Icon iconName="TbHdr" />
      </span>
      <span class="radio-button-text">
        <span class="radio-button-label">{$t("hdr")}</span>
        <span class="radio-button-state">{hdrEnabled ? $t("enabled") : $t("disabled")}</span>
      </span>
    </button>
  {/if}

  <button
    class="radio-button"
    data-active={darkModeStatus === "ready" && state.darkMode}
    disabled={darkModeStatus !== "ready" || darkModePending}
    aria-busy={darkModePending}
    onclick={toggleDarkMode}
    title={`${$t("dark_mode")} - ${statusLabel(darkModeStatus, state.darkMode)}`}
  >
    <span class="radio-button-icon">
      <Icon iconName="IoMoon" />
    </span>
    <span class="radio-button-text">
      <span class="radio-button-label">{$t("dark_mode")}</span>
      <span class="radio-button-state">{statusLabel(darkModeStatus, state.darkMode)}</span>
    </span>
  </button>

  <button
    class="radio-button"
    data-active={nightLightStatus === "ready" && state.nightLightEnabled}
    disabled={nightLightStatus !== "ready" || nightLightPending}
    aria-busy={nightLightPending}
    onclick={toggleNightLight}
    title={`${$t("night_light")} - ${statusLabel(nightLightStatus, state.nightLightEnabled)}`}
  >
    <span class="radio-button-icon">
      <Icon iconName="IoEye" />
    </span>
    <span class="radio-button-text">
      <span class="radio-button-label">{$t("eye_care")}</span>
      <span class="radio-button-state">
        {statusLabel(nightLightStatus, state.nightLightEnabled)}
      </span>
    </span>
  </button>

  {#if state.radioControlsFailed}
    <button
      class="radio-button"
      onclick={() => state.retryRadioControls()}
      title={$t("retry")}
      aria-label={$t("retry")}
    >
      <span class="radio-button-icon">
        <Icon iconName="TbRefresh" />
      </span>
      <span class="radio-button-text">
        <span class="radio-button-label">{$t("retry")}</span>
        <span class="radio-button-state">{$t("load_failed")}</span>
      </span>
    </button>
  {/if}

  {#if state.hasActionFailed()}
    <p class="radio-buttons-error quick-settings-label" role="status">
      {$t("change_failed")}
    </p>
  {/if}
</div>

<style>
  /* spans both grid columns under the controls instead of taking a single cell */
  .radio-buttons-error {
    grid-column: 1 / -1;
  }
</style>
