<script lang="ts">
  import { globalState } from "./state.svelte";
  import { invoke, SeelenCommand } from "@seelen-ui/lib";
  import Icon from "libs/ui/svelte/components/Icon/Icon.svelte";
  import { t } from "./i18n";
  import BluetoothDevice from "./components/BluetoothDevice.svelte";
  import { Widget } from "@seelen-ui/lib";
  import { dedupeBluetoothDevices } from "libs/ui/svelte/utils/bluetoothIcons.ts";

  const uniqueDevices = $derived(dedupeBluetoothDevices(globalState.devices));

  const connectedDevices = $derived(uniqueDevices.filter((d) => d.paired && d.connected));
  const pairedDevices = $derived(uniqueDevices.filter((d) => d.paired && !d.connected));
  const availableDevices = $derived(uniqueDevices.filter((d) => !d.paired));

  const bluetoothRadio = $derived(globalState.bluetoothRadio);
  const radioBusy = $derived(
    globalState.radiosStatus === "loading" || globalState.bluetoothRadioPending,
  );

  function openBluetoothSettings() {
    invoke(SeelenCommand.OpenFile, { path: "ms-settings:bluetooth" }).catch((error) => {
      console.error("bluetooth-popup: failed to open the Bluetooth settings", error);
    });
  }

  $effect(() => {
    Widget.getCurrent().ready();
  });
</script>

<div class="slu-std-popover bluetooth-popup">
  {#if globalState.radiosStatus === "loading"}
    <div class="bluetooth-no-adapter" aria-busy="true">{$t("loading")}</div>
  {:else if globalState.radiosStatus === "error"}
    <div class="bluetooth-no-adapter">{$t("load_failed")}</div>
    <div class="bluetooth-footer">
      <button data-skin="default" onclick={() => globalState.retryRadios()}>
        {$t("retry")}
      </button>
    </div>
  {:else if !bluetoothRadio}
    <div class="bluetooth-no-adapter">
      {$t("no_adapter")}
    </div>
  {:else}
    <div class="bluetooth-radio-control" aria-busy={radioBusy}>
      <div class="bluetooth-radio-label">
        <Icon iconName="IoBluetooth" />
        <span>Bluetooth</span>
      </div>
      <label class="bluetooth-radio-switch">
        <input
          type="checkbox"
          data-skin="switch"
          checked={bluetoothRadio.isEnabled}
          disabled={radioBusy}
          onchange={(event) => {
            event.currentTarget.checked = bluetoothRadio.isEnabled;
            globalState.toggleBluetoothRadio();
          }}
        />
      </label>
    </div>
  {/if}
  {#if globalState.actionFailed}
    <div role="status">{$t("change_failed")}</div>
  {/if}

  {#if bluetoothRadio?.isEnabled}
    {#if globalState.devicesStatus === "loading"}
      <div class="bt-list">
        <div class="bt-list-title">
          <span>{$t("available")}</span>
        </div>
        <div class="bt-list-devices">
          <div class="bluetooth-empty" aria-busy="true">{$t("loading")}</div>
        </div>
      </div>
    {:else if globalState.devicesStatus === "error"}
      <div class="bt-list">
        <div class="bt-list-title">
          <span>{$t("available")}</span>
        </div>
        <div class="bt-list-devices">
          <div class="bluetooth-empty">{$t("load_failed")}</div>
          <button data-skin="default" onclick={() => globalState.retryDevices()}>
            {$t("retry")}
          </button>
        </div>
      </div>
    {:else}
      {#if connectedDevices.length > 0}
        <div class="bt-list">
          <div class="bt-list-title">{$t("connected")}</div>
          <div class="bt-list-devices">
            {#each connectedDevices as device (device.id)}
              <BluetoothDevice {device} />
            {/each}
          </div>
        </div>
      {/if}

      {#if pairedDevices.length > 0}
        <div class="bt-list">
          <div class="bt-list-title">{$t("paired")}</div>
          <div class="bt-list-devices">
            {#each pairedDevices as device (device.id)}
              <BluetoothDevice {device} />
            {/each}
          </div>
        </div>
      {/if}

      <div class="bt-list">
        <div class="bt-list-title">
          <span>{$t("available")}</span>
          {#if globalState.scanPhase === "scanning"}
            <div class="bluetooth-scanning">
              <Icon iconName="TbRefresh" />
            </div>
          {/if}
        </div>
        <div class="bt-list-devices">
          {#if globalState.scanPhase === "error"}
            <div class="bluetooth-empty">{$t("scan_failed")}</div>
            <button data-skin="default" onclick={() => globalState.retryScan()}>
              {$t("retry")}
            </button>
          {/if}

          {#if availableDevices.length > 0}
            {#each availableDevices as device (device.id)}
              <BluetoothDevice {device} />
            {/each}
          {:else if globalState.scanPhase === "scanning"}
            <div class="bluetooth-empty">{$t("scanning")}</div>
          {:else if globalState.scanPhase !== "error"}
            <div class="bluetooth-empty">{$t("not_found")}</div>
          {/if}
        </div>
      </div>
    {/if}

    {#if bluetoothRadio?.isEnabled}
      <div class="bluetooth-footer">
        <button data-skin="transparent" onclick={openBluetoothSettings}>
          {$t("more")}
        </button>
      </div>
    {/if}
  {/if}
</div>
