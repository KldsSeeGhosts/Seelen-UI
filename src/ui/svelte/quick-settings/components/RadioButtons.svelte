<script lang="ts">
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import { HotspotState, RadioDeviceKind, type RadioDevice } from "@seelen-ui/lib/types";
  import { Icon } from "libs/ui/svelte/components/Icon";
  import { state } from "../state.svelte";
  import type { IconName } from "libs/ui/icons";
  import { t } from "../i18n";

  const hdrMonitors = $derived(state.monitors.filter((m) => m.hdr !== null && m.hdr !== undefined));
  const hdrEnabled = $derived(hdrMonitors.length > 0 && hdrMonitors.every((m) => m.hdr));

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

  async function toggleRadio(radio: RadioDevice) {
    await invoke(SeelenCommand.SetRadioState, {
      kind: radio.kind,
      enabled: !radio.isEnabled,
    });
  }

  async function toggleHotspot() {
    if (!state.hotspot) return;
    await invoke(SeelenCommand.SetNetworkHotspotState, {
      enabled: state.hotspot.state !== HotspotState.on,
    });
  }

  async function toggleHdr() {
    const newState = !hdrEnabled;
    await Promise.all(
      hdrMonitors.map((monitor) =>
        invoke(SeelenCommand.SetMonitorHdr, { id: monitor.id, state: newState }),
      ),
    );
  }

  async function toggleDarkMode() {
    await invoke(SeelenCommand.SystemSetDarkMode, { enabled: !state.darkMode });
  }

  async function toggleNightLight() {
    const enabled = !state.nightLightEnabled;
    invoke(SeelenCommand.SystemSetNightLightEnabled, { enabled }).then(() => {
      state.nightLightEnabled = enabled;
    });
  }
</script>

<div class="radio-buttons-container">
  {#each state.radios as radio (radio.id)}
    <button
      class="radio-button"
      data-active={radio.isEnabled}
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
      disabled={state.hotspot.state === HotspotState.inTransition}
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

  <button class="radio-button" data-active={state.darkMode} onclick={toggleDarkMode}>
    <span class="radio-button-icon">
      <Icon iconName="IoMoon" />
    </span>
    <span class="radio-button-text">
      <span class="radio-button-label">{$t("dark_mode")}</span>
      <span class="radio-button-state">{state.darkMode ? $t("enabled") : $t("disabled")}</span>
    </span>
  </button>

  <button
    class="radio-button"
    data-active={state.nightLightEnabled}
    onclick={toggleNightLight}
    title={`${$t("night_light")} - ${state.nightLightEnabled ? $t("enabled") : $t("disabled")}`}
  >
    <span class="radio-button-icon">
      <Icon iconName="IoEye" />
    </span>
    <span class="radio-button-text">
      <span class="radio-button-label">{$t("eye_care")}</span>
      <span class="radio-button-state">
        {state.nightLightEnabled ? $t("enabled") : $t("disabled")}
      </span>
    </span>
  </button>
</div>
